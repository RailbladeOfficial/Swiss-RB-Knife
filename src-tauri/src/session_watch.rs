/* =============================================================================
   SESSION WATCH: Windows OS session lock/unlock detection
   -----------------------------------------------------------------------------
   The frontend needs to know when the WINDOWS SESSION locks (Win+L, the
   hardware lock key, idle lock, "Switch user"), not just when this app's own
   window loses focus. There's no web-platform signal for that: neither
   visibilitychange nor window blur/focus fire reliably (or at all) for an OS
   session lock in a WebView2 host, since the app's top-level window doesn't
   necessarily lose OS focus the same way it would to another regular window.

   Windows exposes exactly one reliable channel for this: WM_WTSSESSION_CHANGE,
   delivered to a window that has called WTSRegisterSessionNotification. That
   requires hooking the window's message loop directly, which Tauri's window
   API doesn't expose, so this installs a window subclass (SetWindowSubclass,
   comctl32) that watches for WTS_SESSION_LOCK / WTS_SESSION_UNLOCK and passes
   everything else through unchanged to the real window procedure.

   Used by the Budget Tracker to re-lock itself on OS session lock when
   "re-auth on every entry" is the active encryption mode. The same way a
   password manager like Bitwarden re-locks its vault when the machine locks,
   rather than only on next use. See src/tools/budget.ts's
   "session-lock-changed" listener for the frontend half.

   Best-effort throughout: any failure here just means this one feature
   silently doesn't fire. It must never be able to block or break startup.
============================================================================= */

use tauri::{Emitter, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::RemoteDesktop::{NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK};

/// Arbitrary but unique-enough subclass ID, only one subclass is ever
/// installed (on the single main window), so collision isn't a real concern.
const SUBCLASS_ID: usize = 0x5B5D_C5E5;

/// The window subclass procedure. Runs on the UI thread, alongside wry/tao's
/// own window proc. SetWindowSubclass chains rather than replaces, so every
/// message not handled here must be forwarded to DefSubclassProc or the real
/// window (drag, resize, paint, etc.) would stop working.
unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    umsg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    dwrefdata: usize,
) -> LRESULT {
    if umsg == WM_WTSSESSION_CHANGE {
        let locked = match wparam.0 as u32 {
            w if w == WTS_SESSION_LOCK => Some(true),
            w if w == WTS_SESSION_UNLOCK => Some(false),
            _ => None,
        };
        if let Some(locked) = locked {
            // dwrefdata is a raw pointer to a leaked AppHandle set up in
            // init() below, valid for the lifetime of the process/window.
            let app = unsafe { &*(dwrefdata as *const tauri::AppHandle) };
            let _ = app.emit("session-lock-changed", locked);
        }
    }
    unsafe { DefSubclassProc(hwnd, umsg, wparam, lparam) }
}

/// Registers the main window for Windows session-lock notifications. Call
/// once from setup(), after the window exists.
pub fn init(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    // SAFETY: hwnd is a live window handle for the app's own main window,
    // valid for the whole process lifetime (the app doesn't destroy/recreate
    // it). WTSRegisterSessionNotification and SetWindowSubclass are both
    // FFI calls into system DLLs (wtsapi32.dll, comctl32.dll) with no
    // preconditions beyond a valid HWND.
    unsafe {
        if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION).is_err() {
            return;
        }

        // Leaked deliberately: this AppHandle must outlive the subclass,
        // which itself lives for the process's whole run. Reclaimed by the
        // OS on exit, same as every other piece of process-lifetime state.
        let app_handle_ptr: *const tauri::AppHandle = Box::into_raw(Box::new(app.clone()));
        let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, app_handle_ptr as usize);
    }
}
