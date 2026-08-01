/* =============================================================================
   TIME TRACKER  — persistence commands
   -----------------------------------------------------------------------------
   Tauri commands for loading/saving Time Tracker entries, the input draft,
   and exporting CSV reports. All file I/O uses crate::get_data_path() from
   lib.rs so the dev/release directory logic lives in exactly one place.

   Data files:
     time-tracker.json  — entry array (written on every add/delete/edit)
     draft.json         — current input field state (debounced auto-save)

   Rust commands exposed:
     save_data, load_data, save_draft, load_draft, export_csv
============================================================================= */

use std::fs;

// Manager is needed here so the compiler resolves .path() on AppHandle
// in export_csv's call to app.path().download_dir().
#[allow(unused_imports)]
use tauri::Manager;

/* =============================================================================
   ENTRY DATA COMMANDS
============================================================================= */

/// Writes the given JSON string to time-tracker.json in the data directory.
#[tauri::command]
pub fn save_data(app: tauri::AppHandle, data: String) -> Result<(), String> {
    crate::atomic_write(&crate::get_data_path(&app, "time-tracker.json"), data.as_bytes())
}

/// Reads and returns the contents of time-tracker.json.
/// Returns an empty JSON array string if the file does not exist.
#[tauri::command]
pub fn load_data(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(crate::get_data_path(&app, "time-tracker.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok("[]".to_string()),
    }
}

/* =============================================================================
   DRAFT COMMANDS
============================================================================= */

/// Saves the current input field draft state to draft.json.
#[tauri::command]
pub fn save_draft(app: tauri::AppHandle, data: String) -> Result<(), String> {
    crate::atomic_write(&crate::get_data_path(&app, "draft.json"), data.as_bytes())
}

/// Reads the saved draft state. Returns empty fields if file does not exist.
#[tauri::command]
pub fn load_draft(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(crate::get_data_path(&app, "draft.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok(r#"{"activity":"","start":"","end":"","notes":""}"#.to_string()),
    }
}

/* =============================================================================
   CSV IMPORT
============================================================================= */

/// Reads the contents of a user-selected CSV file. The path comes from the
/// OS-native file picker (plugin-dialog on the frontend), so no additional
/// validation is needed here beyond what fs::read_to_string already gives —
/// same trust boundary as the path-taking commands in the other tools.
#[tauri::command]
pub fn import_csv(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Could not read file: {e}"))
}

/* =============================================================================
   CSV EXPORT
============================================================================= */

/// Writes a CSV report to the user's Downloads folder.
/// Returns the full path the file was written to.
///
/// The filename is sanitized at this boundary rather than trusted: the join
/// below would otherwise honor path separators and "..", letting a filename
/// escape the Downloads folder entirely. The frontend only ever sends safe
/// generated names today — this guard exists so that never has to stay true.
#[tauri::command]
pub fn export_csv(app: tauri::AppHandle, filename: String, data: String) -> Result<String, String> {
    let safe_name = sanitize_filename(&filename)?;

    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| e.to_string())?;

    let path = downloads.join(&safe_name);
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Rejects any filename that could resolve outside the target folder or that
/// Windows can't create: path separators, "..", illegal characters, control
/// characters, and empty names.
fn sanitize_filename(filename: &str) -> Result<String, String> {
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
    Ok(name.to_string())
}
