// args! 宏返回 Vec，按引用传入是有意为之
#![allow(clippy::useless_vec)]

pub mod commands;
pub mod core;

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::{Manager, PhysicalSize, Runtime, Window, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::FULLSCREEN);
/// 启动后这段时间内的尺寸变化都检查一次：窗口状态插件恢复上次尺寸是异步生效的
const FIT_WINDOW: Duration = Duration::from_secs(3);
static STARTED: OnceLock<Instant> = OnceLock::new();

/// 仅缩小超出工作区的窗口，返回 set_size 所需的内容区物理尺寸。
fn fitted_inner_size(
    area: PhysicalSize<u32>,
    outer: PhysicalSize<u32>,
    inner: PhysicalSize<u32>,
) -> Option<PhysicalSize<u32>> {
    if area.width == 0
        || area.height == 0
        || inner.width == 0
        || inner.height == 0
        || (outer.width <= area.width && outer.height <= area.height)
    {
        return None;
    }
    // outer_size 含系统标题栏，set_size 设置的是内容区尺寸，按两者差值换算。
    let chrome_w = outer.width.saturating_sub(inner.width);
    let chrome_h = outer.height.saturating_sub(inner.height);
    let fitted = PhysicalSize::new(
        outer.width.min(area.width).saturating_sub(chrome_w),
        outer.height.min(area.height).saturating_sub(chrome_h),
    );
    // 异常读数无法容纳边框时，不提交零尺寸，也不反复触发尺寸变化。
    (fitted.width > 0 && fitted.height > 0 && fitted != inner).then_some(fitted)
}

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
    let Some(size) = fitted_inner_size(
        monitor.work_area().size,
        window.outer_size()?,
        window.inner_size()?,
    ) else {
        return Ok(());
    };
    // 保留系统对配置中默认最小尺寸的约束。
    window.set_size(size)?;
    window.center()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 保存和恢复尺寸、位置、最大化及全屏状态；插件仍在正常退出时保存。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .build(),
        )
        // 检查 / 下载 / 安装更新（GitHub Releases 上的 latest.json），安装后重启
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            STARTED.get_or_init(Instant::now);
            // 默认尺寸本身也可能放不下（小屏 + 高缩放）
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = fit_to_monitor(&window.as_ref().window()) {
                    eprintln!("初始化主窗口尺寸适配失败: {error}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { .. } => {
                    // 此时原生窗口尚未销毁，读取最新状态并立即落盘。
                    if let Err(error) = window.app_handle().save_window_state(WINDOW_STATE_FLAGS) {
                        eprintln!("关闭主窗口时保存窗口状态失败: {error}");
                    }
                }
                WindowEvent::Resized(_) => {
                    let starting = STARTED.get().is_some_and(|t| t.elapsed() < FIT_WINDOW);
                    if starting {
                        if let Err(error) = fit_to_monitor(window) {
                            eprintln!("启动期间主窗口尺寸适配失败: {error}");
                        }
                    }
                }
                _ => {}
            }
        })
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::load_config,
            commands::save_config,
            commands::environment,
            commands::repo_status,
            commands::probe_repo,
            commands::cancel_operation,
            commands::active_operation,
            commands::sync_state,
            commands::list_packages,
            commands::list_return_packages,
            commands::list_commits,
            commands::abort_op,
            commands::continue_op,
            commands::rebase_onto,
            commands::delete_local_branch,
            commands::init_mirror,
            commands::export_out,
            commands::import_back,
            commands::import_patches,
            commands::push_branch,
            commands::prepare_push,
            commands::execute_push,
            commands::import_return,
            commands::sync_updates,
            commands::dev_sync_status,
            commands::import_in,
            commands::create_dev_repo,
            commands::sync_dev_repo,
            commands::list_worktrees,
            commands::configure_repo,
            commands::create_branch,
            commands::export_back,
            commands::export_patches,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod window_tests {
    use super::fitted_inner_size;
    use tauri::PhysicalSize;

    #[test]
    fn preserves_first_launch_default_minimum_size_when_it_fits() {
        let area = PhysicalSize::new(1280, 720);
        let default_inner = PhysicalSize::new(900, 600);
        let outer_with_borders = PhysicalSize::new(916, 639);
        assert_eq!(
            fitted_inner_size(area, outer_with_borders, default_inner),
            None
        );
    }

    #[test]
    fn preserves_restored_user_size_at_ninety_five_percent_of_work_area() {
        let area = PhysicalSize::new(2000, 1000);
        let size = PhysicalSize::new(1900, 950);
        assert_eq!(fitted_inner_size(area, size, size), None);
    }

    #[test]
    fn preserves_size_exactly_matching_work_area() {
        let size = PhysicalSize::new(2000, 1000);
        assert_eq!(fitted_inner_size(size, size, size), None);
    }

    #[test]
    fn fits_oversized_window_to_smaller_monitor() {
        let area = PhysicalSize::new(1280, 720);
        let size = PhysicalSize::new(1920, 1080);
        assert_eq!(fitted_inner_size(area, size, size), Some(area));
        assert_eq!(fitted_inner_size(area, area, area), None);
    }

    #[test]
    fn subtracts_system_borders_and_preserves_fitting_axis() {
        let area = PhysicalSize::new(1280, 720);
        let outer = PhysicalSize::new(1200, 900);
        let inner = PhysicalSize::new(1184, 861);
        let fitted = PhysicalSize::new(1184, 681);
        assert_eq!(fitted_inner_size(area, outer, inner), Some(fitted));
        assert_eq!(
            fitted_inner_size(area, PhysicalSize::new(1200, 720), fitted),
            None
        );
    }

    #[test]
    fn ignores_zero_work_area_dimensions() {
        let size = PhysicalSize::new(1280, 800);
        for area in [
            PhysicalSize::new(0, 800),
            PhysicalSize::new(1280, 0),
            PhysicalSize::new(0, 0),
        ] {
            assert_eq!(fitted_inner_size(area, size, size), None);
        }
    }

    #[test]
    fn ignores_unusable_window_or_border_measurements() {
        let outer = PhysicalSize::new(1280, 800);
        assert_eq!(
            fitted_inner_size(PhysicalSize::new(1000, 700), outer, PhysicalSize::new(0, 0)),
            None
        );
        assert_eq!(
            fitted_inner_size(
                PhysicalSize::new(16, 39),
                outer,
                PhysicalSize::new(1264, 761)
            ),
            None
        );
    }
}
