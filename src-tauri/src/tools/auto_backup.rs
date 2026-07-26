/* =============================================================================
   AUTO-BACKUP  — Robocopy-based folder mirroring
   -----------------------------------------------------------------------------
   Tauri commands for the Auto-Backup tool. All heavy lifting (the Robocopy
   subprocess and live progress streaming) runs on a dedicated OS thread so the
   Tauri IPC thread pool is never blocked.

   Architecture:
     • run_backup()            — command entry point; resets cancel flag, spawns thread
     • run_backup_thread()     — orchestrates preflight, then the real run
     • run_destination()       — one destination's full source loop; destinations
                                   are called one after another (SEQUENTIALLY)
     • parse_robocopy_*        — helpers for parsing Robocopy stdout line-by-line

   Logging: each destination gets its own robocopy_log_<timestamp>.txt, written
   inside that destination's own folder and containing only the output for
   copies made into it (sources × that one destination). This keeps a backup
   run with multiple destinations from dumping every destination's log into
   whichever destination happened to be first.

   EXECUTION MODEL (Phase 2 — the real run)
   -----------------------------------------
   Destinations are mirrored SEQUENTIALLY: destination 1 fully completes (all
   its source folders) before destination 2 begins, and so on. Within a
   destination, its source folders are likewise done one after another. This
   is the simple, predictable model — one robocopy process at a time — chosen
   over running destinations at once because concurrency's speed benefit was
   inconsistent (it depends entirely on whether the destinations sit on truly
   independent hardware paths, which the app can't know) and it introduced a
   whole class of hazards: two /MIR passes racing on overlapping folders, the
   SOURCE disk being read once per destination simultaneously (seek thrashing
   on an HDD source), and interleaved progress events fighting over shared UI.
   Sequential execution has none of those failure modes by construction.

   Ordering/cancel: destinations run in list order. A cancel requested between
   destinations stops before the next one starts; a cancel DURING a
   destination is caught in its copy loop, which returns a cancelled result
   and ends the whole run. If a destination hits a fatal (exit code >= 16)
   error it fails that destination but the run still reports per-destination
   results in the backup-complete summary.

   State: CANCEL_REQUESTED (checked between destinations and inside each copy
   loop) and ACTIVE_ROBOCOPY_PIDS (holds the single currently-running child's
   pid so cancel_backup can kill it). Per-run totals (files/dirs/bytes/extras)
   are accumulated across destinations via the live_*_g counters, which — with
   only one destination ever running at a time — simply tally run-wide totals
   in call order.

   Event names emitted to the frontend:
     backup-plan-progress     — during the preflight pass, once per folder pair
     backup-plan-done         — preflight finished: exact bytes/files to copy
     backup-folder-start      — before each source×dest folder pair begins
     backup-file-progress     — per copied file (carries dest_index + that
                                 destination's own running byte total alongside
                                 the run-wide totals)
     backup-folder-done       — after each folder pair completes
     backup-destination-done  — fires once a destination finishes (success,
                                 failure, or cancel), so that destination's row
                                 can go green/red as soon as it completes
     backup-complete          — once every destination has run (success only if
                                 every destination succeeded)

   Progress model (the "smooth bar" contract with the frontend):
     A backup run has two phases, mirroring what Windows Explorer does.
     Phase 1 is a PREFLIGHT: every folder pair is run through robocopy /L
     (list-only — a directory walk, no data read or written) with the same
     selection flags as the real run, so robocopy itself tells us exactly
     which files WOULD be copied and their exact byte sizes (/BYTES). The
     summed result is the run's true workload — for an incremental /MIR run
     this is the DELTA, not the source size, which is what makes the bar
     honest on recurring backups. Phase 2 is the real run, whose per-file
     events report completed bytes against that plan. Both phases run
     sequentially.

   File I/O uses crate::get_data_path() from lib.rs — the dev/release directory
   logic lives in exactly one place.

   Rust commands exposed:
     save_backup_config, load_backup_config,
     save_backup_presets, load_backup_presets,
     get_folder_stats, get_free_space,
     cancel_backup, run_backup
============================================================================= */

use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/* =============================================================================
   PAYLOAD TYPES
============================================================================= */

#[derive(Clone, serde::Serialize)]
pub struct BackupFolderEvent {
    pub source: String,
    pub destination: String,
    pub source_index: usize,
    pub source_total: usize,
    pub dest_index: usize,
    pub dest_total: usize,
}

#[derive(Clone, serde::Serialize)]
pub struct BackupFolderDoneEvent {
    pub source: String,
    pub destination: String,
    pub files_copied: u64,
    pub dirs_copied: u64,
    pub bytes_copied: u64,
    pub elapsed_secs: f64,
    /// Which destination (by index into the run's destination list) this
    /// folder pair belongs to — lets the frontend update that destination's
    /// own row/bar now that destinations complete folders concurrently.
    pub dest_index: usize,
    /// How many source*dest folder pairs have now completed (1-based).
    pub folders_done: usize,
    /// Total number of source*dest folder pairs in this run.
    pub folders_total: usize,
}

/// One file that robocopy attempted to copy but could not — because it was
/// locked/in use, or some other access error — even after its retries ran
/// out. This is NEVER a file robocopy simply decided not to touch because the
/// source and destination already matched; unchanged files never produce an
/// output line at all in the mode this app runs robocopy in, so there's
/// nothing to mistakenly flag here.
#[derive(Clone, serde::Serialize)]
pub struct SkippedFileEntry {
    pub source: String,
    pub destination: String,
}

#[derive(Clone, serde::Serialize)]
pub struct BackupCompleteEvent {
    pub success: bool,
    pub message: String,
    /// One robocopy summary log per destination, written inside that
    /// destination's own folder (rather than a single shared log file).
    pub log_paths: Vec<String>,
    pub total_files: u64,
    pub total_dirs: u64,
    pub total_bytes: u64,
    /// Destination-side files/dirs deleted by /MIR across the run (or up to
    /// the point of cancellation) — mirrors the Summary panel's "Stale Items
    /// to Remove" so the Last Run panel can report what actually happened.
    pub total_extras: u64,
    pub total_secs: f64,
    /// On a mid-file cancellation, the file that was interrupted (and whose
    /// partial destination copy was removed — see cancel_backup). None on a
    /// clean completion or a cancel that landed exactly between files.
    pub aborted_file: Option<String>,
    /// Every file that failed to copy (locked/access error) across every
    /// destination in this run — feeds the "View Skipped Files" modal.
    pub skipped_files: Vec<SkippedFileEntry>,
    /// One robocopy_log_<timestamp>_SKIPPED_FILES.txt per destination that
    /// actually had at least one skip — only created when needed.
    pub skipped_log_paths: Vec<String>,
}

/// Emitted for each file robocopy copies, so the frontend can show live progress.
///
/// Byte semantics: robocopy prints a file's line when it STARTS copying it, so
/// a file's bytes are only added to `bytes_done` once the NEXT line proves it
/// finished. The in-flight file's size travels separately in
/// `current_file_bytes`, letting the frontend animate through large files at
/// the measured throughput instead of jumping early and stalling.
#[derive(Clone, serde::Serialize)]
pub struct BackupFileProgressEvent {
    /// Bytes of COMPLETED files so far across all folders in this run
    /// (excludes the file currently being copied). RUN-WIDE — sums every
    /// destination's progress, since multiple destinations now copy at once.
    pub bytes_done: u64,
    /// Running total of files started so far, run-wide. Includes the current file.
    pub files_done: u64,
    /// Running total of dirs copied so far, run-wide.
    pub dirs_done: u64,
    /// The full path of the file currently being copied.
    pub current_file: String,
    /// Size in bytes of the file currently being copied.
    pub current_file_bytes: u64,
    /// Per-file copy percentage from /Z output (0-100), or None when not available.
    pub file_pct: Option<u8>,
    /// Which destination (by index into the run's destination list) this file
    /// belongs to — lets the frontend route the event to that destination's
    /// own progress bar as well as the shared overall bar.
    pub dest_index: usize,
    /// Bytes of completed files so far WITHIN THIS DESTINATION ONLY (excludes
    /// the in-flight file, same semantics as bytes_done but scoped to one
    /// destination) — the numerator for that destination's own bar.
    pub dest_bytes_done: u64,
}

/// Emitted once per folder pair during the preflight (list-only) pass.
#[derive(Clone, serde::Serialize)]
pub struct BackupPlanProgressEvent {
    pub pair_index: usize,
    pub pairs_total: usize,
    pub source: String,
}

/// One folder pair's slice of the preflight plan, in the exact order the
/// real run will process pairs (destination-major, matching the run loops).
#[derive(Clone, serde::Serialize)]
pub struct PlanPair {
    pub source: String,
    pub destination: String,
    /// Exact bytes the run will copy for this pair.
    pub bytes: u64,
    /// Exact files the run will copy for this pair.
    pub files: u64,
}

/// Emitted when the preflight pass completes: the exact workload of this run.
#[derive(Clone, serde::Serialize)]
pub struct BackupPlanDoneEvent {
    /// Exact bytes robocopy will copy (the delta, not the source size).
    pub bytes_to_copy: u64,
    /// Exact number of files robocopy will copy.
    pub files_to_copy: u64,
    /// Number of extra files/dirs that will be DELETED from destinations (/MIR).
    pub extras_to_delete: u64,
    /// Per-pair breakdown, in run order — lets the frontend weight the
    /// progress bar by each pair's total work (copying AND scanning).
    pub per_pair: Vec<PlanPair>,
}

/// Emitted once a single destination's own thread finishes — success,
/// failure, or cancellation — independent of how the other destinations in
/// this run are doing. Lets the frontend mark that destination's row/bar as
/// done immediately rather than waiting for the whole (possibly
/// multi-destination) run to finish.
#[derive(Clone, serde::Serialize)]
pub struct BackupDestinationDoneEvent {
    pub dest_index: usize,
    pub destination: String,
    pub success: bool,
    pub cancelled: bool,
    pub message: String,
    /// None if this destination never got as far as creating its log file
    /// (e.g. create_dir_all failed immediately).
    pub log_path: Option<String>,
    pub files_copied: u64,
    pub dirs_copied: u64,
    pub bytes_copied: u64,
    pub extras_deleted: u64,
    pub elapsed_secs: f64,
    pub aborted_file: Option<String>,
    /// Files this destination couldn't copy (locked/access error) — the
    /// destination still completed; these files were skipped, not aborted.
    pub skipped_files: Vec<SkippedFileEntry>,
    /// Path of this destination's own SKIPPED_FILES log, if any skips happened.
    pub skipped_log_path: Option<String>,
}

/* =============================================================================
   CANCEL FLAG
============================================================================= */

static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

/// True while a backup thread is alive. The frontend disables the Run button
/// during a run, but the backend must be self-defending too: two concurrent
/// runs would share one cancel flag and interleave robocopy trees.
static BACKUP_RUNNING: AtomicBool = AtomicBool::new(false);

/// PIDs of the robocopy children CURRENTLY copying — one entry per destination
/// that's mid-copy right now, since destinations run concurrently. Lets
/// cancel_backup kill every active child DIRECTLY instead of waiting for
/// output: robocopy prints nothing while it's deep inside one huge file, so a
/// flag alone can leave "Cancel" unresponsive for however long that file takes.
static ACTIVE_ROBOCOPY_PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Monotonic generation counter for estimate scans. Every new estimate (and
/// every explicit cancel) bumps it; a running estimate whose remembered
/// generation no longer matches aborts at its next check — killing the old
/// robocopy /L child instead of letting it burn disk for a result nobody
/// will read. Bump-to-cancel is race-free by construction: whichever call
/// bumps LAST is the only one whose generation survives.
static ESTIMATE_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Aborts any estimate scan currently in flight (without starting a new one).
/// Called by the frontend the moment sources/destinations change, and when a
/// backup launches.
#[tauri::command]
pub fn cancel_estimate() {
    ESTIMATE_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/* =============================================================================
   PATH SAFETY VALIDATION
   -----------------------------------------------------------------------------
   /MIR is a loaded gun: it DELETES anything in the destination subtree that
   isn't in the source. Three configurations turn that from "mirror" into
   "destroy data", and all are cheap to detect up front:

     1. A destination inside a source — robocopy recurses into its own output.
     2. A computed destination subfolder (destination\<leaf>) that overlaps a
        source — mirroring a folder onto itself or onto its own ancestor.
     3. Two sources sharing the same leaf folder name — both map to the SAME
        destination subfolder, so the second /MIR pass deletes everything the
        first one just copied.
============================================================================= */

/// Lowercased, backslash-normalized, no trailing separator — good enough for
/// prefix comparisons on Windows paths (which are case-insensitive).
fn normalize_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// True if the two normalized paths are the same folder or one contains the other.
fn paths_overlap(a: &str, b: &str) -> bool {
    a == b
        || a.starts_with(&format!("{}\\", b))
        || b.starts_with(&format!("{}\\", a))
}

/// Validates a run's source/destination sets. Returns a human-readable error
/// describing the first unsafe pairing found, or Ok(()) if the run is safe.
fn validate_backup_paths(sources: &[String], destinations: &[String]) -> Result<(), String> {
    // Leaf-name collisions between sources.
    let mut seen_leaves: std::collections::HashMap<String, &String> = std::collections::HashMap::new();
    for src in sources {
        // Must mirror the folder_name computation in run_backup_thread exactly
        // (lowercased, since Windows paths are case-insensitive) — otherwise
        // the collision check and the actual on-disk naming could disagree.
        let leaf = std::path::Path::new(src)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| src.replace([':', '/', '\\'], "_").to_lowercase());
        if let Some(prev) = seen_leaves.insert(leaf.clone(), src) {
            return Err(format!(
                "Duplicate Folder Name error: two source folders share the name '{}' \
                 ('{}' and '{}'). They would mirror into the same destination subfolder \
                 and erase each other — rename one of them or back them up in separate runs.",
                leaf, prev, src
            ));
        }
    }

    for dest in destinations {
        let dest_norm = normalize_path(dest);
        for src in sources {
            let src_norm = normalize_path(src);

            if dest_norm == src_norm {
                return Err(format!(
                    "Same Path error: source and destination are the same: {}",
                    src
                ));
            }
            // Destination inside a source → robocopy recurses into its own output.
            if dest_norm.starts_with(&format!("{}\\", src_norm)) {
                return Err(format!(
                    "Destination Inside Source error: destination '{}' is inside source \
                     '{}' — the backup would copy into itself endlessly.",
                    dest, src
                ));
            }
            // The subfolder this source actually mirrors into.
            // Mirrors run_backup_thread's folder_name computation, lowercased.
            let leaf = std::path::Path::new(src)
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_else(|| src.replace([':', '/', '\\'], "_").to_lowercase());
            let dest_path_norm = format!("{}\\{}", dest_norm, leaf);
            if paths_overlap(&src_norm, &dest_path_norm) {
                return Err(format!(
                    "Self-Mirror error: backing up '{}' into '{}' would mirror the folder \
                     onto itself (or its own parent) and destroy it.",
                    src, dest
                ));
            }
        }
    }

    // Destination-vs-destination overlap. Two /MIR passes into overlapping
    // folders are dangerous even when they run one after another:
    //   • Exact duplicate → the second pass re-mirrors what the first just
    //     wrote, and both share one log file — pointless and confusing.
    //   • One destination nested inside another → the OUTER destination's
    //     /MIR treats the inner destination's folder as "extra" content that
    //     isn't in the source, and DELETES it — wiping a backup you just made.
    //     (Order doesn't save you: whichever runs second destroys or
    //     re-does the other's work.) The frontend only blocks exact-string
    //     duplicates, so "D:\Backup" vs "D:\Backup\" — or a nested subfolder —
    //     slips past it; this is the authoritative gate.
    for (i, a) in destinations.iter().enumerate() {
        let a_norm = normalize_path(a);
        for b in destinations.iter().skip(i + 1) {
            let b_norm = normalize_path(b);
            if a_norm == b_norm {
                return Err(format!(
                    "Duplicate Destination error: '{}' and '{}' are the same destination. \
                     List it only once.",
                    a, b
                ));
            }
            if paths_overlap(&a_norm, &b_norm) {
                return Err(format!(
                    "Nested Destination error: '{}' and '{}' overlap (one is inside the \
                     other). Mirroring into both would make the outer backup delete the \
                     inner one — remove one of them or back them up in separate runs.",
                    a, b
                ));
            }
        }
    }
    Ok(())
}

/* =============================================================================
   PERSISTENCE COMMANDS
============================================================================= */

/// Persists the backup config (sources, destinations, copy speed) to disk.
#[tauri::command]
pub fn save_backup_config(app: AppHandle, data: String) -> Result<(), String> {
    crate::atomic_write(&crate::get_data_path(&app, "auto-backup.json"), data.as_bytes())
}

/// Loads the backup config from disk. Returns sensible defaults if not found.
#[tauri::command]
pub fn load_backup_config(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(crate::get_data_path(&app, "auto-backup.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok(r#"{"sources":[],"destinations":[],"copySpeed":31457280}"#.to_string()),
    }
}

/// Persists the presets list to disk.
#[tauri::command]
pub fn save_backup_presets(app: AppHandle, data: String) -> Result<(), String> {
    crate::atomic_write(&crate::get_data_path(&app, "auto-backup-presets.json"), data.as_bytes())
}

/// Loads the presets list from disk. Returns an empty array if not found.
#[tauri::command]
pub fn load_backup_presets(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(crate::get_data_path(&app, "auto-backup-presets.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok("[]".to_string()),
    }
}

/* =============================================================================
   FOLDER STATS COMMAND  (files + dirs + bytes)
============================================================================= */

#[derive(serde::Serialize)]
pub struct FolderStats {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
}

/// Recursively walks a directory tree and returns total file count, dir count,
/// and byte size. Used by the frontend summary panel to show source folder stats.
///
/// Declared async and pushed onto a blocking-work thread: in Tauri v2, a
/// NON-async command runs on the MAIN thread — the same thread driving the
/// webview — so a long tree walk here would freeze the entire UI for its
/// duration. (run_backup dodges this by spawning its own thread; every other
/// potentially-slow command in this file must use this pattern instead.)
#[tauri::command]
pub async fn get_folder_stats(path: String) -> Result<FolderStats, String> {
    tauri::async_runtime::spawn_blocking(move || get_folder_stats_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_folder_stats_blocking(path: String) -> Result<FolderStats, String> {
    let root = std::path::Path::new(&path);
    if !root.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut files: u64 = 0;
    let mut dirs:  u64 = 0;
    let mut bytes: u64 = 0;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        match fs::read_dir(&dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let meta = match entry.metadata() {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    if meta.is_dir() {
                        dirs += 1;
                        stack.push(entry.path());
                    } else {
                        files += 1;
                        bytes += meta.len();
                    }
                }
            }
            Err(_) => continue,
        }
    }

    Ok(FolderStats { files, dirs, bytes })
}

/// Returns available free bytes on the drive containing `path`.
/// Extracts the drive letter directly from the path string without canonicalizing,
/// so it works even when the destination folder doesn't exist yet.
///
/// Primary method is a CIM query via PowerShell, which prints a bare byte
/// count with invariant-culture digits — it works identically on every
/// Windows display language. `fsutil volume diskfree` is kept only as a
/// fallback; its output labels ("Total free bytes") are localized, so the
/// text-matching parse below silently fails on non-English Windows.
/// Async + blocking-thread for the same reason as get_folder_stats — the
/// PowerShell/fsutil round-trip takes a few hundred milliseconds, which is a
/// visible UI hitch when run on the main thread.
#[tauri::command]
pub async fn get_free_space(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || get_free_space_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_free_space_blocking(path: String) -> Result<u64, String> {
    // Normalise slashes and grab the first character as the drive letter.
    // Works for "D:/Backup", "D:\Backup", "D:Backup", etc.
    let normalised = path.replace('\\', "/");
    if normalised.starts_with("//") {
        return Err("Free-space check isn't supported for network (UNC) paths.".to_string());
    }
    let drive_char = normalised
        .chars()
        .next()
        .ok_or_else(|| "Empty path".to_string())?
        .to_ascii_uppercase();
    // Strict validation before the letter is interpolated into a PowerShell
    // command string — anything that isn't a plain drive letter is rejected,
    // so no other character can ever reach the command line.
    if !drive_char.is_ascii_alphabetic() {
        return Err(format!(
            "Path must start with a drive letter (got '{}').",
            drive_char
        ));
    }

    // ── Primary: CIM query, locale-invariant numeric output ─────────────────
    let cim = std::process::Command::new(crate::powershell_exe())
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='{}:'\").FreeSpace",
                drive_char
            ),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    if let Ok(output) = cim {
        let text = String::from_utf8_lossy(&output.stdout);
        if let Ok(n) = text.trim().parse::<u64>() {
            return Ok(n);
        }
    }

    // ── Fallback: fsutil (English-locale output only) ────────────────────────
    let output = std::process::Command::new(crate::system32_exe("fsutil.exe"))
        .args(["volume", "diskfree", &format!("{}:", drive_char)])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run fsutil: {}", e))?;

    let text = String::from_utf8_lossy(&output.stdout);

    // fsutil output (English):
    //   Total free bytes                 :  123,456,789,012 (114 GB)
    // We look for the line containing "Total free bytes" (case-insensitive).
    for line in text.lines() {
        if line.to_lowercase().contains("total free bytes") {
            if let Some(colon_pos) = line.find(':') {
                let after_colon = line[colon_pos + 1..].trim();
                // Take the first whitespace-delimited token, strip commas.
                let digits: String = after_colon
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .filter(|c| c.is_ascii_digit() || *c == ',')
                    .collect::<String>()
                    .replace(',', "");
                if let Ok(n) = digits.parse::<u64>() {
                    return Ok(n);
                }
            }
        }
    }

    Err(format!(
        "Unable to determine free space for drive {}:",
        drive_char
    ))
}

/* =============================================================================
   CANCEL COMMAND
============================================================================= */

/// Cancels the running backup. Sets the flag (which every destination's
/// source loop and the preflight honor) AND force-kills EVERY currently
/// active robocopy child — one per destination still mid-copy, since
/// destinations run concurrently — so the stop is immediate even mid-file on
/// all of them at once. Each destination's own thread then removes its
/// half-copied destination file, leaving the backup clean: the interrupted
/// file is simply absent, and the next /MIR run copies it fresh.
#[tauri::command]
pub fn cancel_backup() {
    CANCEL_REQUESTED.store(true, Ordering::SeqCst);
    // Snapshot and clear under one short lock, then kill outside it — no
    // reason to hold the lock while spawning taskkill processes.
    let pids: Vec<u32> = ACTIVE_ROBOCOPY_PIDS.lock().unwrap().clone();
    for pid in pids {
        // Kill by PID, but ONLY if that PID is still a robocopy.exe. A bare
        // "/PID n /F" is racy: robocopy may have already exited and the OS
        // recycled its PID onto an unrelated process, which we'd then kill by
        // mistake. taskkill ANDs its /FI filters, so pairing the PID filter
        // with an IMAGENAME filter means a recycled PID that is no longer
        // robocopy simply matches nothing and nothing is killed. The copy
        // loop's own child.kill() stays the primary stop; this is the
        // immediate-kill path for when robocopy is deep inside one huge file
        // and printing nothing to drive the read loop.
        let _ = std::process::Command::new(crate::system32_exe("taskkill.exe"))
            .args([
                "/F",
                "/FI",
                &format!("PID eq {}", pid),
                "/FI",
                "IMAGENAME eq robocopy.exe",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
}

/// Maps an in-flight SOURCE file path (as printed by robocopy) to its
/// destination counterpart, for partial-file cleanup after a mid-copy kill.
/// Best-effort: returns None if the path doesn't sit under the source root
/// (e.g. lossy-decoded non-ASCII characters), in which case the partial file
/// is left for the next /MIR run to overwrite anyway.
fn partial_dest_of(source_file: &str, source_root: &str, dest_root: &str) -> Option<std::path::PathBuf> {
    let sf = source_file.replace('/', "\\");
    let sr = source_root.trim_end_matches(['\\', '/']).replace('/', "\\");
    if sf.len() > sr.len() && sf[..sr.len()].eq_ignore_ascii_case(&sr) {
        let rel = sf[sr.len()..].trim_start_matches('\\');
        if rel.is_empty() { return None; }
        Some(std::path::Path::new(dest_root).join(rel))
    } else {
        None
    }
}

/// Validates a source/destination configuration without running anything —
/// exposed so the frontend can refuse the Run button BEFORE showing the
/// confirmation modal, instead of letting the user click Proceed into an
/// immediate error. Pure string checks; effectively instant.
#[tauri::command]
pub fn validate_backup_config(sources: Vec<String>, destinations: Vec<String>) -> Result<(), String> {
    validate_backup_paths(&sources, &destinations)
}

/* =============================================================================
   RUN BACKUP COMMAND
============================================================================= */

#[tauri::command]
pub fn run_backup(
    app: AppHandle,
    sources: Vec<String>,
    destinations: Vec<String>,
    // When false ("fast" mode), robocopy's output is drained without live
    // per-line parsing, so robocopy never blocks waiting on us — the price is
    // no live "current file" text and a bar/stats that update per-folder
    // rather than per-file. When true ("details" mode), the live progress is
    // shown at the cost of throttling robocopy on small-file-heavy trees.
    show_details: bool,
) -> Result<(), String> {
    // Refuse unsafe source/destination combinations BEFORE any thread spawns
    // or any robocopy runs — /MIR deletes, so this must be a hard gate.
    validate_backup_paths(&sources, &destinations)?;

    // Refuse to start if a run is already in flight. swap() makes the
    // check-and-claim a single atomic step, so two simultaneous invokes can't
    // both slip through.
    if BACKUP_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A backup is already running.".to_string());
    }

    // Reset cancel flag before spawning.
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);

    // Spawn the entire backup onto a dedicated OS thread and return immediately.
    // The frontend drives completion via the "backup-complete" event rather than
    // the invoke return value, so fire-and-forget is the correct model here.
    // This keeps the Tauri IPC thread pool free for the duration of the backup,
    // preventing the UI from going unresponsive ("Not Responding") on large runs.
    std::thread::spawn(move || {
        run_backup_thread(app, sources, destinations, show_details);
        // run_backup_thread returns on every completion path (success, failure,
        // cancel), so clearing the flags here covers all of them. The cancel
        // flag MUST be cleared once it has served its purpose — preflight_pair
        // is also used by estimate_backup, and a stale true here would
        // instantly abort every estimate scan after a cancelled backup.
        CANCEL_REQUESTED.store(false, Ordering::SeqCst);
        BACKUP_RUNNING.store(false, Ordering::SeqCst);
    });

    Ok(())
}

/// Runs the full backup synchronously on its own OS thread.
/// Uses robocopy's per-file output lines to emit live progress events.
fn run_backup_thread(
    app: AppHandle,
    sources: Vec<String>,
    destinations: Vec<String>,
    show_details: bool,
) {
    let run_start    = std::time::Instant::now();
    // These four report the Phase-1 (preflight) numbers if a cancel lands
    // during planning — always zero at that point, since no copying has
    // started yet. The REAL run's totals are computed after Phase 2's
    // destination threads all join (see the aggregation below), which
    // shadows these with the actual per-destination sums.
    let total_files: u64 = 0;
    let total_dirs:  u64 = 0;
    let total_bytes: u64 = 0;
    let total_extras: u64 = 0;
    let dest_total    = destinations.len();
    let source_total  = sources.len();
    let folders_total = dest_total * source_total;
    // One robocopy summary log per destination. Empty here — nothing has run
    // yet — and only relevant if a cancel lands during planning; Phase 2
    // builds the real list from each destination thread's own result.
    let log_paths: Vec<String> = Vec::new();

    // Get a local-time timestamp for the log filenames by asking PowerShell,
    // which naturally uses the system timezone (including DST).
    // This is called once at backup start so the overhead is negligible.
    let timestamp = std::process::Command::new(crate::powershell_exe())
        .args(["-NoProfile", "-NonInteractive", "-Command",
               "Get-Date -Format 'yyyyMMddHHmmss'"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() == 14 && s.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or_else(|| {
            // Fallback: UTC unix seconds if PowerShell is unavailable.
            use std::time::{SystemTime, UNIX_EPOCH};
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .to_string()
        });

    /* ── PHASE 1: PREFLIGHT ────────────────────────────────────────────────
       List-only pass over every folder pair to compute the run's exact
       workload (see the progress-model note in the file header). Failures
       here are deliberately non-fatal: a pair whose preflight errors simply
       contributes zero to the plan, and the REAL run surfaces the real error
       with full context. The frontend clamps the bar below 100% until the
       completion event, so an undersized plan degrades gracefully. */
    let pairs_total = folders_total;
    let mut plan_bytes:  u64 = 0;
    let mut plan_files:  u64 = 0;
    let mut plan_extras: u64 = 0;
    let mut plan_pairs: Vec<PlanPair> = Vec::with_capacity(pairs_total);
    let mut pair_index: usize = 0;

    for destination in destinations.iter() {
        for source in sources.iter() {
            if CANCEL_REQUESTED.load(Ordering::SeqCst) {
                let _ = app.emit("backup-complete", BackupCompleteEvent {
                    success: false,
                    message: "Backup cancelled by user.".to_string(),
                    log_paths: log_paths.clone(),
                    total_files, total_dirs, total_bytes, total_extras,
                    total_secs: run_start.elapsed().as_secs_f64(),
                    aborted_file: None,
                    skipped_files: Vec::new(),
                    skipped_log_paths: Vec::new(),
                });
                return;
            }

            let folder_name = std::path::Path::new(source)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| source.replace([':', '/', '\\'], "_"));
            let dest_path = format!("{}/{}", destination, folder_name);

            let _ = app.emit("backup-plan-progress", BackupPlanProgressEvent {
                pair_index,
                pairs_total,
                source: source.clone(),
            });

            match preflight_pair(source, &dest_path, &|| {
                CANCEL_REQUESTED.load(Ordering::SeqCst)
            }) {
                PreflightOutcome::Ok { bytes, files, dirs: _, extras } => {
                    plan_bytes  += bytes;
                    plan_files  += files;
                    plan_extras += extras;
                    plan_pairs.push(PlanPair {
                        source: source.clone(),
                        destination: destination.clone(),
                        bytes,
                        files,
                    });
                }
                PreflightOutcome::Cancelled => {
                    let _ = app.emit("backup-complete", BackupCompleteEvent {
                        success: false,
                        message: "Backup cancelled by user.".to_string(),
                        log_paths: log_paths.clone(),
                        total_files, total_dirs, total_bytes, total_extras,
                        total_secs: run_start.elapsed().as_secs_f64(),
                        aborted_file: None,
                        skipped_files: Vec::new(),
                        skipped_log_paths: Vec::new(),
                    });
                    return;
                }
                PreflightOutcome::Failed(_) => {
                    // Real run reports the real error; keep the pair's slot so
                    // the frontend's order-based pair tracking stays aligned.
                    plan_pairs.push(PlanPair {
                        source: source.clone(),
                        destination: destination.clone(),
                        bytes: 0,
                        files: 0,
                    });
                }
            }
            pair_index += 1;
        }
    }

    let _ = app.emit("backup-plan-done", BackupPlanDoneEvent {
        bytes_to_copy: plan_bytes,
        files_to_copy: plan_files,
        extras_to_delete: plan_extras,
        per_pair: plan_pairs,
    });

    /* ── PHASE 2: REAL RUN (destinations run one after another) ────────────
       Destinations are mirrored SEQUENTIALLY — one fully finishes before the
       next begins. This is simpler and more predictable than running them at
       once, and avoids the whole class of hazards concurrency introduces
       (two /MIR passes racing on overlapping folders, the source disk being
       read N times at once, interleaved progress events). The running
       counters below are shared by reference into each destination's copy
       routine exactly as before; because only one destination runs at a time,
       they simply accumulate run-wide totals in call order. */
    let live_bytes_g  = AtomicU64::new(0);
    let live_files_g  = AtomicU64::new(0);
    let live_dirs_g   = AtomicU64::new(0);
    let folders_done_g = AtomicUsize::new(0);

    let mut results: Vec<DestinationResult> = Vec::with_capacity(destinations.len());
    for (dest_index, destination) in destinations.iter().enumerate() {
        // A cancel requested between destinations stops before starting the
        // next one. (A cancel DURING a destination is handled inside the
        // copy loop, which returns a cancelled result.)
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            break;
        }
        let result = run_destination(
            &app, dest_index, dest_total, destination, &sources,
            source_total, folders_total, &timestamp, show_details,
            &live_bytes_g, &live_files_g, &live_dirs_g, &folders_done_g,
        );
        let stop = result.cancelled;
        results.push(result);
        // A cancelled destination ends the whole run — don't start the rest.
        if stop {
            break;
        }
    }

    // ── Aggregate every destination's result into the run-level summary ────
    let total_files  = results.iter().map(|r| r.files).sum::<u64>();
    let total_dirs   = results.iter().map(|r| r.dirs).sum::<u64>();
    let total_bytes  = results.iter().map(|r| r.bytes).sum::<u64>();
    let total_extras = results.iter().map(|r| r.extras).sum::<u64>();
    let log_paths: Vec<String> = results.iter().filter_map(|r| r.log_path.clone()).collect();
    let skipped_files: Vec<SkippedFileEntry> =
        results.iter().flat_map(|r| r.skipped.clone()).collect();
    let skipped_log_paths: Vec<String> =
        results.iter().filter_map(|r| r.skipped_log_path.clone()).collect();

    let any_cancelled = results.iter().any(|r| r.cancelled);
    let failed: Vec<&DestinationResult> =
        results.iter().filter(|r| !r.success && !r.cancelled).collect();
    // First interrupted file across destinations, if any — same "one
    // representative example" spirit as the single-destination version.
    let aborted_file = results.iter().find_map(|r| r.aborted_file.clone());

    let (success, message) = if any_cancelled {
        (false, "Backup cancelled by user.".to_string())
    } else if !failed.is_empty() {
        let detail = failed
            .iter()
            .map(|r| format!("{}: {}", r.destination, r.message))
            .collect::<Vec<_>>()
            .join("; ");
        let ok_count = results.len() - failed.len();
        (
            false,
            if ok_count > 0 {
                format!(
                    "{} of {} destination{} failed. {}",
                    failed.len(),
                    results.len(),
                    if results.len() == 1 { "" } else { "s" },
                    detail
                )
            } else {
                detail
            },
        )
    } else if !skipped_files.is_empty() {
        (
            true,
            format!(
                "Backup complete, but {} file{} couldn't be copied (locked or access error). {} log file{} saved.",
                skipped_files.len(),
                if skipped_files.len() == 1 { "" } else { "s" },
                log_paths.len(),
                if log_paths.len() == 1 { "" } else { "s" }
            ),
        )
    } else {
        (
            true,
            format!(
                "Backup complete. {} log file{} saved.",
                log_paths.len(),
                if log_paths.len() == 1 { "" } else { "s" }
            ),
        )
    };

    let _ = app.emit("backup-complete", BackupCompleteEvent {
        success,
        message,
        log_paths,
        total_files, total_dirs, total_bytes, total_extras,
        total_secs: run_start.elapsed().as_secs_f64(),
        aborted_file,
        skipped_files,
        skipped_log_paths,
    });
}

/// One destination's outcome from the real-run phase — returned by
/// run_destination and folded into the run-level backup-complete summary
/// after every destination has run.
struct DestinationResult {
    destination: String,
    success: bool,
    cancelled: bool,
    message: String,
    /// None if this destination never got as far as creating its log file
    /// (e.g. create_dir_all failed before any robocopy ran).
    log_path: Option<String>,
    files: u64,
    dirs: u64,
    bytes: u64,
    extras: u64,
    aborted_file: Option<String>,
    skipped: Vec<SkippedFileEntry>,
    skipped_log_path: Option<String>,
}

/// Mirrors every source into ONE destination, one source folder after
/// another. Called once per destination from run_backup_thread's sequential
/// Phase-2 loop — destinations do NOT overlap, so this fully finishes one
/// destination before the next is started.
///
/// `live_bytes_g` / `live_files_g` / `live_dirs_g` / `folders_done_g` are the
/// run-wide running counters that feed the frontend's overall progress bar.
/// They're passed by reference and accumulate across every destination in
/// call order (they were atomics from the earlier concurrent design; kept as
/// atomics so the interior counting code is untouched, but with sequential
/// calls they behave as plain run-wide totals). `dest_bytes_done` (local) is
/// this destination's OWN running total, carried in every
/// backup-file-progress event so the frontend can drive this destination's
/// own bar from the same event stream.
#[allow(clippy::too_many_arguments)]
fn run_destination(
    app: &AppHandle,
    dest_index: usize,
    dest_total: usize,
    destination: &str,
    sources: &[String],
    source_total: usize,
    folders_total: usize,
    timestamp: &str,
    show_details: bool,
    live_bytes_g: &AtomicU64,
    live_files_g: &AtomicU64,
    live_dirs_g: &AtomicU64,
    folders_done_g: &AtomicUsize,
) -> DestinationResult {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::process::{Command, Stdio};

    let dest_run_start = std::time::Instant::now();

    if let Err(e) = fs::create_dir_all(destination) {
        let message = format!("Failed to create destination '{}': {}", destination, e);
        let _ = app.emit("backup-destination-done", BackupDestinationDoneEvent {
            dest_index,
            destination: destination.to_string(),
            success: false,
            cancelled: false,
            message: message.clone(),
            log_path: None,
            files_copied: 0, dirs_copied: 0, bytes_copied: 0, extras_deleted: 0,
            elapsed_secs: dest_run_start.elapsed().as_secs_f64(),
            aborted_file: None,
            skipped_files: Vec::new(),
            skipped_log_path: None,
        });
        return DestinationResult {
            destination: destination.to_string(),
            success: false, cancelled: false, message,
            log_path: None, files: 0, dirs: 0, bytes: 0, extras: 0,
            aborted_file: None,
            skipped: Vec::new(),
            skipped_log_path: None,
        };
    }

    // This destination's own summary log — lives inside the destination
    // folder itself and only ever receives output for copies into this
    // destination, regardless of how many other destinations are in the run.
    let dest_log_file = format!("{}/robocopy_log_{}.txt", destination, timestamp);
    // Separate log listing only the files this destination COULDN'T copy
    // (locked/access error) — created lazily, only if a skip actually
    // happens, using the same timestamp so it's easy to pair with the run.
    let skipped_log_file = format!("{}/robocopy_log_{}_SKIPPED_FILES.txt", destination, timestamp);
    // This destination's running list of files that failed to copy. Every
    // return point below carries whatever's accumulated here so far.
    let mut skipped: Vec<SkippedFileEntry> = Vec::new();

    let mut total_files: u64 = 0;
    let mut total_dirs:  u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut total_extras: u64 = 0;
    // This destination's own running byte total — the numerator for its own
    // progress bar, separate from the shared global counters. Declared HERE
    // (once per destination, not once per source folder) so it accumulates
    // across every folder this destination copies instead of resetting to 0
    // and jumping the bar backward every time a new source folder starts.
    let mut dest_bytes_done: u64 = 0;

    for (source_index, source) in sources.iter().enumerate() {
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            let message = "Backup cancelled by user.".to_string();
            let skipped_log_path = if skipped.is_empty() { None } else { Some(skipped_log_file.clone()) };
            let _ = app.emit("backup-destination-done", BackupDestinationDoneEvent {
                dest_index,
                destination: destination.to_string(),
                success: false,
                cancelled: true,
                message: message.clone(),
                log_path: Some(dest_log_file.clone()),
                files_copied: total_files, dirs_copied: total_dirs,
                bytes_copied: total_bytes, extras_deleted: total_extras,
                elapsed_secs: dest_run_start.elapsed().as_secs_f64(),
                aborted_file: None,
                skipped_files: skipped.clone(),
                skipped_log_path: skipped_log_path.clone(),
            });
            return DestinationResult {
                destination: destination.to_string(),
                success: false, cancelled: true, message,
                log_path: Some(dest_log_file),
                files: total_files, dirs: total_dirs, bytes: total_bytes, extras: total_extras,
                aborted_file: None,
                skipped,
                skipped_log_path,
            };
        }

        let folder_name = std::path::Path::new(source)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| source.replace([':', '/', '\\'], "_"));

        let dest_path = format!("{}/{}", destination, folder_name);

        let _ = app.emit("backup-folder-start", BackupFolderEvent {
            source: source.clone(),
            destination: dest_path.clone(), // full dest path, not just root
            source_index,
            source_total,
            dest_index,
            dest_total,
        });

        let folder_start = std::time::Instant::now();

        // Spawn robocopy with stdout piped so we can read it line by line.
        // /Z (restartable mode) is deliberately NOT used: it roughly halves
        // throughput on local drives, and the per-file percentage output it
        // produces was never surfaced in the UI anyway. Without it, piped
        // stdout arrives in buffered chunks rather than perfectly live —
        // the frontend's animation layer interpolates across those bursts.
        // (The percentage-line parser below is kept — it tolerates /Z-style
        // output harmlessly if the flag ever returns.)
        // /BYTES prints exact integer byte sizes on every file line — the
        // default "1.23 m" style tokens are approximations, and their unit
        // suffixes are locale-sensitive; exact integers are neither.
        // /NDL suppresses directory listing lines.
        let mut child = match Command::new(crate::system32_exe("robocopy.exe"))
            .args([
                source,
                &dest_path,
                "/MIR",
                "/COPYALL",
                "/BYTES",
                "/NDL",
                "/R:1",
                "/W:1",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let message = format!("Failed to launch robocopy: {}", e);
                let skipped_log_path = if skipped.is_empty() { None } else { Some(skipped_log_file.clone()) };
                let _ = app.emit("backup-destination-done", BackupDestinationDoneEvent {
                    dest_index,
                    destination: destination.to_string(),
                    success: false,
                    cancelled: false,
                    message: message.clone(),
                    log_path: Some(dest_log_file.clone()),
                    files_copied: total_files, dirs_copied: total_dirs,
                    bytes_copied: total_bytes, extras_deleted: total_extras,
                    elapsed_secs: dest_run_start.elapsed().as_secs_f64(),
                    aborted_file: None,
                    skipped_files: skipped.clone(),
                    skipped_log_path: skipped_log_path.clone(),
                });
                return DestinationResult {
                    destination: destination.to_string(),
                    success: false, cancelled: false, message,
                    log_path: Some(dest_log_file),
                    files: total_files, dirs: total_dirs, bytes: total_bytes, extras: total_extras,
                    aborted_file: None,
                    skipped,
                    skipped_log_path,
                };
            }
        };

        let child_pid = child.id();
        ACTIVE_ROBOCOPY_PIDS.lock().unwrap().push(child_pid);

        let stdout = child.stdout.take().expect("stdout was piped");
        let mut reader = BufReader::new(stdout);

        let mut folder_output = String::new();
        let mut files_this_folder: u64 = 0;
        let mut dirs_this_folder:  u64 = 0;
        // Size of the file robocopy is CURRENTLY copying. Its line appears
        // when the copy STARTS, so its bytes only fold into the running
        // totals when the next line proves it finished (or at folder end).
        let mut pending_file_bytes: u64 = 0;
        // Emit throttle: bursts of small files can produce thousands of
        // lines per second; flooding the IPC channel that hard buys no
        // extra smoothness (the frontend animates between events anyway).
        let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
        const EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(40);
        let mut bytes_this_folder: u64 = 0;
        // With /Z, robocopy output order per file is:
        //   1. "\t  1.23 m\tfilename.ext\n"  — size+filename line (no pct yet)
        //   2. "  0%\r  5%\r ... 100%\r\n"   — percentage updates (CR-rewritten)
        // We emit immediately on the filename line (pct=None), then re-emit
        // on each percentage line to update the per-file bar in real time.
        let mut last_current_file = String::new();
        // True once an ERROR line has been seen for the file currently in
        // last_current_file — reset every time a NEW file line starts. Stops
        // that file's bytes from being credited as copied, and stops a
        // second retry's ERROR line from double-logging the same skip.
        let mut current_file_failed = false;

        // ── DETAILS MODE: parse robocopy's output line-by-line as it runs, so
        // the frontend gets live per-file progress. The cost is that this
        // parsing must keep pace with robocopy; on trees full of tiny files
        // robocopy can out-produce the parser, fill the pipe, and BLOCK
        // waiting for us — which is exactly why "fast" mode exists below.
        if show_details {
        // Read raw bytes, not .lines(): robocopy writes piped output in
        // the console codepage (NOT UTF-8), so any filename containing a
        // non-ASCII character produces a line that .lines() rejects as
        // invalid UTF-8 — silently dropping that file from the live
        // counts and byte totals. Lossy decoding keeps every line; the
        // affected characters render as U+FFFD in the transient
        // "Copying…" label, while sizes and tabs (pure ASCII) parse
        // exactly.
        let mut raw_buf: Vec<u8> = Vec::with_capacity(512);
        loop {
            raw_buf.clear();
            match reader.read_until(b'\n', &mut raw_buf) {
                Ok(0) => break,     // EOF — robocopy closed stdout
                Ok(_) => {}
                Err(_) => break,    // stream error — stop, don't spin
            }
            let raw_line = String::from_utf8_lossy(&raw_buf)
                .trim_end_matches(['\r', '\n'])
                .to_string();

            // A percentage-update line looks like "  0%\r  5%\r 100%\r"
            // (CR-rewritten in-place). Split on \r and check if all non-empty
            // segments are bare percentage tokens.
            let cr_segments: Vec<&str> = raw_line
                .split('\r')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();

            // Robocopy /Z emits decimal percentages for large files ("  0.0%", "50.5%").
            // Parse as f32 so both "50%" and "50.5%" are accepted; cast to u8 for the event.
            let all_pct = !cr_segments.is_empty() && cr_segments.iter().all(|s| {
                s.strip_suffix('%')
                    .map(|n| n.trim().parse::<f32>().map(|v| v >= 0.0 && v <= 100.0).unwrap_or(false))
                    .unwrap_or(false)
            });

            if all_pct {
                // Extract the last (most recent) percentage and cast to u8.
                if let Some(pct_str) = cr_segments.last() {
                    if let Some(n) = pct_str.strip_suffix('%')
                        .and_then(|n| n.trim().parse::<f32>().ok())
                        .map(|v| v.clamp(0.0, 100.0) as u8)
                    {
                        // Re-emit with updated percentage so the frontend bar moves.
                        if !last_current_file.is_empty() {
                            let _ = app.emit("backup-file-progress", BackupFileProgressEvent {
                                bytes_done: live_bytes_g.load(Ordering::SeqCst),
                                files_done: live_files_g.load(Ordering::SeqCst),
                                dirs_done:  live_dirs_g.load(Ordering::SeqCst),
                                current_file: last_current_file.clone(),
                                current_file_bytes: pending_file_bytes,
                                file_pct: Some(n),
                                dest_index,
                                dest_bytes_done,
                            });
                        }
                    }
                }
                continue;
            }

            // Normal line — take first non-empty CR segment as canonical content.
            let line = cr_segments.first().copied().unwrap_or(raw_line.trim()).to_string();

            folder_output.push_str(&line);
            folder_output.push('\n');

            let trimmed = line.trim();

            // Directory-creation lines are NOT visible here: /NDL (passed
            // below) suppresses them, same as it would in the preflight
            // scan if that scan also passed it (it deliberately doesn't —
            // see preflight_pair). So dirs_this_folder stays under-counted
            // through this loop; the authoritative number comes from
            // parse_robocopy_summary once this folder's robocopy exits.

            if is_robocopy_dir_line(trimmed) {
                // Dir lines classified BEFORE file parsing — an untagged
                // (existing) dir line is a bare number + path, which the
                // file parser would misread as a file. With /NDL these
                // barely occur here, but the ordering keeps this loop
                // immune if that flag ever changes.
                if !is_robocopy_extra_line(trimmed) && is_robocopy_new_dir_line(trimmed) {
                    dirs_this_folder += 1;
                }
            } else if is_robocopy_error_line(trimmed) {
                // Robocopy couldn't copy the file currently in flight — most
                // commonly because it's locked (open in Excel/Word/etc).
                // /R:1 means this can print an ERROR twice, and robocopy also
                // RE-PRINTS the file line before the retry — which resets
                // current_file_failed, so that flag alone isn't enough to
                // stop a double entry. Dedup by source path (same guard the
                // fast path uses) to record each skipped file exactly once.
                if !current_file_failed && !last_current_file.is_empty() {
                    current_file_failed = true;
                    if !skipped.iter().any(|s| s.source == last_current_file) {
                        let skip_dest = partial_dest_of(&last_current_file, source, &dest_path)
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_else(|| dest_path.clone());
                        skipped.push(SkippedFileEntry {
                            source: last_current_file.clone(),
                            destination: skip_dest.clone(),
                        });
                        let _ = fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&skipped_log_file)
                            .and_then(|mut f| writeln!(f, "{}  ->  {}", last_current_file, skip_dest));
                    }
                }
            } else if let Some(file_bytes) = parse_robocopy_file_line(trimmed) {
                // A new file line means the PREVIOUS file finished being
                // attempted — fold its bytes into the completed totals now
                // (both this destination's own total and the shared global
                // one), UNLESS it just failed (an ERROR line arrived while it
                // was in flight), in which case nothing was actually written
                // and its bytes must not be credited.
                if !current_file_failed {
                    dest_bytes_done += pending_file_bytes;
                    live_bytes_g.fetch_add(pending_file_bytes, Ordering::SeqCst);
                    bytes_this_folder += pending_file_bytes;
                }
                current_file_failed = false;
                pending_file_bytes = file_bytes;
                files_this_folder += 1;
                live_files_g.fetch_add(1, Ordering::SeqCst);

                // The filename is the last tab-delimited token.
                let current_file = trimmed
                    .split('\t')
                    .last()
                    .unwrap_or("")
                    .trim()
                    .split_whitespace()
                    .take_while(|tok| !tok.ends_with('%'))
                    .collect::<Vec<_>>()
                    .join(" ");

                last_current_file = current_file.clone();

                // Emit (throttled) with no percentage — the frontend's
                // animation layer interpolates between events, and the
                // folder-done event reconciles authoritative totals, so a
                // suppressed final emit costs nothing.
                let now = std::time::Instant::now();
                if now.duration_since(last_emit) >= EMIT_INTERVAL {
                    last_emit = now;
                    let _ = app.emit("backup-file-progress", BackupFileProgressEvent {
                        bytes_done: live_bytes_g.load(Ordering::SeqCst),
                        files_done: live_files_g.load(Ordering::SeqCst),
                        dirs_done:  live_dirs_g.load(Ordering::SeqCst),
                        current_file,
                        current_file_bytes: pending_file_bytes,
                        file_pct: None,
                        dest_index,
                        dest_bytes_done,
                    });
                }
            }
        }
        } else {
            // ── FAST MODE: drain robocopy's entire output in one bulk read,
            // with NO per-line work while it runs. read_to_end just memcpys
            // bytes out of the pipe as fast as the CPU can, which robocopy can
            // never out-produce, so it never blocks — it runs at full speed,
            // exactly like piping to NUL. We still keep the bytes (cheap) so
            // the folder summary can be parsed afterward for accurate totals.
            // On cancel, cancel_backup kills the child; the pipe then closes
            // and this read returns EOF, landing us in the cancel check below.
            let mut raw_all: Vec<u8> = Vec::new();
            let _ = reader.read_to_end(&mut raw_all);
            folder_output = String::from_utf8_lossy(&raw_all).into_owned();

            // Skipped-file detection, done AFTER robocopy finished (post-hoc
            // parsing can't throttle a process that's already exited). Same
            // signal as the live path: an ERROR line refers to the file named
            // on the most recent file line. Deduplicated by source path so a
            // /R:1 retry that errors twice is only recorded once.
            let mut prev_file: Option<String> = None;
            for out_line in folder_output.lines() {
                let t = out_line.trim();
                if is_robocopy_error_line(t) {
                    if let Some(f) = prev_file.take() {
                        if !skipped.iter().any(|s| s.source == f) {
                            let skip_dest = partial_dest_of(&f, source, &dest_path)
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_else(|| dest_path.clone());
                            skipped.push(SkippedFileEntry {
                                source: f.clone(),
                                destination: skip_dest.clone(),
                            });
                            let _ = fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(&skipped_log_file)
                                .and_then(|mut fh| writeln!(fh, "{}  ->  {}", f, skip_dest));
                        }
                    }
                } else if !is_robocopy_dir_line(t) {
                    if parse_robocopy_file_line(t).is_some() {
                        let name = t
                            .split('\t')
                            .last()
                            .unwrap_or("")
                            .trim()
                            .split_whitespace()
                            .take_while(|tok| !tok.ends_with('%'))
                            .collect::<Vec<_>>()
                            .join(" ");
                        if !name.is_empty() {
                            prev_file = Some(name);
                        }
                    }
                }
            }
        }

        // Mid-folder cancel: cancel_backup kills the child, the pipe
        // closes, and we land here with the flag set. The in-flight file
        // was interrupted mid-write — do NOT credit its bytes; remove its
        // half-copied destination so nothing corrupt lingers (it's simply
        // absent, and the next /MIR run copies it fresh), then report a
        // clean cancellation for THIS destination (the others keep running).
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            ACTIVE_ROBOCOPY_PIDS.lock().unwrap().retain(|&p| p != child_pid);

            // Log what this folder managed before the stop.
            let _ = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&dest_log_file)
                .and_then(|mut f| {
                    let header = format!("\n========== {} → {} ==========\n", source, dest_path);
                    f.write_all(header.as_bytes())?;
                    f.write_all(folder_output.as_bytes())?;
                    f.write_all(b"\n[Backup cancelled by user during this folder.]\n")
                });

            let mut cleanup_note = String::new();
            if !last_current_file.is_empty() {
                if let Some(partial) = partial_dest_of(&last_current_file, source, &dest_path) {
                    if fs::remove_file(&partial).is_ok() {
                        cleanup_note = " The interrupted file was removed from the destination, so nothing is left half-copied.".to_string();
                    }
                }
            }

            // Credit this folder's PARTIAL progress before reporting it.
            // files_this_folder/dirs_this_folder/bytes_this_folder already
            // exclude the interrupted file itself (its bytes were never
            // folded out of pending_file_bytes — see the file-line branch
            // above), so this is exactly "what got copied", no more.
            total_files += files_this_folder;
            total_dirs  += dirs_this_folder;
            total_bytes += bytes_this_folder;

            let message = format!("Backup cancelled by user.{}", cleanup_note);
            let aborted_file = if last_current_file.is_empty() {
                None
            } else {
                Some(last_current_file.clone())
            };
            let skipped_log_path = if skipped.is_empty() { None } else { Some(skipped_log_file.clone()) };
            let _ = app.emit("backup-destination-done", BackupDestinationDoneEvent {
                dest_index,
                destination: destination.to_string(),
                success: false,
                cancelled: true,
                message: message.clone(),
                log_path: Some(dest_log_file.clone()),
                files_copied: total_files, dirs_copied: total_dirs,
                bytes_copied: total_bytes, extras_deleted: total_extras,
                elapsed_secs: dest_run_start.elapsed().as_secs_f64(),
                aborted_file: aborted_file.clone(),
                skipped_files: skipped.clone(),
                skipped_log_path: skipped_log_path.clone(),
            });
            return DestinationResult {
                destination: destination.to_string(),
                success: false, cancelled: true, message,
                log_path: Some(dest_log_file),
                files: total_files, dirs: total_dirs, bytes: total_bytes, extras: total_extras,
                aborted_file,
                skipped,
                skipped_log_path,
            };
        }

        // Robocopy has closed stdout — the last in-flight file is done
        // (unless an ERROR line marked it failed — see the file-line branch).
        if !current_file_failed {
            dest_bytes_done += pending_file_bytes;
            live_bytes_g.fetch_add(pending_file_bytes, Ordering::SeqCst);
            bytes_this_folder += pending_file_bytes;
        }

        // Wait for robocopy to exit and get its exit code.
        let exit_code = match child.wait() {
            Ok(status) => status.code().unwrap_or(16) as u32,
            Err(_) => 16,
        };
        ACTIVE_ROBOCOPY_PIDS.lock().unwrap().retain(|&p| p != child_pid);

        let elapsed = folder_start.elapsed().as_secs_f64();

        // Append captured output to this destination's own log file.
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&dest_log_file)
            .and_then(|mut f| {
                let header = format!("\n========== {} → {} ==========\n", source, dest_path);
                f.write_all(header.as_bytes())?;
                f.write_all(folder_output.as_bytes())
            });

        // Parse the summary from the captured output for accurate totals.
        let (files_parsed, dirs_parsed, bytes_parsed, extras_parsed) =
            parse_robocopy_summary(&folder_output);
        // Use parsed values for the totals (more accurate than our live count).
        // Fall back to our live count if parsing returned zeros. Extras have
        // no live counterpart to fall back to (the real-time loop doesn't
        // track them — see is_robocopy_extra_line's call site above), so the
        // summary is the only source; 0 there means 0 deletions, not "unknown".
        let files_final  = if files_parsed > 0 { files_parsed } else { files_this_folder };
        let dirs_final   = if dirs_parsed  > 0 { dirs_parsed  } else { dirs_this_folder  };
        let bytes_final  = if bytes_parsed > 0 { bytes_parsed } else { bytes_this_folder };
        let extras_final = extras_parsed;

        total_files  += files_final;
        total_dirs   += dirs_final;
        total_bytes  += bytes_final;
        total_extras += extras_final;
        live_dirs_g.fetch_add(dirs_final, Ordering::SeqCst);
        // In fast mode the live per-file loop never ran, so the run-wide
        // byte/file counters haven't moved. Fold this folder's parsed totals
        // in now (details mode already counted them per-file, so only do this
        // for fast mode to avoid double-counting), then push one progress
        // event so the overall bar and stats step forward per completed
        // folder rather than only at the very end.
        if !show_details {
            live_bytes_g.fetch_add(bytes_final, Ordering::SeqCst);
            live_files_g.fetch_add(files_final, Ordering::SeqCst);
            let _ = app.emit("backup-file-progress", BackupFileProgressEvent {
                bytes_done: live_bytes_g.load(Ordering::SeqCst),
                files_done: live_files_g.load(Ordering::SeqCst),
                dirs_done:  live_dirs_g.load(Ordering::SeqCst),
                current_file: String::new(), // hidden in fast mode
                current_file_bytes: 0,
                file_pct: None,
                dest_index,
                dest_bytes_done: 0,
            });
        }

        // Exit code is a BITMASK, not a severity scale: 1=copied, 2=extra
        // files present, 4=mismatch, 8=SOME FILES COULDN'T BE COPIED (e.g.
        // locked), 16=SERIOUS error (robocopy couldn't even start — bad
        // path, no access at all). Only 16 is fatal to this destination —
        // bit 8 just means "one or more files were skipped", which is
        // already handled per-file above (logged, not credited, and NOT a
        // reason to abort the rest of this destination's folders).
        if exit_code >= 16 {
            let message = format!(
                "robocopy failed for '{}' → '{}' (exit code {}). Check log: {}",
                source, dest_path, exit_code, dest_log_file
            );
            let skipped_log_path = if skipped.is_empty() { None } else { Some(skipped_log_file.clone()) };
            let _ = app.emit("backup-destination-done", BackupDestinationDoneEvent {
                dest_index,
                destination: destination.to_string(),
                success: false,
                cancelled: false,
                message: message.clone(),
                log_path: Some(dest_log_file.clone()),
                files_copied: total_files, dirs_copied: total_dirs,
                bytes_copied: total_bytes, extras_deleted: total_extras,
                elapsed_secs: dest_run_start.elapsed().as_secs_f64(),
                aborted_file: None,
                skipped_files: skipped.clone(),
                skipped_log_path: skipped_log_path.clone(),
            });
            return DestinationResult {
                destination: destination.to_string(),
                success: false, cancelled: false, message,
                log_path: Some(dest_log_file),
                files: total_files, dirs: total_dirs, bytes: total_bytes, extras: total_extras,
                aborted_file: None,
                skipped,
                skipped_log_path,
            };
        }

        let folders_done_global = folders_done_g.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = app.emit("backup-folder-done", BackupFolderDoneEvent {
            source: source.clone(),
            destination: dest_path.clone(),
            files_copied: files_final,
            dirs_copied:  dirs_final,
            bytes_copied: bytes_final,
            elapsed_secs: elapsed,
            dest_index,
            folders_done: folders_done_global,
            folders_total,
        });
    }

    let skipped_log_path = if skipped.is_empty() { None } else { Some(skipped_log_file.clone()) };
    let message = if skipped.is_empty() {
        format!("{} → {} complete.", sources.len(), destination)
    } else {
        format!(
            "{} → {} complete, but {} file{} couldn't be copied (locked or access error) — see Skipped Files.",
            sources.len(), destination, skipped.len(), if skipped.len() == 1 { "" } else { "s" }
        )
    };
    let _ = app.emit("backup-destination-done", BackupDestinationDoneEvent {
        dest_index,
        destination: destination.to_string(),
        success: true,
        cancelled: false,
        message: message.clone(),
        log_path: Some(dest_log_file.clone()),
        files_copied: total_files, dirs_copied: total_dirs,
        bytes_copied: total_bytes, extras_deleted: total_extras,
        elapsed_secs: dest_run_start.elapsed().as_secs_f64(),
        aborted_file: None,
        skipped_files: skipped.clone(),
        skipped_log_path: skipped_log_path.clone(),
    });
    DestinationResult {
        destination: destination.to_string(),
        success: true, cancelled: false, message,
        log_path: Some(dest_log_file),
        files: total_files, dirs: total_dirs, bytes: total_bytes, extras: total_extras,
        aborted_file: None,
        skipped,
        skipped_log_path,
    }
}

/// Returns true if a robocopy output line is a DIRECTORY entry of any kind
/// (new, existing, or extra). NOTE: these lines only appear when /NDL is NOT
/// passed — /NDL suppresses them entirely, which is why the real run (which
/// passes /NDL) takes its dir count from the summary instead.
///
/// The reliable discriminator is the trailing path separator: robocopy
/// prints directory paths WITH a trailing backslash, and file paths never
/// have one. Header/summary key-value lines ("   Source : C:\A\") also end
/// with a separator, but they contain " : " — and since Windows forbids ':'
/// in file/folder names, that token can never occur inside a real path.
fn is_robocopy_dir_line(line: &str) -> bool {
    let t = line.trim_end();
    if t.is_empty() || t.contains("---") || t.contains(" : ") {
        return false;
    }
    t.ends_with('\\') || t.ends_with('/')
}

/// True only for directory lines robocopy has tagged "New Dir" — directories
/// that WOULD BE CREATED by the run. Without /NDL, robocopy also lists every
/// EXISTING directory it walks (bare file-count + path, no tag); those are
/// neither copy work nor new, and must count as nothing at all.
fn is_robocopy_new_dir_line(line: &str) -> bool {
    is_robocopy_dir_line(line)
        && line
            .split('\t')
            .any(|part| part.trim().to_lowercase().starts_with("new dir"))
}

/// True for a robocopy per-file ERROR line, printed after retries are
/// exhausted on a file it couldn't access — e.g. it was open in Excel/Word.
/// Robocopy's real format is a fixed pattern like:
///   "2024/01/15 10:23:45 ERROR 32 (0x00000020) Copying File S:\...\file.xlsx"
/// followed by a plain-English message line on its own. Both the literal
/// " ERROR " marker and the "(0x" hex error-code marker are required together
/// — that combination essentially can't occur in a real file/directory name,
/// which keeps this from ever misfiring on an oddly-named file.
fn is_robocopy_error_line(line: &str) -> bool {
    line.contains(" ERROR ") && line.contains("(0x")
}

/* =============================================================================
   PREFLIGHT (LIST-ONLY) PASS
============================================================================= */

enum PreflightOutcome {
    Ok { bytes: u64, files: u64, dirs: u64, extras: u64 },
    Cancelled,
    Failed(String),
}

/// Runs robocopy in list-only mode (/L) for one folder pair and sums the
/// exact byte sizes of every file it WOULD copy. This is a pure directory
/// walk — no file data is read or written — so it's fast even on large trees
/// (it's the same enumeration robocopy performs internally anyway, and the
/// same thing Windows Explorer does during its "Calculating…" phase).
///
/// The selection flags (/MIR /COPYALL) must match the real run exactly so
/// robocopy makes identical copy/skip decisions in both passes. /NJH /NJS
/// strip the header and summary, leaving pure file lines — which sidesteps
/// the localized summary labels entirely. /R:0 /W:0: never sit retrying a
/// locked file during a pass whose only job is counting.
fn preflight_pair(
    source: &str,
    dest_path: &str,
    should_abort: &dyn Fn() -> bool,
) -> PreflightOutcome {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let mut child = match Command::new(crate::system32_exe("robocopy.exe"))
        .args([
            source,
            dest_path,
            "/MIR",
            "/COPYALL",
            "/L",
            "/BYTES",
            "/NJH",
            "/NJS",
            "/NP",
            "/R:0",
            "/W:0",
            // Deliberately NO /NDL here (unlike the real run below): /NDL
            // suppresses exactly the "New Dir" lines is_robocopy_dir_line()
            // depends on, which made this scan's dir count structurally
            // always zero. This pass also skips /NJS's cousin — the summary
            // — via /NJS itself, so directory lines are the ONLY source of
            // truth for dirs here; there's no summary fallback to catch a
            // suppressed count the way the real run's total_dirs can.
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return PreflightOutcome::Failed(e.to_string()),
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return PreflightOutcome::Failed("stdout not piped".to_string()),
    };
    let mut reader = BufReader::new(stdout);

    let mut bytes:  u64 = 0;
    let mut files:  u64 = 0;
    let mut dirs:   u64 = 0;
    let mut extras: u64 = 0;
    let mut lines_since_cancel_check: u32 = 0;

    // Raw-byte reads with lossy decoding — see the identical note in
    // run_backup_thread. Robocopy's piped output is console-codepage, so
    // .lines() would silently drop every file whose name isn't pure ASCII,
    // undercounting the plan.
    let mut raw_buf: Vec<u8> = Vec::with_capacity(512);
    loop {
        raw_buf.clear();
        match reader.read_until(b'\n', &mut raw_buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }

        // Abortability must work DURING a pair's walk too — a huge tree can
        // take a while, and a cancel that only works between pairs is a lie.
        // The condition is caller-supplied: the run thread aborts on the
        // backup cancel flag, estimates abort when their generation is
        // superseded.
        lines_since_cancel_check += 1;
        if lines_since_cancel_check >= 256 {
            lines_since_cancel_check = 0;
            if should_abort() {
                let _ = child.kill();
                let _ = child.wait();
                return PreflightOutcome::Cancelled;
            }
        }

        let line = String::from_utf8_lossy(&raw_buf).to_string();
        let trimmed = line.trim_end();

        if is_robocopy_extra_line(trimmed) {
            // Files/dirs that /MIR will DELETE from the destination. Deletion
            // is near-instant, so extras are counted but contribute no bytes.
            extras += 1;
            continue;
        }
        // Directory lines MUST be classified before the file parser sees the
        // line: without /NDL, robocopy lists EXISTING directories as a bare
        // number (that dir's file count) plus a path — a shape the file
        // parser happily reads as "one file of N bytes". That misparse is
        // exactly what made a fully up-to-date destination report its whole
        // directory tree as files-to-copy after a completed run.
        if is_robocopy_dir_line(trimmed) {
            if is_robocopy_new_dir_line(trimmed) {
                // Tagged "New Dir" — a directory the run would CREATE.
                dirs += 1;
            }
            // Untagged dir line = an existing directory being walked. Not
            // copy work, not a file, not a new dir: counts as nothing.
            continue;
        }
        if let Some(b) = parse_robocopy_file_line(trimmed) {
            bytes += b;
            files += 1;
        }
    }

    let _ = child.wait();
    PreflightOutcome::Ok { bytes, files, dirs, extras }
}

/// True for robocopy lines tagged "*EXTRA File" / "*EXTRA Dir" — items that
/// exist only in the destination and will be DELETED by /MIR, not copied.
fn is_robocopy_extra_line(line: &str) -> bool {
    line.split('\t')
        .any(|part| part.trim().to_lowercase().starts_with("*extra"))
}

/* =============================================================================
   BACKUP ESTIMATE  (Summary panel's "Next Backup" stats)
============================================================================= */

/// Per-destination slice of a backup estimate.
#[derive(serde::Serialize)]
pub struct EstimatePerDest {
    pub destination: String,
    pub bytes: u64,
    pub files: u64,
    pub dirs: u64,
    pub extras: u64,
}

/// The exact workload a backup would perform if run right now.
#[derive(serde::Serialize)]
pub struct BackupEstimate {
    pub bytes_to_copy: u64,
    pub files_to_copy: u64,
    pub dirs_to_copy: u64,
    pub extras_to_delete: u64,
    pub per_destination: Vec<EstimatePerDest>,
}

/// Error sentinel for a scan aborted because a newer one replaced it. The
/// frontend matches on this exact string to stay silent — a superseded scan
/// is routine, not an error worth surfacing.
pub const ESTIMATE_SUPERSEDED: &str = "__ESTIMATE_SUPERSEDED__";

/// Computes the exact delta a backup would copy/delete right now, by running
/// the same robocopy /L preflight the real backup uses — one list-only pass
/// per source×destination pair. Powers the Summary panel's "Next Backup"
/// stats, so they stay honest for incremental runs where the real workload is
/// a small fraction of the source size.
///
/// The unsafe-path validation runs here too, so a bad configuration surfaces
/// in the Summary panel the moment it's created instead of waiting for Run.
/// Async + blocking-thread — this is the big one: the estimate walks every
/// source×destination pair through robocopy /L, which on a large tree takes
/// long enough that running it on the main thread froze the entire app.
#[tauri::command]
pub async fn estimate_backup(
    sources: Vec<String>,
    destinations: Vec<String>,
) -> Result<BackupEstimate, String> {
    tauri::async_runtime::spawn_blocking(move || estimate_backup_blocking(sources, destinations))
        .await
        .map_err(|e| e.to_string())?
}

fn estimate_backup_blocking(
    sources: Vec<String>,
    destinations: Vec<String>,
) -> Result<BackupEstimate, String> {
    // Never scan while a backup is running — the two would contend for disk,
    // and the estimate would be describing a moving target anyway. (The
    // frontend refreshes automatically when the run completes.)
    if BACKUP_RUNNING.load(Ordering::SeqCst) {
        return Err("A backup is currently running.".to_string());
    }

    validate_backup_paths(&sources, &destinations)?;

    // Claim a fresh generation — this alone aborts any estimate already in
    // flight. Remember it; the moment anything bumps past it (a newer
    // estimate, an explicit cancel, a backup launching), this scan dies.
    let my_generation = ESTIMATE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let superseded = || ESTIMATE_GENERATION.load(Ordering::SeqCst) != my_generation;

    let mut total = BackupEstimate {
        bytes_to_copy: 0,
        files_to_copy: 0,
        dirs_to_copy: 0,
        extras_to_delete: 0,
        per_destination: Vec::with_capacity(destinations.len()),
    };

    for destination in &destinations {
        let mut per = EstimatePerDest {
            destination: destination.clone(),
            bytes: 0,
            files: 0,
            dirs: 0,
            extras: 0,
        };
        for source in &sources {
            let folder_name = std::path::Path::new(source)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| source.replace([':', '/', '\\'], "_"));
            let dest_path = format!("{}/{}", destination, folder_name);

            if superseded() {
                return Err(ESTIMATE_SUPERSEDED.to_string());
            }
            match preflight_pair(source, &dest_path, &superseded) {
                PreflightOutcome::Ok { bytes, files, dirs, extras } => {
                    per.bytes  += bytes;
                    per.files  += files;
                    per.dirs   += dirs;
                    per.extras += extras;
                }
                PreflightOutcome::Cancelled => {
                    return Err(ESTIMATE_SUPERSEDED.to_string());
                }
                PreflightOutcome::Failed(e) => {
                    return Err(format!("Estimate scan failed for '{}': {}", source, e));
                }
            }
        }
        total.bytes_to_copy    += per.bytes;
        total.files_to_copy    += per.files;
        total.dirs_to_copy     += per.dirs;
        total.extras_to_delete += per.extras;
        total.per_destination.push(per);
    }

    Ok(total)
}

/// Parses a robocopy per-file output line and returns the file size in bytes,
/// or None if the line is not a file-copy line.
///
/// Robocopy output lines for copied files look like:
///   "\t          1,234\tfilename.txt"          (plain integer bytes)
///   "\t       1.23 kb\tfilename.txt"           (with unit)
///   "\t  New File  \t       1.23 kb\tfile"     (with "New File" tag)
///   "\t  Newer     \t       45.6 m\tfile"      (with "Newer" tag)
///
/// We detect file lines by looking for a tab-delimited size token.
fn parse_robocopy_file_line(line: &str) -> Option<u64> {
    // "*EXTRA" lines are destination-only items being DELETED by /MIR — they
    // carry a size token too, but they are not copy work and must never count
    // toward copied files/bytes.
    if is_robocopy_extra_line(line) {
        return None;
    }

    // Split by tab and look for a size token.
    let parts: Vec<&str> = line.split('\t').collect();

    // Try each part as a potential size token.
    for part in &parts {
        let s = part.trim();
        if s.is_empty() { continue; }
        // Skip known non-size tokens.
        if matches!(s.to_lowercase().as_str(),
            "new file" | "newer" | "older" | "changed" | "same" |
            "extra file" | "lonely" | "tweaked") { continue; }

        if let Some(bytes) = parse_size_token(s) {
            return Some(bytes);
        }
    }
    None
}

/// Parses a size string like "1,234", "1.23 kb", "45.6 m", "2.1 g" into bytes.
fn parse_size_token(s: &str) -> Option<u64> {
    let tokens: Vec<&str> = s.split_whitespace().collect();
    if tokens.is_empty() { return None; }

    let num_str = tokens[0].replace(',', "");
    let n: f64 = num_str.parse().ok()?;

    let multiplier: u64 = if tokens.len() > 1 {
        match tokens[1].to_lowercase().as_str() {
            "b"  => 1,
            "kb" | "k" => 1_024,
            "mb" | "m" => 1_048_576,
            "gb" | "g" => 1_073_741_824,
            "tb" | "t" => 1_099_511_627_776,
            _ => return None, // not a unit — not a size line
        }
    } else {
        // No unit: must be a plain integer (bytes). Non-integers rejected.
        if num_str.contains('.') { return None; }
        1
    };

    Some((n * multiplier as f64) as u64)
}

/* =============================================================================
   ROBOCOPY SUMMARY PARSER

   Robocopy prints a summary table at the end of its run to stdout, like:

   -------------------------------------------------------------------------------

      Total    Copied   Skipped  Mismatch    FAILED    Extras
   Dirs :        12        10         2         0         0         0
  Files :       321       290        31         0         0         0
  Bytes :   1.23 g   1.10 g  130.5 m         0         0         0

   -------------------------------------------------------------------------------

   The COPIED column is index 1 (0-based after the label).
   We capture stdout directly (no /LOG+ flag) so this is always available.

   LOCALE NOTE: the "Files :" / "Dirs :" / "Bytes :" labels are localized on
   non-English Windows, so this parser returns zeros there. That's handled
   gracefully — the caller falls back to the live per-file counts tallied
   during the run — so non-English users get slightly-less-authoritative
   totals rather than broken ones.
============================================================================= */

fn parse_robocopy_summary(text: &str) -> (u64, u64, u64, u64) {
    let mut files_copied: u64 = 0;
    let mut dirs_copied:  u64 = 0;
    let mut bytes_copied: u64 = 0;
    let mut extras: u64 = 0;

    for line in text.lines() {
        let trimmed = line.trim();

        // Match "Files :" / "Files:" (robocopy uses "Files :" with a space)
        if trimmed.to_lowercase().starts_with("files") && trimmed.contains(':') {
            let nums = extract_numbers_from_line(trimmed);
            // Column order: Total Copied Skipped Mismatch Failed Extras
            if nums.len() >= 2 {
                files_copied = nums[1];
            }
            if nums.len() >= 6 {
                extras += nums[5];
            }
        }
        // Match "Dirs :" / "Dir :"
        else if (trimmed.to_lowercase().starts_with("dirs") || trimmed.to_lowercase().starts_with("dir"))
            && trimmed.contains(':')
        {
            let nums = extract_numbers_from_line(trimmed);
            if nums.len() >= 2 {
                dirs_copied = nums[1];
            }
            if nums.len() >= 6 {
                extras += nums[5];
            }
        }
        // Match "Bytes :"
        else if trimmed.to_lowercase().starts_with("bytes") && trimmed.contains(':') {
            bytes_copied = parse_bytes_column(trimmed);
        }
    }

    (files_copied, dirs_copied, bytes_copied, extras)
}

/// Extracts all unsigned integer values from a robocopy summary line.
/// Handles the label prefix ("Files :", "Dirs :", "Bytes :") by skipping
/// everything up to and including the first colon.
fn extract_numbers_from_line(line: &str) -> Vec<u64> {
    let after_colon = match line.find(':') {
        Some(pos) => &line[pos + 1..],
        None => line,
    };

    let mut nums = Vec::new();
    let mut current = String::new();

    for ch in after_colon.chars() {
        if ch.is_ascii_digit() {
            current.push(ch);
        } else if !current.is_empty() {
            if let Ok(n) = current.parse::<u64>() {
                nums.push(n);
            }
            current.clear();
        }
    }
    if !current.is_empty() {
        if let Ok(n) = current.parse::<u64>() {
            nums.push(n);
        }
    }
    nums
}

/// Parses the Bytes line which contains values with optional unit suffixes:
///   "Bytes :   1.23 g   1.10 g  130.5 m    0    0    0"
/// Returns the COPIED column value (index 1) in bytes.
fn parse_bytes_column(line: &str) -> u64 {
    let after_colon = match line.find(':') {
        Some(pos) => &line[pos + 1..],
        None => line,
    };

    let tokens: Vec<&str> = after_colon.split_whitespace().collect();
    let mut values: Vec<u64> = Vec::new();
    let mut i = 0;

    while i < tokens.len() {
        let tok = tokens[i].replace(',', "");
        if let Ok(n) = tok.parse::<f64>() {
            // Peek at the next token for a unit suffix.
            let multiplier: u64 = if i + 1 < tokens.len() {
                match tokens[i + 1].to_lowercase().as_str() {
                    "k"  => { i += 1; 1_024 }
                    "m"  => { i += 1; 1_048_576 }
                    "g"  => { i += 1; 1_073_741_824 }
                    "t"  => { i += 1; 1_099_511_627_776_u64 }
                    _    => 1,
                }
            } else {
                1
            };
            values.push((n * multiplier as f64) as u64);
        }
        i += 1;
    }

    // values: [Total, Copied, Skipped, Mismatch, Failed, Extras]
    values.get(1).copied().unwrap_or(0)
}
