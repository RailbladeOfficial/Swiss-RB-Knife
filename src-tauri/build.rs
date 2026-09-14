/// Names a debug build "Swiss RB Knife (dev)" in the exe's file description,
/// which is the name Task Manager shows on its Processes tab. The installed app
/// and a dev build are both swiss-rb-knife.exe, and before this they were two
/// identical "Swiss RB Knife" rows.
///
/// tauri-build writes the description from `productName` and has no setting of
/// its own for it, but it merges a `TAURI_CONFIG` JSON patch over tauri.conf.json.
/// This sets that patch for THIS build script's process only, so nothing else
/// sees a different product name: not the app at runtime (that comes from the
/// config the app crate is compiled against), not the installer, not the window
/// title. Anything the CLI already put in `TAURI_CONFIG` is kept.
fn name_debug_build() {
    if std::env::var("PROFILE").as_deref() != Ok("debug") {
        return;
    }
    let mut patch = std::env::var("TAURI_CONFIG")
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    patch["productName"] = serde_json::json!("Swiss RB Knife (dev)");
    std::env::set_var("TAURI_CONFIG", patch.to_string());
}

fn main() {
    name_debug_build();

    let mut windows = tauri_build::WindowsAttributes::new();
    windows = windows.app_manifest(r#"
        <assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
          <dependency>
            <dependentAssembly>
              <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
                version="6.0.0.0" processorArchitecture="*"
                publicKeyToken="6595b64144ccf1df" language="*" />
            </dependentAssembly>
          </dependency>
          <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
            <security>
              <requestedPrivileges>
                <requestedExecutionLevel level="requireAdministrator" uiAccess="false" />
              </requestedPrivileges>
            </security>
          </trustInfo>
        </assembly>
    "#);
    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(windows)
    ).expect("failed to run build script");
}