/* =============================================================================
   RNGESUS (random number generator): persistence
   -----------------------------------------------------------------------------
   Settings and the current pool of generated numbers, in rng.json, same as
   every other tool's data file.

   THE NUMBERS THEMSELVES ARE NOT GENERATED HERE, and that is deliberate. The
   frontend draws them from the WebView's CSPRNG (crypto.getRandomValues), which
   is the same class of source a Rust-side generator would use, so moving the
   draw across the boundary would buy nothing but a round trip per number. What
   the backend is for is the part the frontend cannot do: putting the pool on
   disk so a run of results survives closing the app.

   Saving the results at all is the point of the tool's "keep history" mode. A
   list of numbers you have to be able to reconstruct later is worth nothing if
   it evaporates with the window, and re-rolling is not a reconstruction: the
   numbers would be different ones.

   Rust commands exposed:
     save_rng_data, load_rng_data
============================================================================= */

use std::fs;

use tauri::AppHandle;

/// Writes the given JSON string to rng.json in the data directory.
#[tauri::command]
pub fn save_rng_data(app: AppHandle, data: String) -> Result<(), String> {
    crate::atomic_write(&crate::get_data_path(&app, "rng.json"), data.as_bytes())
}

/// Reads and returns the contents of rng.json.
/// Returns an empty pool if the file does not exist, which the frontend reads
/// as "first run" and fills in from its own defaults.
#[tauri::command]
pub fn load_rng_data(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(crate::get_data_path(&app, "rng.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok(r#"{"settings":null,"results":[]}"#.to_string()),
    }
}
