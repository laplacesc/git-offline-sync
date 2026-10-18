use serde_json::Value;
use tauri::utils::config::WindowConfig;

#[test]
fn windows_chrome_override_preserves_window_geometry_and_native_actions() {
    let base: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let (windows, loaded) = tauri::utils::config::parse::read_from(
        tauri::utils::platform::Target::Windows,
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )
    .unwrap();
    assert!(loaded
        .iter()
        .any(|path| path.ends_with("tauri.windows.conf.json")));
    assert_eq!(windows["bundle"], base["bundle"]);
    let base: WindowConfig = serde_json::from_value(base["app"]["windows"][0].clone()).unwrap();
    let windows: WindowConfig =
        serde_json::from_value(windows["app"]["windows"][0].clone()).unwrap();
    // Platform config arrays replace the base array, rather than merging each window.
    assert_eq!(windows.label, base.label);
    assert_eq!(windows.title, base.title);
    assert_eq!((windows.width, windows.height), (base.width, base.height));
    assert_eq!(
        (windows.min_width, windows.min_height),
        (base.min_width, base.min_height)
    );
    assert!(base.decorations);
    assert!(!windows.decorations);
    assert!(windows.resizable && windows.maximizable && windows.minimizable && windows.closable);
    assert!(windows.shadow);
}

#[test]
fn caption_permissions_are_limited_to_the_windows_main_window() {
    let capability: Value =
        serde_json::from_str(include_str!("../capabilities/windows-caption.json")).unwrap();
    assert_eq!(capability["platforms"], serde_json::json!(["windows"]));
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(
        capability["permissions"],
        serde_json::json!([
            "core:window:allow-minimize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-close"
        ])
    );
}
