// args! 宏返回 Vec，按引用传入是有意为之
#![allow(clippy::useless_vec)]

pub mod commands;
pub mod core;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::load_config,
            commands::save_config,
            commands::environment,
            commands::repo_status,
            commands::sync_state,
            commands::list_packages,
            commands::list_commits,
            commands::abort_op,
            commands::continue_op,
            commands::rebase_onto,
            commands::init_mirror,
            commands::export_out,
            commands::import_back,
            commands::import_patches,
            commands::push_branch,
            commands::import_in,
            commands::configure_repo,
            commands::create_branch,
            commands::export_back,
            commands::export_patches,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
