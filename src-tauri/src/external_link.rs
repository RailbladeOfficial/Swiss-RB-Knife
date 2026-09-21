/* =============================================================================
   EXTERNAL LINKS: opening a web page in the user's browser, UNELEVATED
   -----------------------------------------------------------------------------
   This app runs elevated (requireAdministrator, see build.rs), and that is what
   broke every link that leaves it: the About modal's GitHub link, the "new
   version available" link, and every web link in the README.

   All three went through the opener plugin, which hands the URL to
   ShellExecute from THIS process. From an elevated process that means the
   browser is asked to open at high integrity, and a browser that is already
   running at the user's normal integrity will not take a hand-off from it:
   Windows keeps processes at different integrity levels apart, so the link
   does nothing at all. Nothing reports it either, because the call "worked".
   Whether it bites depends on whether a browser is already open, which is why
   it could work one day and not the next with no change to the app.

   THE FIX IS TO ASK EXPLORER. Explorer is already running at the user's normal
   integrity, and the desktop exposes a scripting object whose ShellExecute
   runs inside Explorer's process rather than ours. The browser then starts
   (or is handed the URL) exactly as if the link had been clicked on the
   desktop. This is the approach Microsoft's own shell team describes for
   launching something unelevated from an elevated process; the chain below is
   that approach, one COM hop at a time.

   FALLS BACK TO THE OLD PATH if any hop fails, for instance if Explorer is not
   running or has been replaced by another shell. That is never worse than
   before this existed, and on a machine where the old path works it still
   works.

   ONLY WEB AND MAIL LINKS. Whatever reaches here is handed to the shell, which
   will just as happily run a program or open a file. So the scheme is checked
   first and everything that is not http, https or mailto is refused.
============================================================================= */

/// Opens `url` in the user's default browser (or mail client, for mailto),
/// at the user's normal integrity. See the module comment for why this is not
/// simply the opener plugin.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let url = checked_url(&url)?;

    #[cfg(windows)]
    {
        // COM wants its own apartment, and the command may run on a thread
        // that already has one of a different kind. A short-lived thread of our
        // own is the only way to be sure what we are initializing.
        let owned = url.clone();
        let unelevated = std::thread::spawn(move || shell_execute_via_explorer(&owned))
            .join()
            .unwrap_or_else(|_| Err("the Explorer hand-off panicked".to_string()));
        if unelevated.is_ok() {
            return Ok(());
        }
    }

    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

/// The URL, trimmed, if it is a web or mail link. Anything else is refused
/// before it can get anywhere near the shell.
fn checked_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    let lower = url.to_ascii_lowercase();
    let allowed = ["https://", "http://", "mailto:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme) && lower.len() > scheme.len());
    if !allowed {
        return Err("only http, https and mailto links can be opened".to_string());
    }
    // A control character has no business in a link, and the shell parses
    // what it is given. Refusing them costs nothing a real link would need.
    if url.chars().any(char::is_control) {
        return Err("that link contains a control character".to_string());
    }
    Ok(url.to_string())
}

/// ShellExecute, run inside Explorer's process through the desktop's scripting
/// object. Every hop is a place Explorer can say no, and any no falls back.
#[cfg(windows)]
fn shell_execute_via_explorer(url: &str) -> Result<(), String> {
    use windows::core::BSTR;
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    with_com(|| unsafe {
        explorer_shell()?
            .ShellExecute(
                &BSTR::from(url),
                &VARIANT::from(BSTR::new()),
                &VARIANT::from(BSTR::new()),
                &VARIANT::from(BSTR::from("open")),
                &VARIANT::from(SW_SHOWNORMAL.0),
            )
            .map_err(|e| format!("asking Explorer to open the link: {e}"))
    })
}

/// Runs `body` with COM initialized on this thread, and uninitialized after.
#[cfg(windows)]
fn with_com<T>(body: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| format!("initializing COM: {e}"))?;
        let result = body();
        CoUninitialize();
        result
    }
}

/// Shell.Application as Explorer holds it, reached through the desktop. Split
/// out from the ShellExecute so the whole chain can be tested without opening
/// anything (see explorer_is_reachable_from_this_process).
#[cfg(windows)]
unsafe fn explorer_shell() -> Result<windows::Win32::UI::Shell::IShellDispatch2, String> {
    use windows::core::Interface;
    use windows::Win32::System::Com::{CoCreateInstance, IDispatch, IServiceProvider, CLSCTX_LOCAL_SERVER};
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Shell::{
        IShellBrowser, IShellFolderViewDual, IShellView, IShellWindows,
        SID_STopLevelBrowser, ShellWindows, CSIDL_DESKTOP, SVGIO_BACKGROUND, SWC_DESKTOP,
        SWFO_NEEDDISPATCH,
    };

    let err = |step: &str, e: windows::core::Error| format!("{step}: {e}");
    unsafe {
        // 1. Explorer's list of its own windows, and the desktop among them.
        let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)
            .map_err(|e| err("reaching Explorer", e))?;
        let location = VARIANT::from(CSIDL_DESKTOP as i32);
        let empty = VARIANT::default();
        let mut hwnd = 0i32;
        let desktop: IDispatch = windows
            .FindWindowSW(&location, &empty, SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)
            .map_err(|e| err("finding the desktop", e))?;

        // 2. The desktop's view, which is the object that owns the script.
        let provider: IServiceProvider =
            desktop.cast().map_err(|e| err("asking the desktop for its browser", e))?;
        let browser: IShellBrowser = provider
            .QueryService(&SID_STopLevelBrowser)
            .map_err(|e| err("reaching the desktop's browser", e))?;
        let view: IShellView = browser
            .QueryActiveShellView()
            .map_err(|e| err("reaching the desktop's view", e))?;
        let background: IDispatch = view
            .GetItemObject(SVGIO_BACKGROUND)
            .map_err(|e| err("reaching the desktop's script", e))?;
        let folder_view: IShellFolderViewDual =
            background.cast().map_err(|e| err("reading the desktop's script", e))?;

        // 3. Shell.Application, living in Explorer's process. Its ShellExecute
        //    runs there, at Explorer's integrity, rather than here.
        let application: IDispatch =
            folder_view.Application().map_err(|e| err("reaching Shell.Application", e))?;
        application.cast().map_err(|e| err("reading Shell.Application", e))
    }
}

#[cfg(test)]
mod tests {
    use super::checked_url;

    /// Walks every hop to Explorer's Shell.Application and stops short of
    /// ShellExecute, so it proves the chain works without opening anything.
    /// Ignored by default because it needs a signed-in desktop with Explorer
    /// running, which a build machine may not have. Run it from an ELEVATED
    /// shell to test the case this module exists for:
    ///     cargo test --lib external_link -- --ignored
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn explorer_is_reachable_from_this_process() {
        let shell = super::with_com(|| unsafe { super::explorer_shell().map(|_| ()) });
        assert!(shell.is_ok(), "{shell:?}");
    }

    #[test]
    fn web_and_mail_links_are_allowed() {
        assert!(checked_url("https://github.com/RailbladeOfficial/Swiss-RB-Knife").is_ok());
        assert!(checked_url("http://example.com").is_ok());
        assert!(checked_url("mailto:someone@example.com").is_ok());
        assert!(checked_url("  HTTPS://EXAMPLE.COM  ").is_ok());
    }

    #[test]
    fn anything_the_shell_would_run_is_refused() {
        // Every one of these is something ShellExecute would act on, and not by
        // opening a web page.
        for bad in [
            "C:\\Windows\\System32\\calc.exe",
            "calc.exe",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:",
            "\\\\server\\share\\thing.exe",
            "https://",
            "",
        ] {
            assert!(checked_url(bad).is_err(), "{bad:?} should have been refused");
        }
    }

    #[test]
    fn a_control_character_is_refused() {
        assert!(checked_url("https://example.com/\u{0}evil").is_err());
        assert!(checked_url("https://example.com/\nsecond").is_err());
    }
}
