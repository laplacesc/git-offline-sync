// args! 宏返回 Vec，按引用传入是有意为之
#![allow(clippy::useless_vec)]

pub mod commands;
pub mod core;

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::{Manager, PhysicalSize, Runtime, Window, WindowEvent};

/// 窗口最多占显示器可用区域（不含任务栏 / Dock / 菜单栏）的比例
const MAX_SCREEN_FRACTION: f64 = 0.9;
/// 启动后这段时间内的尺寸变化都检查一次：窗口状态插件恢复上次尺寸是异步生效的
const FIT_WINDOW: Duration = Duration::from_secs(3);
static STARTED: OnceLock<Instant> = OnceLock::new();

/// 默认尺寸或恢复的尺寸放不进当前显示器时缩小并居中。
/// 例如 1920×1080 + 150% 缩放的 Windows 笔记本，可用区域只有约 1280×690；
/// 或者上次在大显示器上关闭、这次在小显示器上打开。
fn fit_to_monitor<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    if window.is_maximized()? || window.is_fullscreen()? {
        return Ok(());
    }
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let area = monitor.work_area().size;
    let max_w = (area.width as f64 * MAX_SCREEN_FRACTION) as u32;
    let max_h = (area.height as f64 * MAX_SCREEN_FRACTION) as u32;
    let outer = window.outer_size()?;
    if outer.width <= max_w && outer.height <= max_h {
        return Ok(());
    }
    // outer_size 含系统标题栏，set_size 设置的是内容区尺寸，按两者差值换算
    let inner = window.inner_size()?;
    let chrome_w = outer.width.saturating_sub(inner.width);
    let chrome_h = outer.height.saturating_sub(inner.height);
    window.set_size(PhysicalSize::new(
        outer.width.min(max_w).saturating_sub(chrome_w),
        outer.height.min(max_h).saturating_sub(chrome_h),
    ))?;
    window.center()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 记住上次的窗口尺寸、位置与最大化状态
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            STARTED.get_or_init(Instant::now);
            // 默认尺寸本身也可能放不下（小屏 + 高缩放）
            if let Some(window) = app.get_webview_window("main") {
                let _ = fit_to_monitor(&window.as_ref().window());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Resized(_) = event {
                let starting = STARTED.get().is_some_and(|t| t.elapsed() < FIT_WINDOW);
                if starting && window.label() == "main" {
                    let _ = fit_to_monitor(window);
                }
            }
        })
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
