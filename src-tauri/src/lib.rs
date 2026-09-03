/* =============================================================================
   LIB: Swiss RB Knife Tauri backend
   -----------------------------------------------------------------------------
   Application entry point and command registry. Owns:

     • get_data_path(): resolves the per-user data directory (dev vs release);
                          pub(crate) so tool modules can call it directly without
                          duplicating the dev/release branching logic
     • Shell-level commands: settings, window size, shell state (save/load)
     • Tool command registration via the invoke_handler macro

   Per-tool commands live in src/tools/<tool>.rs and are registered below.
   To add a new tool: create src/tools/<tool>.rs, add it to mod.rs, then
   register its commands in the invoke_handler at the bottom of this file.
============================================================================= */

use std::fs;
use std::path::PathBuf;
use chrono::{Local, TimeZone};
// Manager is only referenced inside the #[cfg(not(debug_assertions))] branch of
// get_data_path(): the compiler sees it as unused in debug builds and warns.
// The allow suppresses that spurious warning without removing the import.
#[allow(unused_imports)]
use tauri::Manager;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

mod agent_gate;
mod db;
mod session_watch;
mod tools;

/* =============================================================================
   FILE PATHS
   -----------------------------------------------------------------------------
   THE DATA FOLDER HAS A SHAPE, and every name passed to get_data_path is a path
   inside it rather than a bare filename:

     app/            the shell's own files: preferences, window size, the lock.
     <tool>/         one folder per tool, holding everything that tool owns,
                     including <tool>/backups/ with that tool's own history.

   SNAPSHOTS ARE PER TOOL, and that is a retention decision rather than a
   tidiness one. Thirty hourly buckets are kept. Shared, those thirty are the
   last thirty hours in which ANY tool was written, so an afternoon of dragging
   Kanban cards would evict months of Budget history that nothing had touched.
   Per tool, each keeps its own last thirty hours of its own edits, which for a
   tool you open monthly is months.

   It costs nothing structurally: every snapshot group is already one tool's
   files, so no group is split by the move.

   Filenames keep their tool prefix inside their own folder even now that the
   folder says the same thing. A loose .bak still names what it is, and it is
   what makes a bucket readable when you are looking at one by hand.
============================================================================= */

/// The data directory itself, created if it is not there.
///
/// - **Dev builds** (`debug_assertions` on): `../data/` relative to the Cargo
///   workspace root, so the files sit next to `src-tauri/` and are easy to
///   inspect during development.
/// - **Release builds**: the OS app-data directory via Tauri's `app_data_dir()`,
///   which is named for the bundle identifier, so `%APPDATA%\swiss-rb-knife\`
///   on Windows rather than the product name.
#[allow(unused_variables)]
pub(crate) fn data_root(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let mut path = std::env::current_dir().unwrap();
        path.pop();
        path.push("data");
        let _ = std::fs::create_dir_all(&path);
        path
    }

    #[cfg(not(debug_assertions))]
    {
        let path = app
            .path()
            .app_data_dir()
            .expect("Failed to resolve app data dir");
        let _ = std::fs::create_dir_all(&path);
        return path;
    }
}

/// Lets the webview render a path through the asset protocol.
///
/// CANONICALIZED FIRST, and that is the whole reason this is a function rather
/// than one line at each call site. Tauri canonicalizes the path it is asked
/// for before testing it against the scope, and on Windows that produces a
/// verbatim path: `\\?\D:\...`. A pattern registered as plain `D:\...` never
/// matches one, so the grant silently does nothing and the picture just does
/// not appear. Registering the canonical form gets both, because Tauri also
/// stores the prefix-stripped version of anything given to it with a prefix.
///
/// Best effort throughout: a path that cannot be canonicalized is registered as
/// it stands, and a grant that fails costs a broken thumbnail rather than the
/// operation that produced it.
pub(crate) fn allow_asset_path(app: &tauri::AppHandle, path: &std::path::Path, dir: bool) {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let scope = app.asset_protocol_scope();
    let _ = if dir {
        scope.allow_directory(&resolved, true)
    } else {
        scope.allow_file(&resolved)
    };
}

/// Where one tool's hourly snapshots live: <tool>/backups.
///
/// `tool_dir` is the folder name, which is also the tool id everywhere else in
/// the app. See the section header for why this is per tool.
pub(crate) fn backups_root(app: &tauri::AppHandle, tool_dir: &str) -> PathBuf {
    data_root(app).join(tool_dir).join("backups")
}

/// The tool folder a data path belongs to: the part before the first slash.
///
/// Every path inside the data folder starts with the folder that owns it, so
/// this is how a write finds the snapshot folder to capture into without being
/// told twice which tool it is.
pub(crate) fn tool_dir_of(relative: &str) -> &str {
    relative.split('/').next().unwrap_or(relative)
}

/// Resolves a path inside the data directory, creating the folder it lands in.
///
/// `relative` is a path, not a filename: "app/settings.json", "kanban/
/// kanban-index.json", "kanban/kanban-boards/kanban-board-<id>.json". Callers
/// pass a constant or something built from one of the allowlists in this file,
/// never a name that arrived from the front end unchecked.
pub(crate) fn get_data_path(app: &tauri::AppHandle, relative: &str) -> PathBuf {
    let path = data_root(app).join(relative);
    // The folder, not the file. A tool's first write is what creates its folder,
    // so nothing has to remember to make them up front.
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    path
}

/* =============================================================================
   MOVING AN OLD DATA FOLDER INTO THE NEW SHAPE
   -----------------------------------------------------------------------------
   Everything used to sit flat in one directory. This moves each file to where
   it now belongs, once, on the way up and before anything reads.

   IT ONLY EVER MOVES A FILE TO A PLACE NOTHING IS. If the destination already
   exists the source is left exactly where it is, untouched, rather than being
   overwritten or deleted. So this cannot destroy anything, it can only fail to
   tidy, and a folder that is already in the new shape is a no-op.

   THE OLD SHARED backups/ IS SPLIT the same way, a captured file at a time,
   into the tool folder that owns it. A .bak is named after the file it came
   from, so which tool owns it is a question its own name answers.

   A .bak nothing claims is LEFT WHERE IT IS. Filing it under a guess would be
   worse than leaving it somewhere a person can look at it.
============================================================================= */

/// Old flat name to new relative path, for everything that is not a board file.
const RELOCATIONS: [(&str, &str); 21] = [
    ("settings.json", "app/settings.json"),
    ("shell-state.json", "app/shell-state.json"),
    ("window.json", "app/window.json"),
    ("lock.json", "app/lock.json"),
    ("custom-themes.json", "app/custom-themes.json"),
    ("auto-backup.json", "auto-backup/auto-backup.json"),
    ("auto-backup-presets.json", "auto-backup/auto-backup-presets.json"),
    ("budget-data.json", "budget/budget-data.json"),
    ("budget-data.enc", "budget/budget-data.enc"),
    ("budget-entities.json", "budget/budget-entities.json"),
    ("budget-entities.enc", "budget/budget-entities.enc"),
    ("budget-settings.json", "budget/budget-settings.json"),
    ("budget-lock.json", "budget/budget-lock.json"),
    ("countdown.json", "countdown/countdown.json"),
    ("game-stats.json", "game-stats/game-stats.json"),
    ("game-stats-draft.json", "game-stats/game-stats-draft.json"),
    ("game-stats-settings.json", "game-stats/game-stats-settings.json"),
    ("kanban-index.json", "kanban/kanban-index.json"),
    ("kanban-settings.json", "kanban/kanban-settings.json"),
    ("rng.json", "rng/rng.json"),
    ("tts-repeater.json", "tts-repeater/tts-repeater.json"),
];

/// Folders that moved whole.
const FOLDER_RELOCATIONS: [(&str, &str); 3] = [
    ("kanban-attachments", "kanban/kanban-attachments"),
    ("kanban-backgrounds", "kanban/kanban-backgrounds"),
    ("kanban-attachment-store", "kanban/kanban-attachment-store"),
];

fn relocate(root: &std::path::Path, from: &str, to: &str) {
    let src = root.join(from);
    let dest = root.join(to);
    // Never over the top of something. See the section header.
    if !src.exists() || dest.exists() {
        return;
    }
    if let Some(parent) = dest.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let _ = fs::rename(&src, &dest);
}

/// Which tool folder a captured file belongs to, from the name it was captured
/// under. None for anything the app does not recognize.
fn owner_of_backup(bak_name: &str) -> Option<&'static str> {
    let stem = bak_name.strip_suffix(".bak")?;
    // Longest prefix first, so "game-stats-settings" is not read as a tool
    // called "game" and "time-tracker-settings" beats a bare "time-tracker".
    for (prefix, tool) in [
        ("budget-", "budget"),
        ("kanban-", "kanban"),
        ("time-tracker", "time-tracker"),
        ("game-stats", "game-stats"),
        ("countdown", "countdown"),
        ("rng", "rng"),
        ("tts-repeater", "tts-repeater"),
        ("auto-backup", "auto-backup"),
        // The database, under the name it had when it held three tools.
        ("tools.db", "game-stats"),
    ] {
        if stem.starts_with(prefix) {
            return Some(tool);
        }
    }
    None
}

/// Moves the one shared backups/ folder into a backups/ under each tool.
///
/// Buckets keep their names, so a snapshot taken before this still lines up
/// with the ones taken after. A bucket left empty because nothing in it was
/// recognized stays; an emptied one is removed, and remove_dir only succeeds
/// on a folder that is already empty, which is the safety here.
fn split_shared_backups(root: &std::path::Path) {
    let shared = root.join("backups");
    let buckets = match fs::read_dir(&shared) {
        Ok(e) => e,
        Err(_) => return,
    };
    for bucket in buckets.flatten() {
        let dir = bucket.path();
        if !dir.is_dir() {
            continue;
        }
        let bucket_name = bucket.file_name().to_string_lossy().to_string();
        if !valid_bucket_name(&bucket_name) {
            continue;
        }
        let files = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for file in files.flatten() {
            let name = file.file_name().to_string_lossy().to_string();
            let tool = match owner_of_backup(&name) {
                Some(t) => t,
                None => continue,
            };
            // The database was captured under its old name.
            let dest_name = if name == "tools.db.bak" {
                "game-stats.db.bak".to_string()
            } else {
                name
            };
            let dest = root.join(tool).join("backups").join(&bucket_name).join(dest_name);
            if dest.exists() {
                continue;
            }
            if let Some(parent) = dest.parent() {
                if fs::create_dir_all(parent).is_err() {
                    continue;
                }
            }
            let _ = fs::rename(file.path(), &dest);
        }
        // Only succeeds if everything in it was claimed and moved.
        let _ = fs::remove_dir(&dir);
    }
    let _ = fs::remove_dir(&shared);
}

/// Puts a flat data folder into the per-tool shape. Safe to run every launch.
pub(crate) fn migrate_data_layout(app: &tauri::AppHandle) {
    let root = data_root(app);

    for (from, to) in RELOCATIONS {
        relocate(&root, from, to);
    }
    for (from, to) in FOLDER_RELOCATIONS {
        relocate(&root, from, to);
    }

    // Time Tracker's files, one of which is named for nothing in particular.
    relocate(&root, "time-tracker.json", "time-tracker/time-tracker.json");
    relocate(&root, "time-tracker-settings.json", "time-tracker/time-tracker-settings.json");
    relocate(&root, "draft.json", "time-tracker/time-tracker-draft.json");

    /* The database, with its write-ahead log and shared-memory file. All three
       or none: the .db on its own is only the state as of the last checkpoint,
       so leaving the -wal behind would silently roll back whatever is in it.

       It is named for its tool now. It held three tools for about a day, and
       "tools.db" was a reasonable name for that and a misleading one for what
       it actually is, which is the Game Stats history. */
    for suffix in ["", "-wal", "-shm"] {
        relocate(
            &root,
            &format!("tools.db{suffix}"),
            &format!("game-stats/game-stats.db{suffix}"),
        );
    }

    // The shared snapshot folder, split into one per tool. After the files
    // above have moved, so a tool folder already exists to put them in.
    split_shared_backups(&root);

    // Every board file, by pattern rather than by name.
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("kanban-board-") && name.ends_with(".json") {
                relocate(&root, &name, &format!("kanban/kanban-boards/{name}"));
            }
        }
    }
}

/* =============================================================================
   SYSTEM BINARY PATHS
   -----------------------------------------------------------------------------
   This app ships with an elevated (requireAdministrator) manifest, so every
   child process it launches inherits the admin token. Spawning system tools by
   bare name ("robocopy", "powershell", …) resolves them through the normal
   Windows search order, which includes the application directory and the
   current working directory BEFORE System32. A same-named binary planted in
   either would therefore run as admin. Resolving these tools to their absolute
   System32 paths removes that vector entirely.

   Paths are built from %SystemRoot% (always present in the Windows environment)
   with a conventional fallback, rather than hardcoding "C:\Windows" outright.
============================================================================= */

/// Absolute path to a binary that lives directly in System32 (robocopy.exe,
/// fsutil.exe, taskkill.exe, …). See the section header for why bare names are
/// unsafe in an elevated process.
pub(crate) fn system32_exe(name: &str) -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    format!("{}\\System32\\{}", root, name)
}

/// Absolute path to a binary that lives in the Windows directory itself rather
/// than System32 (explorer.exe).
pub(crate) fn windows_dir_exe(name: &str) -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    format!("{}\\{}", root, name)
}

/// Absolute path to Windows PowerShell. powershell.exe lives under a versioned
/// subfolder of System32, not System32 directly, so it can't use system32_exe
/// with a bare filename.
pub(crate) fn powershell_exe() -> String {
    system32_exe("WindowsPowerShell\\v1.0\\powershell.exe")
}

/* =============================================================================
   FILENAME SAFETY
============================================================================= */

/// MS-DOS device names that Windows still reserves. Opening any of these as a
/// file path talks to the DEVICE, not the filesystem, and the reservation
/// applies with any extension and any casing, so "con", "CON.jpg" and
/// "Con.tar.gz" are all the console.
const RESERVED_DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// True if `name` is a reserved Windows device name, ignoring any extension
/// and casing.
///
/// Worth guarding even though it looks exotic: a write to one of these does
/// not fail loudly, it succeeds against the device and no file ever appears.
/// The user sees a tool report success with nothing on disk, which is far
/// harder to diagnose than a rejected filename. "con" in particular is a
/// realistic thing to type (short for "concatenated") when naming the output
/// of the Combine tool.
pub(crate) fn is_reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim();
    RESERVED_DEVICE_NAMES
        .iter()
        .any(|r| stem.eq_ignore_ascii_case(r))
}

/// Rejects any filename that could resolve outside its target folder or that
/// Windows can't create: path separators, "..", illegal characters, control
/// characters, reserved device names, and empty names.
///
/// Lives here rather than in a tool module because every "write a file to
/// Downloads" command needs exactly this check, and a second copy is a second
/// thing to keep correct. The frontends only ever send generated names today.
/// This guard exists so that never has to stay true.
pub(crate) fn sanitize_filename(filename: &str) -> Result<String, String> {
    let name = filename.trim();
    if name.is_empty() {
        return Err("Filename is empty.".to_string());
    }
    if name == "." || name == ".." {
        return Err("Invalid filename.".to_string());
    }
    let illegal = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    if name.chars().any(|c| illegal.contains(&c) || (c as u32) < 0x20) {
        return Err(format!("Filename contains characters Windows doesn't allow: {}", name));
    }
    if is_reserved_device_name(name) {
        return Err(format!("'{}' is a reserved Windows device name.", name));
    }
    Ok(name.to_string())
}

/* =============================================================================
   BASE64
   -----------------------------------------------------------------------------
   Hand-rolled, for the same reason game_stats.rs's .xlsx reader is: the app
   ships no runtime JS dependencies, and the needed slice of the format is forty
   lines. It lives HERE rather than in a tool because two tools want it, Game
   Stats to move a spreadsheet across the IPC boundary and Kanban to move a
   pasted image, and two copies of a codec is one place for a bug to be fixed
   and one place for it to survive.

   Callers map the error to their own wording; the message here says only what
   is true from inside the decoder.
============================================================================= */

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) as usize & 63] as char);
        // The tail is padded rather than truncated so the output round-trips
        // through any standards-compliant decoder, not just this one.
        out.push(if chunk.len() > 1 { BASE64_ALPHABET[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { BASE64_ALPHABET[triple as usize & 63] as char } else { '=' });
    }
    out
}

pub(crate) fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for ch in text.bytes() {
        // Padding, and any whitespace a line-wrapped payload arrived with.
        if matches!(ch, b'=' | b'\r' | b'\n' | b' ' | b'\t') {
            continue;
        }
        let value = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("Malformed base64 data.".to_string()),
        } as u32;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/* =============================================================================
   SAFE FILE WRITES
============================================================================= */

/// Writes `bytes` to `path` without ever leaving a half-written file behind.
/// Writes to a sibling temp file first, fsyncs it, then renames it over the
/// real path. The rename is a single atomic filesystem operation (on Windows
/// this uses MoveFileExW with MOVEFILE_REPLACE_EXISTING under the hood).
///
/// This matters specifically because of how Windows installers upgrade an
/// app: the old process is force-terminated (not asked to close gracefully)
/// so the installer can overwrite the .exe. If that termination lands mid
/// fs::write(), a plain write leaves a truncated file. The previous good
/// data is gone and the new data never fully landed either. Every tool's
/// save path must go through this helper, not fs::write() directly.
///
/// Two hardening details beyond the basic temp-then-rename pattern:
///
/// • sync_all() before the rename. Without it, a power loss can leave the
///   RENAME on disk while the temp file's CONTENTS never made it out of the
///   OS cache, a valid-looking but truncated file sitting behind the very
///   mechanism meant to prevent exactly that. The fsync forces the bytes to
///   storage before the name swap can possibly land.
///
/// • A unique temp name per call (pid + counter) instead of a fixed ".tmp"
///   suffix. Tauri runs sync commands on a thread pool, so two overlapping
///   saves targeting the same file are possible, with a shared temp name
///   they'd interleave writes into one temp file and rename garbage into
///   place. Unique names mean the worst case is just last-rename-wins.
pub(crate) fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(format!(".tmp-{}-{}", std::process::id(), n));
    let tmp_path = PathBuf::from(tmp_name);

    // Any failure past this point must clean up the temp file, a graveyard
    // of orphaned .tmp-* files in the data dir helps nobody.
    let write_result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file); // release the handle before rename, required on Windows
        fs::rename(&tmp_path, path).map_err(|e| e.to_string())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

/// Width of each backup bucket, in seconds. Every write within the same
/// bucket refreshes that bucket's snapshot rather than creating a new one,
/// deliberately coarse, since the goal is surviving corruption discovered
/// days or weeks later, not per-edit undo history.
const BACKUP_MIN_INTERVAL_SECS: i64 = 3600;
/// How many historical buckets to retain per tool before pruning the oldest.
/// Thirty hours OF THAT TOOL'S OWN EDITS, which for a tool you open monthly is
/// months of history. See the FILE PATHS header.
pub(crate) const BACKUP_KEEP_COUNT: usize = 30;

/// Folder-name format for backup snapshots: sorts correctly as plain strings
/// (matches chronological order) and is readable in a file browser without
/// translating a Unix timestamp. Rendered on the LOCAL clock, so a snapshot
/// taken at 2pm shows "14" here.
pub(crate) const BACKUP_FOLDER_FORMAT: &str = "%Y-%m-%d_%H-%M-%S";

/// The house timestamp for anything named after the moment it was made, in
/// LOCAL time: snapshot buckets, generated folders, log filenames.
///
/// Local rather than UTC because a name is read by the person who made it,
/// next to the thing it names, so the only clock that means anything to them
/// is the one on their wall. chrono::Local follows the system timezone,
/// daylight saving included.
///
/// This is for NAMES. A moment recorded inside a data file stays a UTC
/// instant, because that has to compare correctly against another one.
pub(crate) fn file_timestamp() -> String {
    Local::now().format(BACKUP_FOLDER_FORMAT).to_string()
}

/// Deletes all but the newest `keep` buckets in one tool's backups folder and
/// returns what survived, oldest first.
///
/// Shared rather than written once per snapshot writer. The JSON snapshots and
/// the database snapshot capture different things in different ways, but "how
/// much history does a tool keep" is one answer, and a second copy of this is
/// how the database folder ended up growing without a cap.
pub(crate) fn prune_buckets(backups_root: &std::path::Path, keep: usize) -> Vec<String> {
    let mut existing: Vec<String> = fs::read_dir(backups_root)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| valid_bucket_name(name))
        .collect();
    existing.sort(); // the format sorts correctly as plain strings
    if existing.len() > keep {
        let cut = existing.len() - keep;
        for old_name in &existing[..cut] {
            let _ = fs::remove_dir_all(backups_root.join(old_name));
        }
        existing.drain(..cut);
    }
    existing
}

/// Writes `write_bytes` to `write_filename` atomically, but first captures
/// the CURRENT on-disk contents of every file in `group_filenames` together
/// into a timestamped folder: `backups/<bucket-start>/<filename>.bak` for
/// each file that currently exists.
///
/// Snapshots are bucketed into BACKUP_MIN_INTERVAL_SECS-wide windows rather
/// than "skip for an hour after the last one". Every write within the same
/// bucket overwrites that bucket's snapshot with the latest pre-write state,
/// so the folder always reflects the MOST RECENT state as of the end of
/// that window, not whatever was on disk when the window started. A cooldown
/// that only fires on the first write of a burst would otherwise miss
/// everything after it: if you edit for 50 minutes and then don't touch the
/// app again for a week, that 50 minutes needs to be the thing that's
/// backed up, not the state from before it started.
///
/// The whole point of grouping is that files like budget-data.enc and
/// budget-lock.json only mean anything as a matched pair. The salt in one
/// has to correspond to the ciphertext in the other. Keeping every
/// snapshot's files together in one folder means restoring is always
/// "take everything from one timestamp folder," never mixing.
///
/// This exists because budget-data.enc became undecryptable once under
/// circumstances that resisted every reproduction attempt. Rather than
/// assume the root cause is fully understood, this makes a recurrence
/// survivable. Snapshotting is always best-effort: a failure here must
/// never block the real save.
pub(crate) fn backed_up_write_group(
    app: &tauri::AppHandle,
    group_filenames: &[&str],
    write_filename: &str,
    write_bytes: &[u8],
) -> Result<(), String> {
    let group_paths: Vec<PathBuf> = group_filenames
        .iter()
        .map(|f| get_data_path(app, f))
        .collect();
    /* Which tool's history this belongs in, taken from the file being written
       rather than passed separately, so it cannot disagree with where the file
       actually lands. Every group is one tool's files, so the group members
       agree with this by construction. */
    snapshot_group(app, tool_dir_of(write_filename), &group_paths);
    atomic_write(&get_data_path(app, write_filename), write_bytes)
}

/// Captures the current contents of these files into this hour's bucket,
/// without writing anything.
///
/// For a restore, which puts several files back at once and so cannot ride
/// along with a single write the way backed_up_write_group does. What it
/// protects is the same thing: the state being replaced, captured before it is
/// replaced, so an unwanted restore is undone by restoring the newest.
pub(crate) fn snapshot_files(app: &tauri::AppHandle, tool_dir: &str, filenames: &[&str]) {
    let paths: Vec<PathBuf> = filenames.iter().map(|f| get_data_path(app, f)).collect();
    snapshot_group(app, tool_dir, &paths);
}

fn snapshot_group(app: &tauri::AppHandle, tool_dir: &str, group_paths: &[PathBuf]) {
    let backups_root = backups_root(app, tool_dir);
    if fs::create_dir_all(&backups_root).is_err() {
        return;
    }

    // Only files that actually exist get captured, e.g. on the very
    // first-ever write there's nothing to back up yet.
    let files_to_snapshot: Vec<(PathBuf, Vec<u8>)> = group_paths
        .iter()
        .filter_map(|p| fs::read(p).ok().map(|bytes| (p.clone(), bytes)))
        .collect();
    if files_to_snapshot.is_empty() {
        return;
    }

    // Bucketed on the LOCAL clock, so a bucket boundary lands on the hour the
    // user sees. Rounding the epoch instead would drift off the local hour in a
    // timezone whose offset is not a whole number of hours.
    let now_local = Local::now();
    let bucket_start_secs =
        (now_local.timestamp() / BACKUP_MIN_INTERVAL_SECS) * BACKUP_MIN_INTERVAL_SECS;
    let bucket_name = match Local.timestamp_opt(bucket_start_secs, 0).single() {
        Some(dt) => dt.format(BACKUP_FOLDER_FORMAT).to_string(),
        None => return,
    };

    let snapshot_dir = backups_root.join(&bucket_name);
    if fs::create_dir_all(&snapshot_dir).is_err() {
        return;
    }
    for (path, bytes) in &files_to_snapshot {
        let filename = match path.file_name().and_then(|n| n.to_str()) {
            Some(f) => f,
            None => continue,
        };
        // Overwrites on purpose. Every write within this bucket refreshes
        // it to the latest pre-write state, so by the time the bucket
        // closes it holds the last state before the gap, not the first.
        let _ = fs::write(snapshot_dir.join(format!("{filename}.bak")), bytes);
    }

    // Prune to the newest BACKUP_KEEP_COUNT buckets OF THIS TOOL. Cheap enough
    // (a directory listing of ~30 entries) to just do on every write rather
    // than tracking whether this call started a new bucket.
    let existing_buckets = prune_buckets(&backups_root, BACKUP_KEEP_COUNT);

    /* Kanban's attachments are not copied into buckets, because thirty hourly
       copies of a video is gigabytes of a file that never changes. They are
       moved aside when deleted instead, and dropped once the oldest surviving
       bucket is newer than the moment they left. This is the only place that
       answer changes, so it is the only place worth asking it. */
    if tool_dir == "kanban" {
        if let Some(oldest) = existing_buckets.first() {
            // Bucket names are local wall-clock time, so they are read back as
            // local. Reading them as UTC would move the cutoff by the whole
            // timezone offset and drop attachments early.
            let cutoff = chrono::NaiveDateTime::parse_from_str(oldest, BACKUP_FOLDER_FORMAT)
                .ok()
                .and_then(|naive| naive.and_local_timezone(Local).single())
                .map(|dt| dt.timestamp().max(0) as u64)
                .map(|secs| std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs));
            if let Some(cutoff) = cutoff {
                crate::tools::kanban::prune_kanban_attachment_store(&data_root(app), cutoff);
            }
        }
    }
}

/* =============================================================================
   EXPORT AND IMPORT
   -----------------------------------------------------------------------------
   Every tool's data, out to a JSON file the user names and back in from one.

   FOR GAME STATS THIS REPLACES BEING ABLE TO OPEN THE FILE. Its records live
   in the database, so there is no JSON to open in Notepad and repair by hand
   the way there is for every other tool. An export therefore has to be able to
   reconstruct it completely, and an import has to be able to put it back.

   For the tools still on files, an export is a copy you can take somewhere
   else, which a snapshot sitting beside the data is not.

   These two commands are file I/O and nothing else. What an export CONTAINS and
   what an import MEANS is each tool's own business, because only the tool knows
   its own shape; the front end assembles one and applies the other.
============================================================================= */

/* THE DIALOG IS OPENED HERE, NOT IN THE FRONT END, and that is the whole point
   of these two.

   They used to take a path as an argument. Every other write in this app is
   pinned to a name from one of the allowlists above, for the reason get_data_path
   states: nothing joins a path that arrived from the front end unchecked. These
   two broke that rule, and this app runs elevated, so `export_tool_json` was a
   write-anywhere-as-Administrator command with nothing but a convention in
   front of it. The dialog was that convention: real, but enforced on the wrong
   side of the boundary.

   Now the destination is whatever the person at the keyboard picked in an OS
   dialog this process opened. There is no argument to lie about. The front end
   suggests a FILENAME, which is checked like every other filename before it is
   put in front of anyone.

   `#[tauri::command(async)]` on a sync function is what puts these on a worker
   thread. The blocking dialog calls must not run on the main thread, which is
   where a plain #[tauri::command] would put them, and where they would freeze
   the event loop the dialog needs in order to answer. */

/// Asks where to put an export and writes it there, returning where it landed.
/// `Ok(None)` means the dialog was cancelled, which is not an error.
#[tauri::command(async)]
fn export_tool_json(
    app: tauri::AppHandle,
    suggested_name: String,
    data: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let name = sanitize_filename(&suggested_name)?;
    let picked = app
        .dialog()
        .file()
        .set_title("Export")
        .set_file_name(name)
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    let Some(dest) = picked.and_then(|p| p.as_path().map(|p| p.to_path_buf())) else {
        return Ok(None);
    };
    // Through the atomic helper like every other write: an export interrupted
    // half way must not leave a file that looks complete and is not.
    atomic_write(&dest, data.as_bytes())?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

/// Asks for a file and returns its text. `Ok(None)` means the dialog was
/// cancelled. Deciding what the text MEANS is the tool's job.
#[tauri::command(async)]
fn import_tool_json(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .set_title("Import")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    let Some(src) = picked.and_then(|p| p.as_path().map(|p| p.to_path_buf())) else {
        return Ok(None);
    };
    fs::read_to_string(&src)
        .map(Some)
        .map_err(|e| format!("Could not read that file: {e}"))
}

/* =============================================================================
   WINDOW SIZE COMMANDS  (shell-level)
============================================================================= */

/// Persists the serialized window size JSON to disk.
/// Called by shell.ts on every window resize (debounced 300 ms).
#[tauri::command]
fn save_window_size(app: tauri::AppHandle, data: String) -> Result<(), String> {
    atomic_write(&get_data_path(&app, "app/window.json"), data.as_bytes())
}

/// Loads the saved window size JSON from disk.
/// Returns an error string ("no saved size") if the file doesn't exist yet,
/// which shell.ts treats as a signal to use the tauri.conf.json defaults.
#[tauri::command]
fn load_window_size(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, "app/window.json")) {
        Ok(content) => Ok(content),
        Err(_) => Err("no saved size".to_string()),
    }
}

/* =============================================================================
   SETTINGS COMMANDS  (shell-level)
============================================================================= */

/* Removed: save_settings (whole-file write of settings.json).
   settings.json USED to have several writers (shell, Time Tracker, Budget),
   and a whole-file write from any one of them clobbered the others' keys.
   That's the bug merge_settings was written to fix. It was kept registered
   for backward compatibility long after the last caller was gone; leaving a
   footgun IPC command exposed to the webview earns nothing when nothing
   invokes it. Use merge_settings (below), or save_tool_settings for per-tool
   state. */

/// Merges a JSON patch into settings.json: only the TOP-LEVEL keys present in
/// the patch are written; every other key on disk is preserved untouched.
///
/// The shell is the only writer left: tool settings moved into per-tool files,
/// and Time Tracker and Budget now only READ this one, for shell-owned display
/// preferences and for legacy keys of theirs still sitting here from before the
/// split. It stays a merge anyway, because a whole-file write would drop those
/// legacy keys, and because the guarantee then does not have to be re-argued
/// the next time something needs to write here.
///
/// The read-merge-write runs under a process-wide mutex, closing the
/// interleaving window where two near-simultaneous saves could each read the
/// same starting state and the second write would drop the first's keys.
#[tauri::command]
fn merge_settings(app: tauri::AppHandle, patch: String) -> Result<(), String> {
    use std::sync::Mutex;
    static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
    let _guard = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;

    let path = get_data_path(&app, "app/settings.json");

    // Existing file → JSON object; missing or corrupt → start from empty.
    let mut on_disk: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    if !on_disk.is_object() {
        on_disk = serde_json::json!({});
    }

    let patch_value: serde_json::Value =
        serde_json::from_str(&patch).map_err(|e| format!("Invalid settings patch: {}", e))?;
    let patch_obj = patch_value
        .as_object()
        .ok_or_else(|| "Settings patch must be a JSON object.".to_string())?;

    let target = on_disk.as_object_mut().expect("checked is_object above");
    for (key, value) in patch_obj {
        target.insert(key.clone(), value.clone());
    }

    let serialized = serde_json::to_string(&on_disk).map_err(|e| e.to_string())?;
    atomic_write(&path, serialized.as_bytes())
}

/// Loads the saved settings JSON from disk.
/// Returns `"{}"` (empty object) if the file doesn't exist, shell.ts then
/// merges over DEFAULT_SETTINGS so every key gets a safe fallback value.
#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, "app/settings.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok("{}".to_string()),
    }
}

/* =============================================================================
   PER-TOOL SETTINGS COMMANDS
   -----------------------------------------------------------------------------
   Each tool's settings live in that tool's OWN file, settings.json belongs
   to the shell (General Settings) alone. One file, one owner: the entire
   class of "writer A's save erases writer B's keys" becomes structurally
   impossible, instead of merely being avoided by merge discipline.
============================================================================= */

/// Maps a tool id to its settings filename. An allowlist rather than string
/// interpolation, so the frontend can never address an arbitrary file.
/// Every file a tool keeps to itself, by tool and by what the file holds, plus
/// what an ABSENT one reads as.
///
/// One table, and one pair of commands behind it, rather than a bespoke
/// save/load pair per tool. Nine tools had grown their own identical pair:
/// atomic_write on the way in, read_to_string with a hardcoded empty shape on
/// the way out, ~14 lines each, differing only in a filename. That is nine
/// places to remember when the write path changes, and the app has already
/// shipped a release where one tool's writes were not atomic because it was
/// written before the helper existed.
///
/// Adding a tool is now a row here. Nothing else.
///
/// NOT everything lives here on purpose. Budget's data and Kanban's index and
/// board files go through backed_up_write_group instead, because they snapshot
/// what they overwrite, and Kanban's board files can be encrypted. Those are
/// genuinely different jobs, not the same job written out again.
/// One row of the table: what the file is called, what an absent one reads as,
/// and which files are captured together when it is written.
///
/// An EMPTY group means this file is not snapshotted. That is the right answer
/// for a draft (in-progress entry, replaced constantly, meaningless an hour
/// later) and for preferences that are quick to set again. It is the wrong
/// answer for anything you would be upset to lose, which is why the entries and
/// the game history now carry one.
struct ToolFile {
    name: &'static str,
    empty: &'static str,
    /// Captured together, because they are only meaningful as a set. Listing a
    /// file that does not exist is fine: snapshot_group skips it.
    group: &'static [&'static str],
}

/// Time Tracker's entries and the activity/project vocabulary they name. An
/// hour of entries restored beside the list of activities from that same hour
/// is a coherent state; entries alone can point at activities that were since
/// renamed away.
const TT_GROUP: &[&str] =
    &["time-tracker/time-tracker.json", "time-tracker/time-tracker-settings.json"];

const NO_SNAPSHOT: &[&str] = &[];

/// Agent access stands alone: it names boards but holds none of their contents,
/// so restoring it beside a board file would be restoring two unrelated things.
const KANBAN_AGENTS_GROUP: &[&str] = &["kanban/kanban-agents.json"];

fn tool_file(tool_id: &str, kind: &str) -> Result<ToolFile, String> {
    let (name, empty, group) = match (tool_id, kind) {
        ("time-tracker", "settings") => {
            ("time-tracker/time-tracker-settings.json", "{}", TT_GROUP)
        }
        ("time-tracker", "data") => ("time-tracker/time-tracker.json", "[]", TT_GROUP),
        ("time-tracker", "draft") => (
            "time-tracker/time-tracker-draft.json",
            r#"{"activity":"","start":"","end":"","notes":""}"#,
            NO_SNAPSHOT,
        ),
        ("budget", "settings") => ("budget/budget-settings.json", "{}", NO_SNAPSHOT),
        ("kanban", "settings") => ("kanban/kanban-settings.json", "{}", NO_SNAPSHOT),
        /* AGENT ACCESS. Snapshotted, unlike the other preference files, because
           losing it is not "set those switches again": the tokens in it are
           pasted into agent configs elsewhere on the machine, and a lost file
           silently breaks every one of them with no way to tell which. */
        ("kanban", "agents") => (
            "kanban/kanban-agents.json",
            r#"{"enabled":false,"boards":{}}"#,
            KANBAN_AGENTS_GROUP,
        ),
        ("countdown", "data") => {
            ("countdown/countdown.json", r#"{"session":null,"log":[]}"#, NO_SNAPSHOT)
        }
        /* READ ONLY IN PRACTICE. game-stats.json is the pre-database history,
           and the only thing that still opens it is the one-time migration.
           Not snapshotted, because nothing writes it: leaving it in a group
           listed a shelf of .bak files from before the move that no screen
           shows and no restore should put back. The live history is the
           database, and its snapshots are in db.rs. */
        ("game-stats", "data") => (
            "game-stats/game-stats.json",
            r#"{"profiles":[],"games":[],"settings":{}}"#,
            NO_SNAPSHOT,
        ),
        ("game-stats", "settings") => ("game-stats/game-stats-settings.json", "{}", NO_SNAPSHOT),
        ("game-stats", "draft") => ("game-stats/game-stats-draft.json", "null", NO_SNAPSHOT),
        ("rng", "data") => ("rng/rng.json", r#"{"settings":null,"results":[]}"#, NO_SNAPSHOT),
        ("tts-repeater", "data") => (
            "tts-repeater/tts-repeater.json",
            r#"{"settings":null,"presets":[],"display":null}"#,
            NO_SNAPSHOT,
        ),
        ("auto-backup", "data") => (
            "auto-backup/auto-backup.json",
            r#"{"sources":[],"destinations":[],"copySpeed":31457280}"#,
            NO_SNAPSHOT,
        ),
        ("auto-backup", "presets") => ("auto-backup/auto-backup-presets.json", "[]", NO_SNAPSHOT),
        // An allowlist, not a filename built from the arguments. Both of these
        // arrive from the front end and would otherwise be joined onto a path.
        _ => return Err(format!("Unknown tool file '{tool_id}/{kind}'")),
    };
    Ok(ToolFile { name, empty, group })
}

/// The filename part of a tool-file path.
///
/// A snapshot bucket is one FLAT folder: a tool's files are captured into it
/// under their basenames, whatever sub-folder they live in. Every lookup of a
/// .bak has to agree with that, which is why this exists rather than each
/// caller slicing the string.
pub(crate) fn file_basename(relative: &str) -> &str {
    relative.rsplit('/').next().unwrap_or(relative)
}

/// Writes one of a tool's own files. Atomic, like every other write in the app.
#[tauri::command]
fn save_tool_file(
    app: tauri::AppHandle,
    tool_id: String,
    kind: String,
    data: String,
) -> Result<(), String> {
    let f = tool_file(&tool_id, &kind)?;
    if f.group.is_empty() {
        atomic_write(&get_data_path(&app, f.name), data.as_bytes())
    } else {
        // Captures what it is about to overwrite, same as Budget and Kanban.
        backed_up_write_group(&app, f.group, f.name, data.as_bytes())
    }
}

/// Reads one of a tool's own files, or the empty shape that tool expects when
/// there is no file yet. Callers merge that over their own defaults.
#[tauri::command]
fn load_tool_file(app: tauri::AppHandle, tool_id: String, kind: String) -> Result<String, String> {
    let f = tool_file(&tool_id, &kind)?;
    match fs::read_to_string(get_data_path(&app, f.name)) {
        Ok(content) => Ok(content),
        Err(_) => Ok(f.empty.to_string()),
    }
}

/* =============================================================================
   TOOL SNAPSHOTS
   -----------------------------------------------------------------------------
   Browsing and restoring what save_tool_file captured. Kanban has its own pair
   of these because its snapshots can be encrypted and are per board, which is a
   different question to answer; everything else shares this.
============================================================================= */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolBackupFile {
    /// The .bak filename inside the snapshot folder.
    pub(crate) file: String,
    /// Which row of the table it came from, so the front end can label it and
    /// hand the right kind back to restore it.
    pub(crate) kind: String,
    pub(crate) bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolBackup {
    /// The snapshot folder's name: its local timestamp in BACKUP_FOLDER_FORMAT.
    pub(crate) name: String,
    pub(crate) files: Vec<ToolBackupFile>,
}

/// Every snapshot folder holding something this tool owns, newest first.
#[tauri::command]
fn list_tool_backups(app: tauri::AppHandle, tool_id: String) -> Result<Vec<ToolBackup>, String> {
    // Which filenames belong to this tool, and what kind each is. Built from
    // the table so it cannot disagree with what save_tool_file writes.
    let mut owned: Vec<(&'static str, String)> = Vec::new();
    for kind in ["data", "settings", "draft", "presets"] {
        if let Ok(f) = tool_file(&tool_id, kind) {
            if !f.group.is_empty() {
                owned.push((file_basename(f.name), kind.to_string()));
            }
        }
    }
    if owned.is_empty() {
        return Ok(vec![]);
    }

    let root = backups_root(&app, &tool_id);
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        // No backups folder yet is a new install, not an error.
        Err(_) => return Ok(vec![]),
    };

    let mut out: Vec<ToolBackup> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !valid_bucket_name(&name) {
                return None;
            }
            let mut files: Vec<ToolBackupFile> = Vec::new();
            for (filename, kind) in &owned {
                let path = e.path().join(format!("{filename}.bak"));
                if let Ok(meta) = fs::metadata(&path) {
                    files.push(ToolBackupFile {
                        file: format!("{filename}.bak"),
                        kind: kind.clone(),
                        bytes: meta.len(),
                    });
                }
            }
            if files.is_empty() {
                None
            } else {
                Some(ToolBackup { name, files })
            }
        })
        .collect();

    // The folder format sorts correctly as plain strings, so a reversed string
    // sort is a true newest-first ordering with no date parsing.
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// Returns one captured file's contents, WITHOUT writing anything.
///
/// Deliberately a read and not a restore, for the same reason Kanban's is:
/// putting it back is an ordinary save, which snapshots the state being
/// replaced on the way past, so restoring the wrong one is undone by restoring
/// the newest. A command that copied the file into place directly would skip
/// that and make the recovery tool the thing you needed recovering from.
#[tauri::command]
fn read_tool_backup(
    app: tauri::AppHandle,
    tool_id: String,
    name: String,
    kind: String,
) -> Result<String, String> {
    if !valid_bucket_name(&name) {
        return Err("That snapshot name is not one of ours.".to_string());
    }
    // The filename comes from the table rather than from the front end, so
    // nothing arriving here can name a file this tool does not own.
    let f = tool_file(&tool_id, &kind)?;
    if f.group.is_empty() {
        return Err("That file is not snapshotted.".to_string());
    }
    let root = backups_root(&app, &tool_id);
    let path = root.join(&name).join(format!("{}.bak", file_basename(f.name)));
    fs::read_to_string(&path).map_err(|e| format!("Could not read that snapshot: {e}"))
}

/// Snapshot folder names are the local timestamp snapshot_group writes, so digits,
/// dashes and one underscore. Same rule Kanban applies to the same names.
pub(crate) fn valid_bucket_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .chars()
            .all(|c| c.is_ascii_digit() || c == '-' || c == '_')
}

/* =============================================================================
   CUSTOM THEMES COMMANDS  (shell-level)
============================================================================= */

/// Persists the serialized custom themes JSON to disk.
/// The payload is an array of CustomTheme objects serialized by shell.ts.
#[tauri::command]
fn save_custom_themes(app: tauri::AppHandle, data: String) -> Result<(), String> {
    atomic_write(&get_data_path(&app, "app/custom-themes.json"), data.as_bytes())
}

/// Loads the saved custom themes JSON from disk.
/// Returns "[]" (empty array) if no file exists yet, shell.ts treats this
/// as a signal that no custom themes have been created.
#[tauri::command]
fn load_custom_themes(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, "app/custom-themes.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok("[]".to_string()),
    }
}

/* =============================================================================
   SHELL STATE COMMANDS  (shell-level)
============================================================================= */

/// Persists the serialized shell state JSON to disk (active section/tool).
/// Called by shell.ts on every navigation action.
#[tauri::command]
fn save_shell_state(app: tauri::AppHandle, data: String) -> Result<(), String> {
    atomic_write(&get_data_path(&app, "app/shell-state.json"), data.as_bytes())
}

/// Loads the saved shell state JSON from disk.
/// Returns a default state pointing at "home" if no file exists yet.
#[tauri::command]
fn load_shell_state(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, "app/shell-state.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok(r#"{"activeSection":"home"}"#.to_string()),
    }
}

/* =============================================================================
   APP LOCK COMMANDS  (shell-level)
   ---------------------------------------------------------------------------
   The raw credential is NEVER stored. Only the Argon2id hash is written to
   disk in lock.json. All hashing and verification happens in Rust.
============================================================================= */

/// Hashes the supplied credential with Argon2id and persists the hash to disk.
/// Called when the user enables app lock or changes their PIN/password.
/// The credential is wrapped in Zeroizing so its bytes are wiped from memory
/// when this function returns, on every exit path including errors.
#[tauri::command]
fn save_lock_hash(app: tauri::AppHandle, credential: String) -> Result<(), String> {
    let credential = zeroize::Zeroizing::new(credential);
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(credential.as_bytes(), &salt)
        .map_err(|e| e.to_string())?
        .to_string();
    atomic_write(&get_data_path(&app, "app/lock.json"), hash.as_bytes())
}

/// Reads lock.json and returns the stored hash only if it is actually a usable
/// Argon2 PasswordHash. `None` covers all three "there is no working lock here"
/// cases: no file, unreadable file, and a file whose contents don't parse.
///
/// That last case is the reason this exists. A lock.json that is present but
/// truncated or garbled (an interrupted write, a half-restored backup, a
/// hand-edit) used to satisfy lock_is_set()'s bare `.exists()` check while
/// making verify_lock() fail for EVERY credential, including the correct one.
/// The lock screen has no "reset credential" affordance of its own (Change and
/// Remove live in the General Settings modal, which is behind the lock), so the
/// only ways out were the Exit App button or deleting the file by hand. One
/// corrupt file meant a permanently unopenable app.
fn read_valid_lock_hash(app: &tauri::AppHandle) -> Option<String> {
    let stored = fs::read_to_string(get_data_path(app, "app/lock.json")).ok()?;
    let stored = stored.trim().to_string();
    if is_usable_lock_hash(&stored) {
        Some(stored)
    } else {
        None
    }
}

/// Whether `stored` is a hash that verification could actually succeed against.
///
/// Parsing alone is NOT enough, which is the subtle half of this. The PHC
/// string format permits a value carrying algorithm, version, params and salt
/// but no digest, so a lock.json truncated partway through still parses cleanly
/// while being impossible to match any credential against. Requiring both the
/// digest and the salt is what actually distinguishes "a lock" from "the
/// wreckage of one".
fn is_usable_lock_hash(stored: &str) -> bool {
    match PasswordHash::new(stored.trim()) {
        Ok(parsed) => parsed.hash.is_some() && parsed.salt.is_some(),
        Err(_) => false,
    }
}

/// Verifies a supplied credential against the stored Argon2id hash.
/// Returns `true` if it matches, `false` if it doesn't, if no hash is stored,
/// or if the stored hash is unusable. The credential is zeroized on return,
/// see save_lock_hash.
#[tauri::command]
fn verify_lock(app: tauri::AppHandle, credential: String) -> Result<bool, String> {
    let credential = zeroize::Zeroizing::new(credential);
    // Ok(false) rather than Err on a bad hash: an unreadable credential store
    // is "this does not match", not an exceptional condition to surface. The
    // caller (submitPin/submitPassword in lockscreen.ts) treats a rejected
    // promise and a `false` identically anyway.
    let Some(stored) = read_valid_lock_hash(&app) else {
        return Ok(false);
    };
    let Ok(parsed_hash) = PasswordHash::new(&stored) else {
        return Ok(false);
    };
    Ok(Argon2::default()
        .verify_password(credential.as_bytes(), &parsed_hash)
        .is_ok())
}

/// Returns whether a USABLE lock hash is stored, i.e. whether the app should
/// gate on the lock screen at startup. Deliberately not a bare `.exists()`: a
/// corrupt hash is a broken file, not a lock, and treating it as one strands
/// the user outside an app they can no longer unlock (see read_valid_lock_hash).
///
/// This fails open by design. The app lock is a convenience gate on a local
/// single-user tool, not a security boundary: nothing on disk is encrypted, so
/// anyone who can corrupt lock.json can equally read every other data file or
/// simply delete lock.json to the same effect. Refusing to open costs real
/// recoverability and buys no real protection.
#[tauri::command]
fn lock_is_set(app: tauri::AppHandle) -> bool {
    read_valid_lock_hash(&app).is_some()
}

/// Removes the stored lock hash, disabling the lock entirely.
#[tauri::command]
fn clear_lock_hash(app: tauri::AppHandle) -> Result<(), String> {
    let path = get_data_path(&app, "app/lock.json");
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* =============================================================================
   UPDATE CHECK COMMAND  (shell-level)
   -----------------------------------------------------------------------------
   The ONLY outbound network call this app ever makes. Queries the GitHub
   Releases API for the latest published release of this repo and hands the
   tag + release-page URL back to the frontend alongside the running version,
   so the frontend can decide whether to surface an update notice.

   Deliberately narrow: unauthenticated, read-only, and aimed at exactly one
   hardcoded host. There's no token to store, no capability glob to misconfigure,
   and nothing the webview can reach on its own. The request is made here in
   Rust, so the locked-down CSP (connect-src 'self' ipc:) still holds. Runs only
   when the user has opted in (the frontend gates the call on a setting), and it
   fails soft: any network or parse error comes back as Err and the frontend
   stays silent, preserving the offline-by-default behavior.
============================================================================= */

/// Repo slug ("owner/name") the update check queries. This single constant is
/// the app's entire network footprint. The one place to edit if the repo moves.
const GITHUB_REPO: &str = "RailbladeOfficial/Swiss-RB-Knife";

/// GitHub rejects API requests that omit a User-Agent (HTTP 403), so one is
/// always sent. Identifies the app + version. Nothing user-specific.
const UPDATE_CHECK_UA: &str =
    concat!("SwissRBKnife/", env!("CARGO_PKG_VERSION"), " (+update-check)");

/// The subset of the GitHub release payload the frontend needs.
#[derive(serde::Serialize)]
struct UpdateInfo {
    /// Running version, baked in from Cargo at compile time
    /// (e.g. "0.3.3". No leading "v").
    current: String,
    /// Latest release tag exactly as published (e.g. "v0.3.4").
    latest: String,
    /// The release's page URL, opened in the default browser by the frontend.
    html_url: String,
}

/// Fetches the latest GitHub release and returns it with the running version.
/// Blocking (ureq) with short connect/read timeouts; Tauri runs commands on a
/// thread pool, so this never blocks the UI thread. Non-2xx responses (e.g. a
/// 404 when no release exists yet) surface as Err, which the frontend treats
/// as "no update info" and ignores, exactly like a network failure.
#[tauri::command]
fn check_for_updates() -> Result<UpdateInfo, String> {
    let url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        GITHUB_REPO
    );

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(8))
        .timeout_read(std::time::Duration::from_secs(8))
        .build();

    let body = agent
        .get(&url)
        .set("User-Agent", UPDATE_CHECK_UA)
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| e.to_string())?;

    let latest = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "release payload missing tag_name".to_string())?
        .to_string();

    let html_url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(UpdateInfo {
        current: env!("CARGO_PKG_VERSION").to_string(),
        latest,
        html_url,
    })
}

/* =============================================================================
   APP ENTRY POINT
============================================================================= */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(db::Db::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // tauri-plugin-fs intentionally NOT registered. Nothing in the
        // frontend uses it (all file I/O goes through custom commands), so
        // shipping it would only widen the attack surface for no benefit.
        .setup(|app| {
            // FIRST, before any command can read a file: an install from before
            // the data folder had a shape needs its files moved into it.
            migrate_data_layout(app.handle());

            /* WHAT THE WEBVIEW MAY RENDER FROM DISK.
               ---------------------------------------------------------------
               tauri.conf.json declares the asset protocol with an EMPTY scope,
               so out of the box it serves nothing. It used to declare "**",
               which is every file on the machine: a webview that ever ran
               something it should not could then read any file it could name
               by asking for it as an image.

               The app's own data folder is granted here, which covers Kanban's
               attachments and board backgrounds. It is done at runtime rather
               than in the config because the folder is not the same place in a
               dev build as in a release one, and a config pattern can only
               name one of them.

               Image CCR is the one tool that renders files from outside, and
               it grants them one at a time as it opens them. See allow_preview
               in image_ccr.rs. */
            allow_asset_path(app.handle(), &data_root(app.handle()), true);

            session_watch::init(app.handle());

            /* The door an AI agent knocks on, if the user has opened one for a
               board. Started unconditionally: the gate itself checks, on every
               single request, whether any board is open to an agent, so a
               listening pipe with nothing enabled behind it grants nothing. */
            agent_gate::init(app.handle());

            /* A DEV BUILD SAYS SO IN ITS TITLE BAR.
               ---------------------------------------------------------------
               A dev build and an installed one are pixel-identical on screen,
               and they are meant to be run side by side: they keep separate
               data folders and listen on separate agent pipes precisely so
               they can be. The cost of that is that a screenshot, a window
               list or a taskbar entry cannot tell you which one you are
               looking at, and a change checked in the wrong window reads as a
               change that did not work.

               Debug-only, so the installed app is untouched. */
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Swiss RB Knife (dev)");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Shell-level commands
            merge_settings,
            load_settings,
            save_tool_file,
            load_tool_file,
            list_tool_backups,
            export_tool_json,
            import_tool_json,
            read_tool_backup,
            db::list_db_backups,
            db::restore_db_backup,
            save_window_size,
            load_window_size,
            save_shell_state,
            load_shell_state,
            save_custom_themes,
            load_custom_themes,
            check_for_updates,
            // App lock
            save_lock_hash,
            verify_lock,
            lock_is_set,
            clear_lock_hash,
            // Time Tracker
            tools::time_tracker::export_csv,
            tools::time_tracker::import_csv,
            // Image CCR
            tools::image_ccr::get_image_info,
            tools::image_ccr::preview_combine,
            tools::image_ccr::combine_images,
            tools::image_ccr::compress_image,
            tools::image_ccr::show_in_explorer,
            tools::image_ccr::scan_resize_sources,
            tools::image_ccr::resize_images,
            tools::image_ccr::cancel_resize,
            // Dummy File Generator
            tools::file_gen::dfg_generate_files,
            // Auto-Backup
            tools::auto_backup::get_folder_stats,
            tools::auto_backup::get_free_space,
            tools::auto_backup::estimate_backup,
            tools::auto_backup::cancel_estimate,
            tools::auto_backup::validate_backup_config,
            tools::auto_backup::cancel_backup,
            tools::auto_backup::run_backup,
            // Budget Tracker
            tools::budget::save_budget_data,
            tools::budget::load_budget_data,
            tools::budget::save_budget_entities,
            tools::budget::load_budget_entities,
            tools::budget::budget_lock_status,
            tools::budget::budget_verify_password,
            tools::budget::budget_decrypt_to_memory,
            tools::budget::budget_save_encrypted,
            tools::budget::budget_decrypt_entities_to_memory,
            tools::budget::budget_save_entities_encrypted,
            tools::budget::budget_enable_encryption,
            tools::budget::budget_disable_encryption,
            tools::budget::budget_set_session_unlock,
            tools::budget::list_budget_backups,
            tools::budget::restore_budget_backup,
            // Game Stats
            tools::game_stats::read_game_stats_workbook,
            tools::game_stats::write_game_stats_download,
            // TTS Repeater
            tools::tts_repeater::tts_repeater_start_timer,
            tools::tts_repeater::tts_repeater_stop_timer,
            // Countdown
            tools::countdown::countdown_start_ticker,
            tools::countdown::countdown_stop_ticker,
            // Game Stats records (the database)
            tools::game_stats_db::gs_load,
            tools::game_stats_db::gs_save,
            tools::game_stats_db::gs_replace_all,
            tools::game_stats_db::gs_migrate_from_json,
            // Kanban Boards
            tools::kanban::save_kanban_index,
            tools::kanban::load_kanban_index,
            tools::kanban::save_kanban_board,
            tools::kanban::load_kanban_board,
            tools::kanban::delete_kanban_board,
            tools::kanban::list_kanban_backups,
            tools::kanban::read_kanban_backup,
            tools::kanban::import_kanban_image,
            tools::kanban::delete_kanban_image,
            tools::kanban::kanban_backgrounds_dir,
            tools::kanban::kanban_attachments_dir,
            tools::kanban::import_kanban_attachment,
            tools::kanban::paste_kanban_attachment,
            tools::kanban::copy_kanban_attachment,
            tools::kanban::delete_kanban_attachment,
            tools::kanban::delete_kanban_board_attachments,
            tools::kanban::sweep_kanban_attachments,
            tools::kanban::open_kanban_attachment,
            tools::kanban::kanban_attachments_exist,
            tools::kanban::revive_kanban_attachments,
            // Kanban agent access
            agent_gate::kanban_agent_reply,
            agent_gate::kanban_agent_status,
            agent_gate::kanban_agent_test_connection,
            agent_gate::read_kanban_agent_log,
            agent_gate::clear_kanban_agent_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod lock_hash_tests {
    use super::is_usable_lock_hash as is_usable;
    use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
    use argon2::Argon2;

    #[test]
    fn a_real_hash_is_usable() {
        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(b"1234", &salt)
            .unwrap()
            .to_string();
        assert!(is_usable(&hash));
        // Trailing whitespace survives a round trip through a text editor.
        assert!(is_usable(&format!("{hash}
")));
    }

    #[test]
    fn corrupt_contents_are_not_a_lock() {
        // Each of these is a lock.json that EXISTS, which is all the old
        // lock_is_set() checked. Every one of them used to gate the app behind
        // a lock screen that could never be satisfied, with no in-app way out.
        let salt = SaltString::generate(&mut OsRng);
        let real = Argon2::default()
            .hash_password(b"1234", &salt)
            .unwrap()
            .to_string();
        let truncated = &real[..real.len() / 2];

        for bad in ["", "   ", "
", "not-a-hash", "{}", "null", truncated] {
            assert!(
                !is_usable(bad),
                "{bad:?} must not count as a lock, it would strand the user"
            );
        }
    }
}

#[cfg(test)]
mod filename_tests {
    use super::is_reserved_device_name;

    #[test]
    fn flags_reserved_names_regardless_of_case_or_extension() {
        for n in ["CON", "con", "Con", "NUL", "aux", "COM1", "lpt9"] {
            assert!(is_reserved_device_name(n), "{n} should be reserved");
        }
        // The reservation survives any extension, including a compound one.
        for n in ["CON.jpg", "con.txt", "Con.tar.gz", "PRN.csv"] {
            assert!(is_reserved_device_name(n), "{n} should be reserved");
        }
    }

    #[test]
    fn allows_names_that_merely_start_with_a_reserved_word() {
        // These are the false positives a naive "starts_with" check would
        // produce. They are ordinary filenames and must be accepted. The
        // Dummy File Generator composes names exactly like con001.txt from a
        // legitimate "con" prefix.
        for n in [
            "con001.txt", "console.log", "conference.png", "connie.jpg",
            "com10.txt", "lpt0.txt", "nullable.rs", "auxiliary.md", "",
        ] {
            assert!(!is_reserved_device_name(n), "{n} should be allowed");
        }
    }
}
