//! Tauri 命令：把 core 的同步流程暴露给前端。
//! git 调用是阻塞的，统一放到 blocking 线程执行，并把日志以 `git-log` 事件推送给界面。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::core::error::SyncError;
use crate::core::git::{Git, LogEvent, LogKind};
use crate::core::repo::{CommitInfo, RepoStatus};
use crate::core::sync::{self, ExportOutcome, ImportBackResult, ImportInResult, OpOutcome, PackageInfo};

pub const LOG_EVENT: &str = "git-log";

#[derive(Default)]
pub struct AppState {
    pub git_path: Mutex<Option<String>>,
}

type CmdResult<T> = Result<T, String>;

async fn blocking<T, F>(app: AppHandle, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Git) -> Result<T, SyncError> + Send + 'static,
{
    let git_path = app
        .state::<AppState>()
        .git_path
        .lock()
        .ok()
        .and_then(|g| g.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let emitter = app.clone();
        let logger = move |e: LogEvent| {
            let _ = emitter.emit(LOG_EVENT, e);
        };
        let git = Git::new(git_path.as_deref(), &logger);
        let res = f(&git);
        if let Err(e) = &res {
            git.emit(LogKind::Error, e.to_string());
        }
        res.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
}

fn p(s: String) -> PathBuf {
    PathBuf::from(s)
}

// ---------------- 配置 ----------------

fn config_path(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn apply_git_path(app: &AppHandle, cfg: &serde_json::Value) {
    let gp = cfg
        .get("gitPath")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty());
    if let Ok(mut g) = app.state::<AppState>().git_path.lock() {
        *g = gp;
    }
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> CmdResult<serde_json::Value> {
    let path = config_path(&app)?;
    let cfg = if path.exists() {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| format!("配置文件损坏：{e}"))?
    } else {
        serde_json::json!({ "profiles": [] })
    };
    apply_git_path(&app, &cfg);
    Ok(cfg)
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: serde_json::Value) -> CmdResult<()> {
    let path = config_path(&app)?;
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())?;
    apply_git_path(&app, &config);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub os: String,
    pub git: Result<String, String>,
    pub config_path: String,
}

#[tauri::command]
pub async fn environment(app: AppHandle) -> CmdResult<Environment> {
    let cfg = config_path(&app)?.to_string_lossy().into_owned();
    let git = blocking(app, sync::check_git).await;
    Ok(Environment {
        os: std::env::consts::OS.to_string(),
        git,
        config_path: cfg,
    })
}

// ---------------- 通用 ----------------

#[tauri::command]
pub async fn repo_status(
    app: AppHandle,
    path: String,
    base_branch: String,
    release_branches: Vec<String>,
) -> CmdResult<RepoStatus> {
    blocking(app, move |g| {
        crate::core::repo::status(g, &p(path), &base_branch, &release_branches)
    })
    .await
}

/// 读取同步状态：外网仓库读 `.git/offline-sync`，内网镜像读 `<mirror>/offline-sync`。
#[tauri::command]
pub async fn sync_state(app: AppHandle, path: String, external: bool) -> CmdResult<serde_json::Value> {
    use crate::core::repo::{self, ExternalState, InternalState};
    blocking(app, move |g| {
        let path = p(path);
        let v = if external {
            let s: ExternalState = repo::load_state(&repo::git_dir(g, &path)?)?;
            serde_json::to_value(s)?
        } else {
            let s: InternalState = repo::load_state(&path)?;
            serde_json::to_value(s)?
        };
        Ok(v)
    })
    .await
}

#[tauri::command]
pub async fn list_packages(app: AppHandle, dir: String) -> CmdResult<Vec<PackageInfo>> {
    blocking(app, move |_| sync::list_packages(&p(dir))).await
}

#[tauri::command]
pub async fn list_commits(app: AppHandle, repo: String, from: String, to: String) -> CmdResult<Vec<CommitInfo>> {
    blocking(app, move |g| sync::list_commits(g, &p(repo), &from, &to)).await
}

#[tauri::command]
pub async fn abort_op(app: AppHandle, repo: String) -> CmdResult<OpOutcome> {
    blocking(app, move |g| sync::abort(g, &p(repo))).await
}

#[tauri::command]
pub async fn continue_op(app: AppHandle, repo: String) -> CmdResult<OpOutcome> {
    blocking(app, move |g| sync::continue_op(g, &p(repo))).await
}

#[tauri::command]
pub async fn rebase_onto(
    app: AppHandle,
    repo: String,
    branch: String,
    base_branch: String,
    fetch_upstream: bool,
) -> CmdResult<OpOutcome> {
    blocking(app, move |g| {
        sync::rebase_onto(g, &p(repo), &branch, &base_branch, fetch_upstream)
    })
    .await
}

// ---------------- 内网端 ----------------

#[tauri::command]
pub async fn init_mirror(app: AppHandle, url: String, mirror_dir: String) -> CmdResult<()> {
    blocking(app, move |g| sync::init_mirror(g, &url, &p(mirror_dir))).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_out(
    app: AppHandle,
    mirror_dir: String,
    transfer_dir: String,
    repo_name: String,
    base_branch: String,
    fetch_upstream: bool,
    force_full: bool,
) -> CmdResult<ExportOutcome> {
    blocking(app, move |g| {
        sync::export_out(
            g,
            &p(mirror_dir),
            &p(transfer_dir),
            &repo_name,
            &base_branch,
            fetch_upstream,
            force_full,
        )
    })
    .await
}

#[tauri::command]
pub async fn import_back(
    app: AppHandle,
    work_dir: String,
    bundle: String,
    base_branch: String,
    release_branches: Vec<String>,
) -> CmdResult<ImportBackResult> {
    blocking(app, move |g| {
        sync::import_back(g, &p(work_dir), &p(bundle), &base_branch, &release_branches)
    })
    .await
}

#[tauri::command]
pub async fn import_patches(
    app: AppHandle,
    work_dir: String,
    patch_dir: String,
    branch: String,
    base_branch: String,
    fetch_upstream: bool,
) -> CmdResult<OpOutcome> {
    blocking(app, move |g| {
        sync::import_patches(g, &p(work_dir), &p(patch_dir), &branch, &base_branch, fetch_upstream)
    })
    .await
}

#[tauri::command]
pub async fn push_branch(
    app: AppHandle,
    work_dir: String,
    branch: String,
    force_with_lease: bool,
) -> CmdResult<OpOutcome> {
    blocking(app, move |g| sync::push_branch(g, &p(work_dir), &branch, force_with_lease)).await
}

// ---------------- 外网端 ----------------

#[tauri::command]
pub async fn import_in(
    app: AppHandle,
    bundle: String,
    repo_dir: String,
    allow_gap: bool,
) -> CmdResult<ImportInResult> {
    blocking(app, move |g| sync::import_in(g, &p(bundle), &p(repo_dir), allow_gap)).await
}

#[tauri::command]
pub async fn configure_repo(app: AppHandle, repo: String, name: String, email: String) -> CmdResult<()> {
    blocking(app, move |g| sync::configure_repo(g, &p(repo), &name, &email)).await
}

#[tauri::command]
pub async fn create_branch(app: AppHandle, repo: String, name: String, base_branch: String) -> CmdResult<()> {
    blocking(app, move |g| sync::create_branch(g, &p(repo), &name, &base_branch)).await
}

#[tauri::command]
pub async fn export_back(
    app: AppHandle,
    repo: String,
    branches: Vec<String>,
    transfer_dir: String,
    repo_name: String,
    base_branch: String,
    release_branches: Vec<String>,
) -> CmdResult<ExportOutcome> {
    blocking(app, move |g| {
        sync::export_back(
            g,
            &p(repo),
            &branches,
            &p(transfer_dir),
            &repo_name,
            &base_branch,
            &release_branches,
        )
    })
    .await
}

#[tauri::command]
pub async fn export_patches(
    app: AppHandle,
    repo: String,
    branch: String,
    transfer_dir: String,
    repo_name: String,
    base_branch: String,
    release_branches: Vec<String>,
) -> CmdResult<ExportOutcome> {
    blocking(app, move |g| {
        sync::export_patches(
            g,
            &p(repo),
            &branch,
            &p(transfer_dir),
            &repo_name,
            &base_branch,
            &release_branches,
        )
    })
    .await
}

