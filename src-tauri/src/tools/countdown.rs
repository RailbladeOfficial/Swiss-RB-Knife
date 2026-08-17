/* =============================================================================
   COUNTDOWN: persistence + display ticker
   -----------------------------------------------------------------------------
   1. PERSISTENCE. The running session (if any) and the completed-session log,
      in countdown.json, same as every other tool's data file. Because a
      session is stored as an ABSOLUTE end timestamp rather than a remaining
      duration, closing and reopening the app resumes a countdown at the right
      number instead of the number it had when the app died.

   2. THE DISPLAY TICKER, and this is the part that has to be here rather than
      a setInterval in the frontend. The whole point of this tool is being
      screen-shared while the user goes and does something else: the window is
      visible to the viewers but unfocused, and quite possibly occluded by
      whatever the user is actually working in. Chromium treats an occluded
      window as a hidden page and clamps its timers to roughly one wake-up per
      minute, so the shared countdown would visibly freeze for the audience,
      exactly the failure the user described in other timer apps. An OS thread
      has no such throttling.

      Note the split of responsibilities: correctness never depends on this
      ticker at all, because the frontend computes remaining time from the
      absolute end timestamp on every paint. A late tick shows the right
      number late; it never shows a wrong number. The ticker exists purely to
      guarantee the paint keeps happening.

   Event emitted to the frontend:
     countdown-tick  →  u64 generation (see below)

   Cancellation uses the same generation-counter pattern as tts_repeater.rs:
   every start bumps COUNTDOWN_GENERATION and the new thread captures the
   value, so a thread whose generation no longer matches exits at its next
   check and a rapid stop→start can never leave two tickers running. This
   counter is separate from the TTS Repeater's. The two tools time
   independent things and must be able to run at once.

   Rust commands exposed:
     save_countdown_data, load_countdown_data,
     countdown_start_ticker, countdown_stop_ticker
============================================================================= */

use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

/* =============================================================================
   DATA COMMANDS
============================================================================= */

/// Writes the given JSON string to countdown.json in the data directory.
#[tauri::command]
pub fn save_countdown_data(app: AppHandle, data: String) -> Result<(), String> {
    crate::atomic_write(
        &crate::get_data_path(&app, "countdown.json"),
        data.as_bytes(),
    )
}

/// Reads and returns the contents of countdown.json.
/// Returns an empty root object if the file does not exist.
#[tauri::command]
pub fn load_countdown_data(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(crate::get_data_path(&app, "countdown.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok(r#"{"session":null,"log":[]}"#.to_string()),
    }
}

/* =============================================================================
   DISPLAY TICKER
============================================================================= */

static COUNTDOWN_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Ticker bounds. The floor keeps a bad value from spinning a core; the
/// ceiling is generous because this only ever drives a repaint.
const MIN_TICK_MS: u64 = 50;
const MAX_TICK_MS: u64 = 60_000;

/// Starts (or restarts) the display ticker, emitting "countdown-tick" every
/// `interval_ms` until stopped. Returns the generation this run claimed; the
/// frontend keeps it and ignores ticks carrying any other value, so a ticker
/// being torn down can't drive a repaint for the run that replaced it.
#[tauri::command]
pub fn countdown_start_ticker(app: AppHandle, interval_ms: u64) -> Result<u64, String> {
    if !(MIN_TICK_MS..=MAX_TICK_MS).contains(&interval_ms) {
        return Err(format!(
            "Tick interval must be between {} and {} milliseconds.",
            MIN_TICK_MS, MAX_TICK_MS
        ));
    }

    let generation = COUNTDOWN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let interval = Duration::from_millis(interval_ms);

    thread::spawn(move || {
        // Derived from the previous deadline rather than from "now", so the
        // small overshoot of each wake-up doesn't accumulate.
        let mut deadline = Instant::now() + interval;

        loop {
            loop {
                if COUNTDOWN_GENERATION.load(Ordering::SeqCst) != generation {
                    return;
                }
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                thread::sleep(deadline - now);
            }

            if COUNTDOWN_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }

            // A failed emit means the window is gone. Nothing left to paint.
            if app.emit("countdown-tick", generation).is_err() {
                return;
            }

            deadline += interval;

            // Catch-up suppression: after a sleep/hibernate every missed
            // deadline is in the past, and firing them back-to-back would be a
            // burst of pointless repaints. One is enough. The frontend reads
            // the clock, not the tick count.
            let now = Instant::now();
            if deadline <= now {
                deadline = now + interval;
            }
        }
    });

    Ok(generation)
}

/// Stops the display ticker. Safe to call when nothing is running.
#[tauri::command]
pub fn countdown_stop_ticker() {
    COUNTDOWN_GENERATION.fetch_add(1, Ordering::SeqCst);
}
