//! 应用内更新按 tauri.conf.json 的 version 判断是否有新版本，
//! 而界面显示和包 manifest 的 toolVersion 用的是 Cargo.toml 的版本。
//! 两者必须一致，否则更新后显示的版本号会不对。
#[test]
fn tauri_conf_version_matches_cargo() {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("解析 tauri.conf.json");
    assert_eq!(
        conf["version"].as_str(),
        Some(env!("CARGO_PKG_VERSION")),
        "tauri.conf.json 与 Cargo.toml 的 version 不一致"
    );
}
