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

/// Writes the given JSON string to game-stats.json in the data directory.
#[tauri::command]
pub fn save_game_stats_data(app: tauri::AppHandle, data: String) -> Result<(), String> {
    crate::atomic_write(&crate::get_data_path(&app, "game-stats.json"), data.as_bytes())
}

/// Reads and returns the contents of game-stats.json.
/// Returns an empty root object if the file does not exist.
#[tauri::command]
pub fn load_game_stats_data(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(crate::get_data_path(&app, "game-stats.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok(r#"{"profiles":[],"games":[],"settings":{}}"#.to_string()),
    }
}

/* =============================================================================
   DRAFT COMMANDS
   -----------------------------------------------------------------------------
   The New Game screen's in-progress entry, persisted so closing the app
   mid-entry doesn't lose it. Separate file from game-stats.json on purpose: a
   draft is not yet a game, and must never be mixed into the saved history.
============================================================================= */

/// Saves the current New Game entry draft state to game-stats-draft.json.
#[tauri::command]
pub fn save_game_stats_draft(app: tauri::AppHandle, data: String) -> Result<(), String> {
    crate::atomic_write(&crate::get_data_path(&app, "game-stats-draft.json"), data.as_bytes())
}

/// Reads the saved draft state. Returns null if no draft exists.
#[tauri::command]
pub fn load_game_stats_draft(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(crate::get_data_path(&app, "game-stats-draft.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok("null".to_string()),
    }
}

/* =============================================================================
   SPREADSHEET IMPORT / TEMPLATE EXPORT

   Both commands move raw bytes, because .xlsx is a ZIP archive rather than
   text. They deliberately know nothing about the spreadsheet format itself.
   The ZIP and sheet-XML handling all lives in the frontend (game-stats-xlsx.ts),
   where the WebView already provides DecompressionStream for the inflate.

   Bytes cross the IPC boundary base64-encoded. Tauri serialises a Vec<u8> as a
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
    Ok(base64_encode(&bytes))
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
    let bytes = base64_decode(&data_base64)?;

    use tauri::Manager;
    let downloads = app.path().download_dir().map_err(|e| e.to_string())?;
    let path = downloads.join(&safe_name);
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) as usize & 63] as char);
        // The tail is padded rather than truncated so the output round-trips
        // through any standards-compliant decoder, not just this file's.
        out.push(if chunk.len() > 1 { BASE64_ALPHABET[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { BASE64_ALPHABET[triple as usize & 63] as char } else { '=' });
    }
    out
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for ch in text.bytes() {
        // Whitespace is skipped so a line-wrapped payload still decodes.
        if ch == b'\r' || ch == b'\n' || ch == b' ' || ch == b'\t' || ch == b'=' {
            continue;
        }
        let value = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("Malformed data: the file could not be written.".to_string()),
        } as u32;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}
