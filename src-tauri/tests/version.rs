//! Cargo、Tauri 和前端必须使用同一版本，避免界面、同步 manifest 和更新器不一致。
#[test]
fn app_versions_match() {
    let tauri: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("解析 tauri.conf.json");
    let package: serde_json::Value =
        serde_json::from_str(include_str!("../../package.json")).expect("解析 package.json");
    for (name, value) in [("tauri.conf.json", tauri), ("package.json", package)] {
        assert_eq!(
            value["version"].as_str(),
            Some(env!("CARGO_PKG_VERSION")),
            "{name} 与 Cargo.toml 的 version 不一致"
        );
    }
}
