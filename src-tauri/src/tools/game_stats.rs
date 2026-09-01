/* =============================================================================
   GAME STATS: persistence commands
   -----------------------------------------------------------------------------
   Tauri commands for loading/saving Game Stats data (profiles, game instances,
   settings) and the in-progress New Game draft. All file I/O uses
   crate::get_data_path() from lib.rs so the dev/release directory logic lives
   in exactly one place.

   Data files:
     game-stats.json:        { profiles, games, settings } root object
     game-stats-draft.json:  in-progress New Game entry state

   Rust commands exposed:
     save_data, load_data, save_draft, load_draft,
     read_workbook (spreadsheet import), write_download (template export)
============================================================================= */

use std::fs;

/// Import ceiling. A real .xlsx game log is measured in single-digit MB (the
/// author's own 175-game workbook, charts and all, is 1.4 MB), so this is
/// generous. Its job is to turn "picked the wrong file" into a clear message
/// instead of an out-of-memory crash. The file is base64'd for transport,
/// which inflates it by a further ~33% before the frontend ever sees it.
const MAX_IMPORT_WORKBOOK_BYTES: u64 = 64 * 1024 * 1024;

/* =============================================================================
   DATA COMMANDS
============================================================================= */



/* =============================================================================
   DRAFT COMMANDS
   -----------------------------------------------------------------------------
   The New Game screen's in-progress entry, persisted so closing the app
   mid-entry doesn't lose it. Separate file from game-stats.json on purpose: a
   draft is not yet a game, and must never be mixed into the saved history.
============================================================================= */



/* =============================================================================
   SPREADSHEET IMPORT / TEMPLATE EXPORT

   Both commands move raw bytes, because .xlsx is a ZIP archive rather than
   text. They deliberately know nothing about the spreadsheet format itself.
   The ZIP and sheet-XML handling all lives in the frontend (game-stats-xlsx.ts),
   where the WebView already provides DecompressionStream for the inflate.

   Bytes cross the IPC boundary base64-encoded. Tauri serializes a Vec<u8> as a
   JSON array of decimal numbers, which costs roughly 4 bytes of transport per
   byte of payload; base64 costs 1.33 and is a plain string on both sides.
============================================================================= */

/// Reads a user-picked spreadsheet and returns it base64-encoded.
///
/// The size is checked from the metadata BEFORE reading, because the file gets
/// copied several times on its way to the frontend (into this Vec, into the
/// base64 String, into the IPC response, into a JS string, back into bytes).
/// Rejecting up front turns a would-be out-of-memory kill into a message the
/// user can act on.
#[tauri::command]
pub fn read_game_stats_workbook(path: String) -> Result<String, String> {
    let size = fs::metadata(&path)
        .map_err(|e| format!("Could not read file: {e}"))?
        .len();
    if size > MAX_IMPORT_WORKBOOK_BYTES {
        return Err(format!(
            "That file is {:.1} MB. The import limit is {} MB. Check you picked the right file.",
            size as f64 / (1024.0 * 1024.0),
            MAX_IMPORT_WORKBOOK_BYTES / (1024 * 1024)
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("Could not read file: {e}"))?;
    Ok(crate::base64_encode(&bytes))
}

/// Writes a base64-encoded file to the user's Downloads folder, returning the
/// full path it landed at. Mirrors time_tracker::export_csv, but for binary.
#[tauri::command]
pub fn write_game_stats_download(
    app: tauri::AppHandle,
    filename: String,
    data_base64: String,
) -> Result<String, String> {
    let safe_name = crate::sanitize_filename(&filename)?;
    let bytes = crate::base64_decode(&data_base64)
        .map_err(|_| "Malformed data: the file could not be written.".to_string())?;

    use tauri::Manager;
    let downloads = app.path().download_dir().map_err(|e| e.to_string())?;
    let path = downloads.join(&safe_name);
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

