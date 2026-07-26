/* =============================================================================
   LIB  — Swiss RB Knife Tauri backend
   -----------------------------------------------------------------------------
   Application entry point and command registry. Owns:

     • get_data_path()  — resolves the per-user data directory (dev vs release);
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
use chrono::{TimeZone, Utc};
// Manager is only referenced inside the #[cfg(not(debug_assertions))] branch of
// get_data_path() — the compiler sees it as unused in debug builds and warns.
// The allow suppresses that spurious warning without removing the import.
#[allow(unused_imports)]
use tauri::Manager;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

mod tools;

/* =============================================================================
   FILE PATHS
============================================================================= */

/// Resolves the path to a named file in the app data directory.
///
/// - **Dev builds** (`debug_assertions` on): resolves to `../data/` relative to
///   the Cargo workspace root, so data files sit next to `src-tauri/` and are
///   easy to inspect during development.
/// - **Release builds**: resolves to the OS app-data directory via Tauri's
///   `app_data_dir()` (e.g. `%APPDATA%\Swiss RB Knife\` on Windows).
///
/// Creates the directory if it doesn't exist in either case.
#[allow(unused_variables)]
pub(crate) fn get_data_path(app: &tauri::AppHandle, filename: &str) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let mut path = std::env::current_dir().unwrap();
        path.pop();
        path.push("data");
        let _ = std::fs::create_dir_all(&path);
        path.push(filename);
        return path;
    }

    #[cfg(not(debug_assertions))]
    {
        let mut path = app
            .path()
            .app_data_dir()
            .expect("Failed to resolve app data dir");
        let _ = std::fs::create_dir_all(&path);
        path.push(filename);
        return path;
    }
}

/* =============================================================================
   SYSTEM BINARY PATHS
   -----------------------------------------------------------------------------
   This app ships with an elevated (requireAdministrator) manifest, so every
   child process it launches inherits the admin token. Spawning system tools by
   bare name ("robocopy", "powershell", …) resolves them through the normal
   Windows search order — which includes the application directory and the
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
   SAFE FILE WRITES
============================================================================= */

/// Writes `bytes` to `path` without ever leaving a half-written file behind.
/// Writes to a sibling temp file first, fsyncs it, then renames it over the
/// real path — the rename is a single atomic filesystem operation (on Windows
/// this uses MoveFileExW with MOVEFILE_REPLACE_EXISTING under the hood).
///
/// This matters specifically because of how Windows installers upgrade an
/// app: the old process is force-terminated (not asked to close gracefully)
/// so the installer can overwrite the .exe. If that termination lands mid
/// fs::write(), a plain write leaves a truncated file — the previous good
/// data is gone and the new data never fully landed either. Every tool's
/// save path must go through this helper, not fs::write() directly.
///
/// Two hardening details beyond the basic temp-then-rename pattern:
///
/// • sync_all() before the rename. Without it, a power loss can leave the
///   RENAME on disk while the temp file's CONTENTS never made it out of the
///   OS cache — a valid-looking but truncated file sitting behind the very
///   mechanism meant to prevent exactly that. The fsync forces the bytes to
///   storage before the name swap can possibly land.
///
/// • A unique temp name per call (pid + counter) instead of a fixed ".tmp"
///   suffix. Tauri runs sync commands on a thread pool, so two overlapping
///   saves targeting the same file are possible — with a shared temp name
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

    // Any failure past this point must clean up the temp file — a graveyard
    // of orphaned .tmp-* files in the data dir helps nobody.
    let write_result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file); // release the handle before rename — required on Windows
        fs::rename(&tmp_path, path).map_err(|e| e.to_string())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

/// Width of each backup bucket, in seconds. Every write within the same
/// bucket refreshes that bucket's snapshot rather than creating a new one —
/// deliberately coarse, since the goal is surviving corruption discovered
/// days or weeks later, not per-edit undo history.
const BACKUP_MIN_INTERVAL_SECS: i64 = 3600;
/// How many historical buckets to retain before pruning the oldest.
const BACKUP_KEEP_COUNT: usize = 30;

/// Folder-name format for backup snapshots: sorts correctly as plain strings
/// (matches chronological order) and is readable in a file browser without
/// translating a Unix timestamp. Always UTC — a snapshot taken at 2pm local
/// won't necessarily show "14" here unless you're on UTC.
const BACKUP_FOLDER_FORMAT: &str = "%Y-%m-%d_%H-%M-%S";

/// Writes `write_bytes` to `write_filename` atomically, but first captures
/// the CURRENT on-disk contents of every file in `group_filenames` together
/// into a timestamped folder: `backups/<bucket-start>/<filename>.bak` for
/// each file that currently exists.
///
/// Snapshots are bucketed into BACKUP_MIN_INTERVAL_SECS-wide windows rather
/// than "skip for an hour after the last one" — every write within the same
/// bucket overwrites that bucket's snapshot with the latest pre-write state,
/// so the folder always reflects the MOST RECENT state as of the end of
/// that window, not whatever was on disk when the window started. A cooldown
/// that only fires on the first write of a burst would otherwise miss
/// everything after it: if you edit for 50 minutes and then don't touch the
/// app again for a week, that 50 minutes needs to be the thing that's
/// backed up, not the state from before it started.
///
/// The whole point of grouping is that files like budget-data.enc and
/// budget-lock.json only mean anything as a matched pair — the salt in one
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
    snapshot_group(&group_paths);
    atomic_write(&get_data_path(app, write_filename), write_bytes)
}

fn snapshot_group(group_paths: &[PathBuf]) {
    let backups_root = match group_paths.first().and_then(|p| p.parent()) {
        Some(p) => p.join("backups"),
        None => return,
    };
    if fs::create_dir_all(&backups_root).is_err() {
        return;
    }

    // Only files that actually exist get captured — e.g. on the very
    // first-ever write there's nothing to back up yet.
    let files_to_snapshot: Vec<(PathBuf, Vec<u8>)> = group_paths
        .iter()
        .filter_map(|p| fs::read(p).ok().map(|bytes| (p.clone(), bytes)))
        .collect();
    if files_to_snapshot.is_empty() {
        return;
    }

    let bucket_start_secs = (Utc::now().timestamp() / BACKUP_MIN_INTERVAL_SECS) * BACKUP_MIN_INTERVAL_SECS;
    let bucket_name = match Utc.timestamp_opt(bucket_start_secs, 0).single() {
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
        // Overwrites on purpose — every write within this bucket refreshes
        // it to the latest pre-write state, so by the time the bucket
        // closes it holds the last state before the gap, not the first.
        let _ = fs::write(snapshot_dir.join(format!("{filename}.bak")), bytes);
    }

    // Prune to the newest BACKUP_KEEP_COUNT buckets. Cheap enough (a
    // directory listing of ~30 entries) to just do on every write rather
    // than tracking whether this call started a new bucket.
    let mut existing_buckets: Vec<String> = fs::read_dir(&backups_root)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    existing_buckets.sort(); // format sorts correctly as plain strings
    if existing_buckets.len() > BACKUP_KEEP_COUNT {
        for old_name in &existing_buckets[..existing_buckets.len() - BACKUP_KEEP_COUNT] {
            let _ = fs::remove_dir_all(backups_root.join(old_name));
        }
    }
}

/* =============================================================================
   WINDOW SIZE COMMANDS  (shell-level)
============================================================================= */

/// Persists the serialised window size JSON to disk.
/// Called by shell.ts on every window resize (debounced 300 ms).
#[tauri::command]
fn save_window_size(app: tauri::AppHandle, data: String) -> Result<(), String> {
    atomic_write(&get_data_path(&app, "window.json"), data.as_bytes())
}

/// Loads the saved window size JSON from disk.
/// Returns an error string ("no saved size") if the file doesn't exist yet,
/// which shell.ts treats as a signal to use the tauri.conf.json defaults.
#[tauri::command]
fn load_window_size(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, "window.json")) {
        Ok(content) => Ok(content),
        Err(_) => Err("no saved size".to_string()),
    }
}

/* =============================================================================
   SETTINGS COMMANDS  (shell-level)
============================================================================= */

/// Persists the serialised settings JSON to disk, replacing the whole file.
/// DEPRECATED for multi-owner use: settings.json has several writers (shell,
/// Time Tracker, Budget), and whole-file writes from any one of them clobber
/// the others' keys — use merge_settings instead. Kept registered for
/// backward compatibility.
#[tauri::command]
fn save_settings(app: tauri::AppHandle, data: String) -> Result<(), String> {
    atomic_write(&get_data_path(&app, "settings.json"), data.as_bytes())
}

/// Merges a JSON patch into settings.json: only the TOP-LEVEL keys present in
/// the patch are written; every other key on disk is preserved untouched.
///
/// This is the only safe way to write a file with multiple owners. Each
/// subsystem (shell, Time Tracker, Budget) patches exactly the keys it owns,
/// so none of them can erase another's — which is precisely the bug this
/// replaces: the shell's whole-file saves were silently wiping the tools'
/// settings keys on every Settings-modal change.
///
/// The read-merge-write runs under a process-wide mutex, closing the
/// interleaving window where two near-simultaneous saves could each read the
/// same starting state and the second write would drop the first's keys.
#[tauri::command]
fn merge_settings(app: tauri::AppHandle, patch: String) -> Result<(), String> {
    use std::sync::Mutex;
    static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
    let _guard = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;

    let path = get_data_path(&app, "settings.json");

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
/// Returns `"{}"` (empty object) if the file doesn't exist — shell.ts then
/// merges over DEFAULT_SETTINGS so every key gets a safe fallback value.
#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, "settings.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok("{}".to_string()),
    }
}

/* =============================================================================
   PER-TOOL SETTINGS COMMANDS
   -----------------------------------------------------------------------------
   Each tool's settings live in that tool's OWN file — settings.json belongs
   to the shell (General Settings) alone. One file, one owner: the entire
   class of "writer A's save erases writer B's keys" becomes structurally
   impossible, instead of merely being avoided by merge discipline.
============================================================================= */

/// Maps a tool id to its settings filename. An allowlist rather than string
/// interpolation, so the frontend can never address an arbitrary file.
fn tool_settings_filename(tool_id: &str) -> Result<&'static str, String> {
    match tool_id {
        "time-tracker" => Ok("time-tracker-settings.json"),
        "budget"       => Ok("budget-settings.json"),
        _ => Err(format!("Unknown tool id '{}'", tool_id)),
    }
}

/// Persists a tool's settings JSON to that tool's own settings file.
#[tauri::command]
fn save_tool_settings(app: tauri::AppHandle, tool_id: String, data: String) -> Result<(), String> {
    let filename = tool_settings_filename(&tool_id)?;
    atomic_write(&get_data_path(&app, filename), data.as_bytes())
}

/// Loads a tool's settings JSON. Returns "{}" if the file doesn't exist —
/// callers merge over their defaults (and fall back to migrating any legacy
/// keys still living in settings.json from before the split).
#[tauri::command]
fn load_tool_settings(app: tauri::AppHandle, tool_id: String) -> Result<String, String> {
    let filename = tool_settings_filename(&tool_id)?;
    match fs::read_to_string(get_data_path(&app, filename)) {
        Ok(content) => Ok(content),
        Err(_) => Ok("{}".to_string()),
    }
}

/* =============================================================================
   CUSTOM THEMES COMMANDS  (shell-level)
============================================================================= */

/// Persists the serialised custom themes JSON to disk.
/// The payload is an array of CustomTheme objects serialised by shell.ts.
#[tauri::command]
fn save_custom_themes(app: tauri::AppHandle, data: String) -> Result<(), String> {
    atomic_write(&get_data_path(&app, "custom-themes.json"), data.as_bytes())
}

/// Loads the saved custom themes JSON from disk.
/// Returns "[]" (empty array) if no file exists yet — shell.ts treats this
/// as a signal that no custom themes have been created.
#[tauri::command]
fn load_custom_themes(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, "custom-themes.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok("[]".to_string()),
    }
}

/* =============================================================================
   SHELL STATE COMMANDS  (shell-level)
============================================================================= */

/// Persists the serialised shell state JSON to disk (active section/tool).
/// Called by shell.ts on every navigation action.
#[tauri::command]
fn save_shell_state(app: tauri::AppHandle, data: String) -> Result<(), String> {
    atomic_write(&get_data_path(&app, "shell-state.json"), data.as_bytes())
}

/// Loads the saved shell state JSON from disk.
/// Returns a default state pointing at "home" if no file exists yet.
#[tauri::command]
fn load_shell_state(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, "shell-state.json")) {
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
    atomic_write(&get_data_path(&app, "lock.json"), hash.as_bytes())
}

/// Verifies a supplied credential against the stored Argon2id hash.
/// Returns `true` if it matches, `false` if it doesn't or no hash is stored.
/// The credential is zeroized on return — see save_lock_hash.
#[tauri::command]
fn verify_lock(app: tauri::AppHandle, credential: String) -> Result<bool, String> {
    let credential = zeroize::Zeroizing::new(credential);
    let path = get_data_path(&app, "lock.json");
    let stored = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    let parsed_hash = PasswordHash::new(stored.trim()).map_err(|e| e.to_string())?;
    Ok(Argon2::default()
        .verify_password(credential.as_bytes(), &parsed_hash)
        .is_ok())
}

/// Returns whether a lock hash file exists on disk (i.e. lock has been set up).
#[tauri::command]
fn lock_is_set(app: tauri::AppHandle) -> bool {
    get_data_path(&app, "lock.json").exists()
}

/// Removes the stored lock hash, disabling the lock entirely.
#[tauri::command]
fn clear_lock_hash(app: tauri::AppHandle) -> Result<(), String> {
    let path = get_data_path(&app, "lock.json");
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* =============================================================================
   APP ENTRY POINT
============================================================================= */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // tauri-plugin-fs intentionally NOT registered — nothing in the
        // frontend uses it (all file I/O goes through custom commands), so
        // shipping it would only widen the attack surface for no benefit.
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![
            // Shell-level commands
            save_settings,
            merge_settings,
            load_settings,
            save_tool_settings,
            load_tool_settings,
            save_window_size,
            load_window_size,
            save_shell_state,
            load_shell_state,
            save_custom_themes,
            load_custom_themes,
            // App lock
            save_lock_hash,
            verify_lock,
            lock_is_set,
            clear_lock_hash,
            // Time Tracker
            tools::time_tracker::save_data,
            tools::time_tracker::load_data,
            tools::time_tracker::save_draft,
            tools::time_tracker::load_draft,
            tools::time_tracker::export_csv,
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
            tools::auto_backup::save_backup_config,
            tools::auto_backup::load_backup_config,
            tools::auto_backup::get_folder_stats,
            tools::auto_backup::get_free_space,
            tools::auto_backup::estimate_backup,
            tools::auto_backup::cancel_estimate,
            tools::auto_backup::validate_backup_config,
            tools::auto_backup::cancel_backup,
            tools::auto_backup::run_backup,
            tools::auto_backup::save_backup_presets,
            tools::auto_backup::load_backup_presets,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
