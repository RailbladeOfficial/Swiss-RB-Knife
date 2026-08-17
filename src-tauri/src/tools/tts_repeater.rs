/* =============================================================================
   TTS REPEATER: persistence + repeat timer
   -----------------------------------------------------------------------------
   Two unrelated jobs, both small:

   1. PERSISTENCE. The last-used form state and the saved presets, stored in
      tts-repeater.json exactly like every other tool's data file (see
      time_tracker.rs / game_stats.rs; all file I/O goes through
      crate::get_data_path so the dev/release directory logic stays in lib.rs).

   2. THE REPEAT TIMER, and this is the part that has to live in Rust rather
      than a setInterval in the frontend. Chromium (and therefore WebView2)
      applies "intensive wake-up throttling" to a hidden page: once the window
      has been minimized/occluded for ~5 minutes, timers are clamped to roughly
      one wake-up per MINUTE. A reminder that repeats every 30 seconds would
      quietly degrade to once a minute precisely when the user isn't looking at
      the app, which is the entire situation this tool exists for. An OS
      thread has no such throttling, so the schedule is kept here and the
      frontend only reacts to ticks.

   Event emitted to the frontend:
     tts-repeater-tick  →  u64 generation (see below)

   Cancellation follows auto_backup.rs's generation-counter pattern rather than
   a plain "should stop" bool: every start bumps TIMER_GENERATION and the new
   thread captures the value. A thread whose captured generation no longer
   matches the global one exits at its next check, so a rapid stop→start (or
   two starts in a row) can never leave two threads emitting ticks at once.
   The generation rides along in the event payload as well, so even a tick
   already in flight when the timer stopped is identifiable as stale by the
   frontend and dropped rather than spoken.

   Rust commands exposed:
     save_tts_repeater_data, load_tts_repeater_data,
     tts_repeater_start_timer, tts_repeater_stop_timer
============================================================================= */

use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

/* =============================================================================
   DATA COMMANDS
============================================================================= */

/// Writes the given JSON string to tts-repeater.json in the data directory.
#[tauri::command]
pub fn save_tts_repeater_data(app: AppHandle, data: String) -> Result<(), String> {
    crate::atomic_write(
        &crate::get_data_path(&app, "tts-repeater.json"),
        data.as_bytes(),
    )
}

/// Reads and returns the contents of tts-repeater.json.
/// Returns an empty root object if the file does not exist.
#[tauri::command]
pub fn load_tts_repeater_data(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(crate::get_data_path(&app, "tts-repeater.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok(r#"{"settings":null,"presets":[],"display":null}"#.to_string()),
    }
}

/* =============================================================================
   REPEAT TIMER
============================================================================= */

/// Bumped on every start and every stop. A running timer thread exits as soon
/// as it sees a value other than the one it captured.
static TIMER_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Interval bounds, enforced here as well as in the frontend. The frontend's
/// check is for the error message, this one is so a bad value can never spawn
/// a thread that spins.
const MIN_INTERVAL_MS: u64 = 1_000;
const MAX_INTERVAL_MS: u64 = 24 * 60 * 60 * 1_000; // 24 hours

/// How long the thread sleeps between cancellation checks. Short enough that
/// Stop feels instant even on a 24-hour interval, long enough that the thread
/// is asleep essentially all of the time.
const CANCEL_CHECK_MS: u64 = 200;

/// Starts (or restarts) the repeat timer, emitting "tts-repeater-tick" every
/// `interval_ms`. Does NOT emit an immediate first tick. The frontend speaks
/// once itself on Start, so that the very first utterance has no IPC
/// round-trip in front of it.
///
/// `one_shot` picks which of the tool's two timing modes this run is in:
///   • false, "from the start of each message": a free-running repeat, so a
///     repetition lands every `interval_ms` regardless of how long the speech
///     itself takes.
///   • true:  "after each message finishes": emit exactly one tick and exit.
///     The gap can't be scheduled up front there, because it only begins when
///     the utterance ends, which is something only the frontend can observe.
///     It re-arms with a fresh one-shot after every utterance.
///
/// Returns the generation this run claimed. The frontend keeps it and ignores
/// any tick carrying a different one, which is what makes a stop→start faster
/// than the outgoing thread's cancellation check safe: the old thread's last
/// tick arrives stamped with the old generation and is dropped instead of
/// speaking an extra time against the new run.
#[tauri::command]
pub fn tts_repeater_start_timer(
    app: AppHandle,
    interval_ms: u64,
    one_shot: bool,
) -> Result<u64, String> {
    if !(MIN_INTERVAL_MS..=MAX_INTERVAL_MS).contains(&interval_ms) {
        return Err(format!(
            "Interval must be between {} and {} milliseconds.",
            MIN_INTERVAL_MS, MAX_INTERVAL_MS
        ));
    }

    // Claim a generation. Any thread still running from a previous start is
    // now stale and will exit on its next check.
    let generation = TIMER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let interval = Duration::from_millis(interval_ms);

    thread::spawn(move || {
        // Each deadline is derived from the PREVIOUS deadline rather than from
        // "now", so the few milliseconds each wake-up overshoots by are not
        // carried into the next one, a 30-second repeat is still on the
        // 30-second mark hours later.
        let mut deadline = Instant::now() + interval;

        loop {
            loop {
                if TIMER_GENERATION.load(Ordering::SeqCst) != generation {
                    return;
                }
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                // Never sleep past the deadline, and never past the next
                // cancellation check.
                thread::sleep((deadline - now).min(Duration::from_millis(CANCEL_CHECK_MS)));
            }

            // Re-check after waking: Stop may have landed during the final
            // sleep slice, and a tick emitted after that would speak once more
            // than the user asked for.
            if TIMER_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }

            // A failed emit means the window is gone. Nothing left to tick for.
            if app.emit("tts-repeater-tick", generation).is_err() {
                return;
            }

            if one_shot {
                return;
            }

            deadline += interval;

            // Catch-up suppression. If the machine slept through several
            // intervals, every missed deadline is now in the past and the loop
            // above would fire them back-to-back. The user resumes to a burst
            // of repetitions all at once. Dropping what was missed costs the
            // resume exactly one repetition instead. (Whether Instant advances
            // across a Windows sleep is hardware-dependent; this is correct
            // either way, if the clock halted, nothing was missed and this is
            // a no-op.)
            let now = Instant::now();
            if deadline <= now {
                deadline = now + interval;
            }
        }
    });

    Ok(generation)
}

/// Stops the repeat timer. Safe to call when nothing is running.
#[tauri::command]
pub fn tts_repeater_stop_timer() {
    TIMER_GENERATION.fetch_add(1, Ordering::SeqCst);
}
