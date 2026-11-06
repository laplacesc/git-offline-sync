//! 同步流程。
//!
//! 内网端（能访问 GitLab）：init_mirror → export_out → review::import_return / import_patches → rebase_onto → review::prepare_push / execute_push
//! 外网端（AI 开发）：import_in → create_branch → export_back / export_patches

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::error::{invalid, Result, SyncError};
use super::git::Git;
use super::manifest::{BundleKind, Manifest, RefEntry, FORMAT};
use super::repo::{self, InternalState, MirrorState};
use super::storage::{atomic_write, OperationLock};
use crate::args;

pub const MIN_GIT: (u32, u32) = (2, 36);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn tool_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ExportOutcome {
    Exported {
        kind: BundleKind,
        seq: u32,
        payload: String,
        manifest: String,
        refs: Vec<RefEntry>,
        warnings: Vec<String>,
    },
    NothingToSync {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpOutcome {
    pub ok: bool,
    pub conflict: bool,
    pub files: Vec<String>,
    pub message: String,
    /// 操作实际执行所在的工作树。分支被 linked worktree 检出时，
    /// 冲突要在那个目录里解决，"继续 / 中止"也必须发到那里。
    pub worktree: Option<String>,
}

impl OpOutcome {
    fn done(msg: impl Into<String>) -> Self {
        OpOutcome {
            ok: true,
            message: msg.into(),
            ..Default::default()
        }
    }

    /// 标记操作实际发生在哪个 worktree（主工作树传 None）。
    fn at(mut self, worktree: Option<String>) -> Self {
        self.worktree = worktree;
        self
    }
}

/// 冲突消息里指明操作在哪个 worktree；主工作树不加后缀。
fn at_worktree(wt: &Option<String>) -> String {
    wt.as_ref()
        .map(|p| format!("（在 {p}）"))
        .unwrap_or_default()
}

/// `git bundle create` + `bundle verify`，两端导出共用。
///
/// 返回 `Some(NothingToSync)` 表示没有可打包的提交，调用方直接返回它。
/// 半成品只存在于隐藏 staging 目录，错误/取消由 TempDir 自动清理，
/// 不会被 `list_packages` 当成手工打包的完整 bundle。
fn create_and_verify_bundle(
    g: &Git,
    cwd: &Path,
    bundle: &Path,
    revisions: &[String],
    empty_msg: &str,
) -> Result<Option<ExportOutcome>> {
    // Bound argv even when a mirror contains thousands of heads and tags.
    let input = revisions.join("\n") + "\n";
    let out = g.exec(
        Some(cwd),
        &args!["bundle", "create", bundle, "--stdin"],
        Some(&input),
        true,
    )?;
    if !out.ok() {
        let _ = fs::remove_file(bundle);
        if out.stderr.contains("empty bundle") {
            return Ok(Some(ExportOutcome::NothingToSync {
                message: empty_msg.into(),
            }));
        }
        return Err(SyncError::Git {
            cmd: "git bundle create".into(),
            code: out.code,
            stderr: super::git::redact(out.stderr.trim()),
        });
    }
    if let Err(e) = g.run(cwd, args!["bundle", "verify", bundle]) {
        let _ = fs::remove_file(bundle);
        return Err(e);
    }
    Ok(None)
}

/// A prepared export can always finish after a failed rename/state write. The
/// pending marker hides the package until both files and its sequence are durable.
#[derive(Serialize, Deserialize)]
struct ExportJournal {
    staging: PathBuf,
    destination: PathBuf,
    manifest: Manifest,
    state: serde_json::Value,
    warnings: Vec<String>,
}

fn export_journal(dir: &Path) -> PathBuf {
    dir.join("offline-sync/export-pending.json")
}

fn pending_marker(payload: &Path) -> PathBuf {
    let mut name = payload.as_os_str().to_owned();
    name.push(".pending");
    PathBuf::from(name)
}

fn publish_export<T: Serialize>(
    state_dir: &Path,
    transfer_dir: &Path,
    staging: tempfile::TempDir,
    manifest: Manifest,
    state: &T,
    warnings: Vec<String>,
) -> Result<ExportOutcome> {
    let destination = std::path::absolute(transfer_dir)?.join(&manifest.payload);
    let _transfer_lock = OperationLock::acquire(destination.parent().unwrap())?;
    if destination.exists() || super::manifest::manifest_path_for(&destination).exists() {
        return invalid(format!("包已存在，不会覆盖：{}", destination.display()));
    }
    manifest.validate(&destination)?;
    let payload = staging.path().join(&manifest.payload);
    let files = if payload.is_dir() {
        fs::read_dir(&payload)?
            .map(|entry| entry.map(|e| e.path()))
            .collect::<std::io::Result<Vec<_>>>()?
    } else {
        vec![payload.clone()]
    };
    for file in files {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(file)?
            .sync_all()?;
    }
    #[cfg(unix)]
    {
        if payload.is_dir() {
            fs::File::open(&payload)?.sync_all()?;
        }
        fs::File::open(staging.path())?.sync_all()?;
    }
    let journal = ExportJournal {
        staging: std::path::absolute(staging.path())?,
        destination,
        manifest,
        state: serde_json::to_value(state)?,
        warnings,
    };
    atomic_write(
        &export_journal(state_dir),
        &serde_json::to_vec_pretty(&journal)?,
    )?;
    // From here the journal owns the directory, including when finalization fails.
    let _ = staging.keep();
    finish_export(state_dir, journal)
}

fn recover_export(state_dir: &Path) -> Result<Option<ExportOutcome>> {
    let path = export_journal(state_dir);
    if !path.exists() {
        return Ok(None);
    }
    let journal: ExportJournal = serde_json::from_slice(&fs::read(path)?)?;
    let _transfer_lock = OperationLock::acquire(
        journal
            .destination
            .parent()
            .ok_or_else(|| SyncError::Invalid("导出恢复路径无效".into()))?,
    )?;
    finish_export(state_dir, journal).map(Some)
}

fn finish_export(state_dir: &Path, journal: ExportJournal) -> Result<ExportOutcome> {
    journal.manifest.validate(&journal.destination)?;
    let marker = pending_marker(&journal.destination);
    atomic_write(&marker, b"export not committed\n")?;
    let staged = journal.staging.join(&journal.manifest.payload);
    if staged.exists() {
        if journal.destination.exists() {
            return invalid("导出目标已存在，无法安全恢复");
        }
        fs::rename(&staged, &journal.destination)?;
    } else if !journal.destination.exists() {
        return invalid("待恢复的导出内容丢失，请保留导出日志并检查传输目录");
    }
    let mpath = journal.manifest.write_for(&journal.destination)?;
    // A return export owns only backSeq. Older journals also contain a full
    // MirrorState snapshot: never restore its stale import cursor.
    match journal.manifest.kind {
        BundleKind::Back | BundleKind::Patch => {
            let mut current: MirrorState = repo::load_state(state_dir)?;
            let target = journal.manifest.seq;
            if current.back_seq != target && current.back_seq != target - 1 {
                return invalid("回传导出恢复冲突：当前 backSeq 与预期旧值/目标值不一致");
            }
            current.back_seq = target;
            repo::save_state(state_dir, &current)?;
        }
        _ => {
            let current: InternalState = repo::load_state(state_dir)?;
            let target = journal.manifest.seq;
            if current.out_seq != target && current.out_seq != target - 1 {
                return invalid("导出恢复冲突：当前 outSeq 与预期旧值/目标值不一致");
            }
            repo::save_state(state_dir, &journal.state)?;
        }
    }
    fs::remove_file(&marker)?;
    fs::remove_file(export_journal(state_dir))?;
    let _ = fs::remove_dir_all(&journal.staging);
    Ok(ExportOutcome::Exported {
        kind: journal.manifest.kind,
        seq: journal.manifest.seq,
        payload: journal.destination.to_string_lossy().into_owned(),
        manifest: mpath.to_string_lossy().into_owned(),
        refs: journal.manifest.refs,
        warnings: journal.warnings,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub manifest: Option<Manifest>,
    pub payload_path: String,
    pub payload_exists: bool,
}

// ======================================================================
// 通用
// ======================================================================

pub fn check_git(g: &Git) -> Result<String> {
    let (major, minor, raw) = g.version()?;
    if (major, minor) < MIN_GIT {
        return invalid(format!(
            "git 版本过低：{raw}，需要 ≥ {}.{}",
            MIN_GIT.0, MIN_GIT.1
        ));
    }
    Ok(raw)
}

pub(super) fn ensure_worktree_clean(g: &Git, repo: &Path) -> Result<()> {
    if repo::is_bare(g, repo)? {
        return invalid("这是裸仓库（镜像），请选择工作仓库");
    }
    if let Some(op) = repo::in_progress(&repo::git_dir(g, repo)?) {
        return invalid(format!("仓库中有未完成的 {op}，请先解决冲突或中止"));
    }
    let dirty = g.query(
        repo,
        args!["status", "--porcelain", "--untracked-files=normal"],
    )?;
    if !dirty.trim().is_empty() {
        return invalid("工作区有未提交的修改，请先提交或暂存（stash）");
    }
    Ok(())
}

fn conflict_files(g: &Git, repo: &Path) -> Vec<String> {
    g.query(repo, args!["diff", "--name-only", "--diff-filter=U"])
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn validate_branch_name(g: &Git, repo: &Path, name: &str) -> Result<()> {
    let out = g.exec(
        Some(repo),
        &args!["check-ref-format", "--branch", name],
        None,
        false,
    )?;
    if !out.ok() {
        return invalid(format!("分支名不合法：{name}"));
    }
    Ok(())
}

/// 列出传输目录里的包，展示排序由前端负责。没有 manifest 的 `.bundle` 也会列出。
pub fn list_packages(dir: &Path) -> Result<Vec<PackageInfo>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    let entries = fs::read_dir(dir)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    let mut seen = std::collections::HashSet::new();
    for p in &entries {
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if let Some(stem) = name.strip_suffix(".manifest.json") {
            let text = fs::read_to_string(p)?;
            let m: Manifest = match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let payload = dir.join(&m.payload);
            seen.insert(stem.to_string());
            if m.validate(&payload).is_err()
                || pending_marker(&payload).exists()
                || super::manifest::manifest_path_for(&payload) != *p
            {
                continue;
            }
            out.push(PackageInfo {
                payload_exists: payload.exists(),
                payload_path: payload.to_string_lossy().into_owned(),
                manifest: Some(m),
            });
        }
    }
    for p in &entries {
        if p.extension().is_some_and(|e| e == "bundle") {
            let stem = p
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if !seen.contains(&stem)
                && !pending_marker(p).exists()
                && !super::manifest::manifest_path_for(p).exists()
            {
                out.push(PackageInfo {
                    manifest: None,
                    payload_exists: true,
                    payload_path: p.to_string_lossy().into_owned(),
                });
            }
        }
    }
    Ok(out)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RebaseJournal {
    branch: String,
    new_base: String,
    old_head: String,
    target: String,
    #[serde(default)]
    completed: bool,
}

fn rebase_journal(git_dir: &Path) -> PathBuf {
    git_dir.join("offline-sync-rebase.json")
}

fn read_rebase_journal(git_dir: &Path) -> Result<Option<RebaseJournal>> {
    let path = rebase_journal(git_dir);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}

fn clear_rebase_journal(git_dir: &Path) -> Result<()> {
    match fs::remove_file(rebase_journal(git_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn finish_rebase(g: &Git, work: &Path, gd: &Path) -> Result<()> {
    if let Some(mut journal) = read_rebase_journal(gd)? {
        journal.completed = true;
        atomic_write(&rebase_journal(gd), &serde_json::to_vec(&journal)?)?;
        repo::set_sync_base(g, work, &journal.branch, &journal.new_base)?;
        clear_rebase_journal(gd)?;
    }
    Ok(())
}

/// Recover a process interrupted after Git finished but before config/journal
/// commit. An aborted/never-started operation retains its original (possibly unset) base.
/// Caller holds the worktree operation lock.
pub(super) fn recover_rebase(g: &Git, work: &Path, gd: &Path) -> Result<()> {
    if repo::in_progress(gd).is_some() {
        return Ok(());
    }
    if let Some(journal) = read_rebase_journal(gd)? {
        let head = repo::rev_parse(g, work, &format!("refs/heads/{}", journal.branch))?;
        let advanced = head != journal.old_head
            && g.exec(
                Some(work),
                &args!["merge-base", "--is-ancestor", &journal.target, &head],
                None,
                false,
            )?
            .ok();
        if journal.completed || advanced {
            finish_rebase(g, work, gd)?;
        } else {
            clear_rebase_journal(gd)?;
        }
    }
    Ok(())
}

/// Do not apply a stale journal to a manually started, unrelated rebase.
fn match_rebase_journal(gd: &Path) -> Result<()> {
    if let Some(journal) = read_rebase_journal(gd)? {
        let matching = ["rebase-merge", "rebase-apply"].iter().any(|dir| {
            let dir = gd.join(dir);
            fs::read_to_string(dir.join("head-name"))
                .ok()
                .is_some_and(|s| s.trim() == format!("refs/heads/{}", journal.branch))
                && fs::read_to_string(dir.join("orig-head"))
                    .ok()
                    .is_some_and(|s| s.trim() == journal.old_head)
                && fs::read_to_string(dir.join("onto"))
                    .ok()
                    .is_some_and(|s| s.trim() == journal.target)
        });
        if !matching {
            clear_rebase_journal(gd)?;
        }
    }
    Ok(())
}

fn operation_failure(
    g: &Git,
    work: &Path,
    out: super::git::GitOutput,
    wt: Option<String>,
    command: &str,
) -> Result<OpOutcome> {
    let files = conflict_files(g, work);
    let active = repo::in_progress(&repo::git_dir(g, work)?).is_some();
    if !active {
        return Err(SyncError::Git {
            cmd: command.into(),
            code: out.code,
            stderr: super::git::redact(out.stderr.trim()),
        });
    }
    Ok(OpOutcome {
        ok: false,
        conflict: !files.is_empty(),
        files,
        message: format!(
            "操作未完成{}：{}",
            at_worktree(&wt),
            super::git::redact(out.stderr.trim())
        ),
        worktree: wt,
    })
}

#[derive(Serialize, Deserialize)]
struct PatchJournal {
    receipt: super::review::PatchReceipt,
    old_head: String,
    // Older journals cannot prove completion of an externally finished am.
    #[serde(default)]
    expected_commits: Option<usize>,
    completed: bool,
}

fn patch_journal(gd: &Path) -> PathBuf {
    gd.join("offline-sync-patch.json")
}

fn read_patch_journal(gd: &Path) -> Result<Option<PatchJournal>> {
    let path = patch_journal(gd);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}

fn clear_patch_journal(gd: &Path) -> Result<()> {
    match fs::remove_file(patch_journal(gd)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn finish_patch(g: &Git, work: &Path, gd: &Path) -> Result<()> {
    if let Some(mut journal) = read_patch_journal(gd)? {
        if !journal.completed {
            journal.receipt.head = repo::rev_parse(g, work, "HEAD")?;
            journal.completed = true;
            atomic_write(&patch_journal(gd), &serde_json::to_vec(&journal)?)?;
        }
        super::review::record_patch_received(g, work, &journal.receipt)?;
        clear_patch_journal(gd)?;
    }
    Ok(())
}

/// A failed receipt write is retryable after Git has completed, including after
/// restarting the application or completing `git am` outside the application.
fn recover_patch(g: &Git, work: &Path, gd: &Path) -> Result<()> {
    if repo::in_progress(gd).is_some() {
        return Ok(());
    }
    if let Some(journal) = read_patch_journal(gd)? {
        if journal.completed {
            return finish_patch(g, work, gd);
        }
        let head = repo::rev_parse(g, work, "HEAD")?;
        if repo::current_branch(g, work).as_deref() != Some(&journal.receipt.branch) {
            return invalid("补丁接收尚未完成，请先切回原补丁分支再继续");
        }
        if head == journal.old_head {
            clear_patch_journal(gd)?;
        } else if repo::rev_parse(g, work, "ORIG_HEAD").ok().as_deref() == Some(&journal.old_head)
            && g.query(work, args!["reflog", "show", "-1", "--format=%gs", "HEAD"])?
                .starts_with("am: ")
            && g.exec(
                Some(work),
                &args!["merge-base", "--is-ancestor", &journal.old_head, &head],
                None,
                false,
            )?
            .ok()
        {
            let count = g.query(
                work,
                args![
                    "rev-list",
                    "--count",
                    format!("{}..{head}", journal.old_head)
                ],
            )?;
            if journal.expected_commits.is_none()
                || count.trim().parse::<usize>().ok() != journal.expected_commits
            {
                return invalid(
                    "无法确认整组补丁已应用完成，请保留恢复记录并检查；补丁包仍为待接收",
                );
            }
            ensure_worktree_clean(g, work)?;
            finish_patch(g, work, gd)?;
        } else {
            return invalid("补丁分支历史已变化，无法确认接收结果，请保留恢复记录并检查");
        }
    }
    Ok(())
}

/// Do not attach an old patch receipt to an unrelated, manually started am.
fn match_patch_journal(g: &Git, work: &Path, gd: &Path) -> Result<()> {
    if let Some(journal) = read_patch_journal(gd)? {
        if repo::current_branch(g, work).as_deref() != Some(&journal.receipt.branch)
            || repo::rev_parse(g, work, "ORIG_HEAD")? != journal.old_head
        {
            return invalid("当前 am 与补丁接收记录不一致，请检查原工作树和分支");
        }
    }
    Ok(())
}

/// 中止未完成的 rebase / am / merge。
pub fn abort(g: &Git, repo: &Path) -> Result<OpOutcome> {
    let gd = repo::git_dir(g, repo)?;
    let _lock = OperationLock::acquire(&gd.join("offline-sync-operation"))?;
    match repo::in_progress(&gd).as_deref() {
        Some("rebase") => {
            match_rebase_journal(&gd)?;
            g.run(repo, args!["rebase", "--abort"])?;
            // syncBase has not been changed while the operation was pending.
            clear_rebase_journal(&gd)?;
        }
        Some("am") => {
            match_patch_journal(g, repo, &gd)?;
            g.run(repo, args!["am", "--abort"])?;
            clear_patch_journal(&gd)?;
        }
        Some("merge") => {
            g.run(repo, args!["merge", "--abort"])?;
        }
        _ => {
            recover_rebase(g, repo, &gd)?;
            recover_patch(g, repo, &gd)?;
            return Ok(OpOutcome::done("没有需要中止的操作"));
        }
    }
    Ok(OpOutcome::done("已中止"))
}

/// 冲突解决后继续 rebase / am / merge。
pub fn continue_op(g: &Git, repo: &Path) -> Result<OpOutcome> {
    let gd = repo::git_dir(g, repo)?;
    let _lock = OperationLock::acquire(&gd.join("offline-sync-operation"))?;
    let operation = repo::in_progress(&gd);
    let a = match operation.as_deref() {
        Some("rebase") => {
            match_rebase_journal(&gd)?;
            args!["-c", "core.editor=true", "rebase", "--continue"]
        }
        Some("am") => {
            match_patch_journal(g, repo, &gd)?;
            args!["am", "--continue"]
        }
        Some("merge") => args!["-c", "core.editor=true", "merge", "--continue"],
        _ => {
            recover_rebase(g, repo, &gd)?;
            recover_patch(g, repo, &gd)?;
            return Ok(OpOutcome::done("没有进行中的操作"));
        }
    };
    let out = g.exec(Some(repo), &a, None, true)?;
    if out.ok() {
        match operation.as_deref() {
            Some("rebase") => finish_rebase(g, repo, &gd)?,
            Some("am") => finish_patch(g, repo, &gd)?,
            _ => {}
        }
        Ok(OpOutcome::done("已继续完成"))
    } else {
        operation_failure(g, repo, out, None, "git continue")
    }
}

// ======================================================================
// 内网端
// ======================================================================

/// 首次：`git clone --mirror <url> <mirror_dir>`
pub fn init_mirror(g: &Git, url: &str, mirror_dir: &Path) -> Result<()> {
    if repo::is_nonempty_dir(mirror_dir) {
        return invalid(format!("目录非空：{}", mirror_dir.display()));
    }
    if let Some(parent) = mirror_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    g.run_nocwd(args!["clone", "--mirror", url, mirror_dir])?;
    Ok(())
}

/// 内网 → 外网：首次或 `force_full` 时全量，否则基于上次导出的全部 ref 做增量。
pub fn export_out(
    g: &Git,
    mirror: &Path,
    transfer_dir: &Path,
    repo_name: &str,
    base_branch: &str,
    fetch_upstream: bool,
    force_full: bool,
) -> Result<ExportOutcome> {
    let _lock = OperationLock::acquire(mirror)?;
    if let Some(outcome) = recover_export(mirror)? {
        return Ok(outcome);
    }
    if !repo::is_bare(g, mirror)? {
        return invalid("导出需要在镜像（裸）仓库中进行");
    }
    if fetch_upstream {
        g.run(mirror, args!["remote", "update", "--prune"])?;
    }
    fs::create_dir_all(transfer_dir)?;

    let mut state: InternalState = repo::load_state(mirror)?;
    let base_ref = format!("refs/heads/{base_branch}");
    let rid = repo::repo_id(g, mirror, &base_ref)?;
    if let Some(prev) = &state.repo_id {
        if prev != &rid {
            return invalid("镜像仓库身份与上次导出不一致（根提交变化），请用新的镜像目录");
        }
    }

    let refs = repo::list_refs(g, mirror, &["refs/heads", "refs/tags"])?;
    let snapshot: BTreeMap<String, String> = refs.iter().cloned().collect();
    if !force_full && state.last_refs.as_ref() == Some(&snapshot) {
        return Ok(ExportOutcome::NothingToSync {
            message: "内网提交和引用均未改变，无需同步".into(),
        });
    }
    let mut full = force_full || state.last_heads.is_empty() || state.last_refs.is_none();
    let seq = state
        .out_seq
        .checked_add(1)
        .ok_or_else(|| SyncError::Invalid("导出序号溢出".into()))?;
    // Build invisibly; neither an interrupted bundle nor a patch directory is a package.
    let staging = tempfile::Builder::new()
        .prefix(".offline-sync-export-")
        .tempdir_in(transfer_dir)?;
    let mut file_name = format!(
        "{}-out-{seq:04}-{}.bundle",
        sanitize(repo_name),
        if full { "full" } else { "incr" }
    );
    let mut bundle = staging.path().join(&file_name);

    // Use full ref names: --branches/--tags can omit ambiguous branch/tag names.
    // Only heads/tags belong to the captured snapshot, not GitLab internal refs.
    let mut revisions = Vec::new();
    if full {
        revisions.push("HEAD".into());
    }
    revisions.extend(refs.iter().map(|(name, _)| name.clone()));
    let mut warnings = Vec::new();
    let mut baseline = Vec::new();
    if !full {
        // 过滤掉已被 gc 的旧对象，否则 bundle create 会报 bad object
        let base = repo::existing_objects(g, mirror, &state.last_heads)?;
        if base.len() < state.last_heads.len() {
            warnings.push(format!(
                "{} 个旧基线对象已不存在，增量包可能偏大",
                state.last_heads.len() - base.len()
            ));
        }
        revisions.extend(base.iter().map(|oid| format!("^{oid}")));
        baseline = base;
    }

    if create_and_verify_bundle(g, mirror, &bundle, &revisions, "内网没有新提交，无需同步")?
        .is_some()
    {
        // Git cannot encode ref-only changes as an empty incremental bundle. Keep
        // format 1 compatibility by publishing a full bundle with the new snapshot.
        full = true;
        baseline.clear();
        file_name = format!("{}-out-{seq:04}-full.bundle", sanitize(repo_name));
        bundle = staging.path().join(&file_name);
        warnings.push("引用发生变化但没有新对象，已回退为全量包".into());
        let mut fallback = vec!["HEAD".into()];
        fallback.extend(refs.iter().map(|(name, _)| name.clone()));
        if let Some(nothing) =
            create_and_verify_bundle(g, mirror, &bundle, &fallback, "仓库没有可导出的引用")?
        {
            return Ok(nothing);
        }
    }
    let kind = if full {
        BundleKind::Full
    } else {
        BundleKind::Incr
    };

    let ref_entries: Vec<RefEntry> = refs
        .iter()
        .map(|(n, s)| RefEntry {
            name: n.clone(),
            sha: s.clone(),
            base: None,
        })
        .collect();
    let manifest = Manifest {
        format: FORMAT,
        kind,
        repo_name: repo_name.to_string(),
        repo_id: rid.clone(),
        seq,
        created_at: now_secs(),
        payload: file_name,
        base_branch: base_branch.to_string(),
        refs: ref_entries,
        tool_version: tool_version(),
    };
    validate_bundle_snapshot(g, mirror, &bundle, &manifest, &baseline)?;
    state.repo_id = Some(rid);
    state.out_seq = seq;
    state.last_heads = refs.into_iter().map(|(_, s)| s).collect();
    state.last_refs = Some(snapshot);
    state.last_export_at = Some(now_secs());
    publish_export(mirror, transfer_dir, staging, manifest, &state, warnings)
}

fn parse_list_heads(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| {
            let (sha, name) = l.trim().split_once(' ')?;
            Some((name.to_string(), sha.to_string()))
        })
        .collect()
}

/// A ref may be omitted by Git only when its object is already in the frozen
/// exclusion baseline. Checking local existence alone would hide export races.
fn validate_bundle_snapshot(
    g: &Git,
    repo: &Path,
    bundle: &Path,
    manifest: &Manifest,
    baseline: &[String],
) -> Result<()> {
    let advertised: BTreeMap<_, _> =
        parse_list_heads(&g.query(repo, args!["bundle", "list-heads", bundle])?)
            .into_iter()
            .filter(|(name, _)| name.starts_with("refs/heads/") || name.starts_with("refs/tags/"))
            .collect();
    let wanted: BTreeMap<_, _> = manifest
        .refs
        .iter()
        .map(|r| (r.name.clone(), r.sha.clone()))
        .collect();
    if advertised
        .iter()
        .any(|(name, sha)| wanted.get(name) != Some(sha))
    {
        return invalid("manifest 与 bundle 引用不一致；请刷新后重试");
    }
    let missing: Vec<_> = wanted
        .iter()
        .filter(|(name, _)| !advertised.contains_key(*name))
        .collect();
    if !missing.is_empty() {
        if baseline.is_empty() {
            return invalid("bundle 缺少快照引用且基线无法满足；请刷新后重试");
        }
        let input = missing
            .iter()
            .map(|(_, sha)| sha.to_string())
            .chain(baseline.iter().map(|oid| format!("^{oid}")))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let uncovered = g.query_stdin(
            repo,
            args!["rev-list", "--objects", "--no-object-names", "--stdin"],
            &input,
        )?;
        if !uncovered.trim().is_empty() {
            return invalid("bundle 缺少快照引用且基线无法满足；请刷新后重试");
        }
    }
    Ok(())
}

/// Load objects without touching any refs. Even a damaged snapshot must never
/// partially fetch heads/tags before its deletion instructions have been checked.
pub(crate) fn unpack_snapshot(
    g: &Git,
    work: &Path,
    bundle: &Path,
    manifest: Option<&Manifest>,
) -> Result<BTreeMap<String, String>> {
    g.run(work, args!["bundle", "verify", bundle])?;
    let advertised: BTreeMap<String, String> =
        parse_list_heads(&g.query(work, args!["bundle", "list-heads", bundle])?)
            .into_iter()
            .filter(|(name, _)| name.starts_with("refs/heads/") || name.starts_with("refs/tags/"))
            .collect();
    let wanted: BTreeMap<String, String> = match manifest {
        Some(m) => {
            let snapshot: BTreeMap<String, String> = m
                .refs
                .iter()
                .map(|r| (r.name.clone(), r.sha.clone()))
                .collect();
            for (name, sha) in &advertised {
                if snapshot.get(name) != Some(sha) {
                    return invalid(format!("manifest 与 bundle 引用不一致：{name}"));
                }
            }
            snapshot
        }
        None => advertised,
    };
    if wanted.is_empty() {
        return invalid("包中没有可导入的分支或标签");
    }
    for (name, sha) in &wanted {
        if !super::manifest::valid_ref(name) || !super::manifest::valid_oid(sha) {
            return invalid(format!("包中引用或 SHA 无效：{name}"));
        }
    }
    // Unlike fetch, unbundle only writes the object database, never local refs,
    // FETCH_HEAD, auto-followed tags or refs in checked-out worktrees.
    g.run(work, args!["bundle", "unbundle", bundle])?;
    let input = wanted.values().cloned().collect::<Vec<_>>().join("\n") + "\n";
    let checked = g.query_stdin(
        work,
        args!["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        &input,
    )?;
    let lines: Vec<_> = checked.lines().collect();
    if lines.len() != wanted.len() {
        return invalid("无法完整验证包中的引用对象");
    }
    for ((name, sha), line) in wanted.iter().zip(lines) {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() != 2
            || parts[0] != sha
            || parts[1] == "missing"
            || (name.starts_with("refs/heads/") && parts[1] != "commit")
        {
            return invalid(format!("包缺少引用对象或分支未指向提交：{name} ({sha})"));
        }
    }
    // Bound argv for large mirrors on Windows; --quiet validates connectivity
    // without emitting the entire reachable object graph.
    g.query_stdin(
        work,
        args!["rev-list", "--objects", "--quiet", "--stdin"],
        &input,
    )?;
    if let Some(m) = manifest.filter(|m| matches!(m.kind, BundleKind::Full | BundleKind::Incr)) {
        let base = wanted
            .get(&format!("refs/heads/{}", m.base_branch))
            .ok_or_else(|| SyncError::Invalid("manifest 缺少基准分支".into()))?;
        if repo::repo_id(g, work, base)? != m.repo_id {
            return invalid("manifest 仓库身份与包中的基准分支不一致");
        }
    }
    Ok(wanted)
}

/// update-ref --stdin already batches atomically. CAS guards also reject an
/// external writer changing any observed ref during validation (no partial updates).
fn replace_refs(
    g: &Git,
    work: &Path,
    before: &BTreeMap<String, String>,
    wanted: &BTreeMap<String, String>,
) -> Result<()> {
    let mut script = String::new();
    for (name, sha) in wanted {
        match before.get(name) {
            Some(old) => script.push_str(&format!("update {name} {sha} {old}\n")),
            None => script.push_str(&format!("create {name} {sha}\n")),
        }
    }
    for (name, old) in before {
        if !wanted.contains_key(name) {
            script.push_str(&format!("delete {name} {old}\n"));
        }
    }
    g.query_stdin(work, args!["update-ref", "--no-deref", "--stdin"], &script)?;
    Ok(())
}

/// 外网 → 内网：以 patch 目录方式导入（`git am --3way`）。
pub fn import_patches(
    g: &Git,
    work: &Path,
    patch_dir: &Path,
    branch: &str,
    base_branch: &str,
    fetch_upstream: bool,
) -> Result<OpOutcome> {
    let manifest = Manifest::read_for(patch_dir)?;
    if let Some(manifest) = &manifest {
        if manifest.kind != BundleKind::Patch {
            return invalid("这不是补丁包（patch），请检查所选目录");
        }
        let identity_ref = format!("refs/remotes/origin/{}", manifest.base_branch);
        if repo::repo_id(g, work, &identity_ref)? != manifest.repo_id {
            return invalid("补丁包与当前仓库不是同一个项目（根提交不同）");
        }
    }
    let common = super::review::common_dir(g, work)?.canonicalize()?;
    let _lock = OperationLock::acquire(&common.join("offline-sync-operation"))?;
    let gd = repo::git_dir(g, work)?.canonicalize()?;
    let _work_lock = if gd != common {
        Some(OperationLock::acquire(&gd.join("offline-sync-operation"))?)
    } else {
        None
    };
    // Hash exactly the bytes passed to git am, even if transfer media changes.
    let frozen = tempfile::tempdir()?;
    let mut patches = Vec::new();
    for (index, source) in super::review::patch_files(patch_dir)?.iter().enumerate() {
        let target = frozen.path().join(format!("{index:08}.patch"));
        fs::copy(source, &target)?;
        patches.push(target);
    }
    // A file can contain multiple mail messages; count the same input units as git am.
    let mails = tempfile::tempdir()?;
    let mut split = args!["mailsplit", format!("-o{}", mails.path().display()), "--"];
    split.extend(patches.iter().map(|p| p.as_os_str().to_owned()));
    let expected_commits = g
        .query(work, split)?
        .trim()
        .parse::<usize>()
        .map_err(|_| SyncError::Invalid("无法读取补丁邮件数量".into()))?;
    let key = super::review::patch_key(g, work, &patches, manifest.as_ref())?;
    for tree in repo::list_worktrees(g, work)?
        .into_iter()
        .filter(|t| !t.bare)
    {
        let target = Path::new(&tree.path);
        if !target.exists() {
            continue;
        }
        let target_gd = repo::git_dir(g, target)?.canonicalize()?;
        if read_patch_journal(&target_gd)?.is_some_and(|j| j.receipt.key == key) {
            let _target_lock = if target_gd != common && target_gd != gd {
                Some(OperationLock::acquire(
                    &target_gd.join("offline-sync-operation"),
                )?)
            } else {
                None
            };
            if repo::in_progress(&target_gd).is_some() {
                return Ok(OpOutcome {
                    ok: false,
                    conflict: true,
                    files: conflict_files(g, target),
                    message: "该补丁包正在原工作树中应用，请解决冲突后继续或中止".into(),
                    worktree: Some(tree.path),
                });
            }
            recover_patch(g, target, &target_gd)?;
        }
    }
    if let Some(receipt) = super::review::patch_receipts(g, work)?
        .into_iter()
        .find(|r| r.key == key)
    {
        return Ok(
            OpOutcome::done(format!("该补丁包已接收至 {}，不会重复应用", receipt.branch))
                .at(Some(receipt.worktree)),
        );
    }
    recover_patch(g, work, &gd)?;
    ensure_worktree_clean(g, work)?;
    validate_branch_name(g, work, branch)?;
    if repo::rev_exists(g, work, &format!("refs/heads/{branch}")) {
        return invalid(format!("分支 {branch} 已存在，请换一个名字"));
    }
    if fetch_upstream {
        g.run(work, args!["fetch", "origin", "--prune"])?;
    }
    let base = format!("origin/{base_branch}");
    g.run(work, args!["switch", "-c", branch, &base])?;
    repo::set_sync_base(g, work, branch, base_branch)?;
    let old_head = repo::rev_parse(g, work, "HEAD")?;
    let journal = PatchJournal {
        receipt: super::review::PatchReceipt {
            key,
            branch: branch.into(),
            worktree: std::path::absolute(work)?.to_string_lossy().into_owned(),
            head: old_head.clone(),
        },
        old_head,
        expected_commits: Some(expected_commits),
        completed: false,
    };
    atomic_write(&patch_journal(&gd), &serde_json::to_vec(&journal)?)?;
    let wt_out = Some(std::path::absolute(work)?.to_string_lossy().into_owned());
    let mut a = args!["am", "--3way"];
    a.extend(patches.iter().map(Into::into));
    let out = g.exec(Some(work), &a, None, true)?;
    if out.ok() {
        finish_patch(g, work, &gd)?;
        Ok(OpOutcome::done(format!("已应用 {} 个补丁到 {branch}", patches.len())).at(wt_out))
    } else {
        operation_failure(g, work, out, wt_out, "git am --3way")
    }
}

/// 把分支 rebase 到 `origin/<onto>`（分支自己的基准：主线或发布分支）。
///
/// 分支已记录的基准与 `onto` 不同（改基准）时，用 `rebase --onto origin/<onto> origin/<旧基准>`，
/// 只搬运分支自己的提交，不把旧基准上的提交带过去。
pub fn rebase_onto(
    g: &Git,
    repo: &Path,
    branch: &str,
    onto: &str,
    fetch_upstream: bool,
) -> Result<OpOutcome> {
    // 分支可能被某个 linked worktree 检出。那时不能（也不需要）switch：
    // `git switch` 会直接报 "already used by worktree"。就地在那个目录 rebase。
    let wt = repo::linked_worktree_for(g, repo, branch).map(|w| w.path);
    let work: PathBuf = wt
        .as_deref()
        .map_or_else(|| repo.to_path_buf(), PathBuf::from);

    let gd = repo::git_dir(g, &work)?;
    let _lock = OperationLock::acquire(&gd.join("offline-sync-operation"))?;
    recover_rebase(g, &work, &gd)?;
    recover_patch(g, &work, &gd)?;
    ensure_worktree_clean(g, &work)?;
    validate_branch_name(g, &work, branch)?;
    validate_branch_name(g, &work, onto)?;
    if fetch_upstream {
        g.run(repo, args!["fetch", "origin", "--prune"])?;
    }
    let target = format!("origin/{onto}");
    if !repo::rev_exists(g, repo, &target) {
        return invalid(format!("找不到 {target}"));
    }
    let old = repo::get_sync_base(g, repo, branch).filter(|b| b != onto);
    if let Some(base) = &old {
        if !repo::rev_exists(g, repo, &format!("origin/{base}")) {
            return invalid(format!(
                "找不到已记录的旧基准 origin/{base}，无法安全改基准，请先恢复该引用"
            ));
        }
    }
    if wt.is_none() {
        g.run(&work, args!["switch", branch])?;
    }
    let journal = RebaseJournal {
        branch: branch.into(),
        new_base: onto.into(),
        old_head: repo::rev_parse(g, &work, "HEAD")?,
        target: repo::rev_parse(g, repo, &target)?,
        completed: false,
    };
    atomic_write(&rebase_journal(&gd), &serde_json::to_vec(&journal)?)?;
    let a = match &old {
        Some(b) => args!["rebase", "--onto", &target, format!("origin/{b}")],
        None => args!["rebase", &target],
    };
    let out = g.exec(Some(&work), &a, None, true)?;
    if out.ok() {
        finish_rebase(g, &work, &gd)?;
        Ok(OpOutcome::done(match &old {
            Some(b) => format!("{branch} 已从 origin/{b} 移到最新的 {target}"),
            None => format!("{branch} 已基于最新的 {target}"),
        })
        .at(wt))
    } else {
        if repo::in_progress(&gd).is_none() {
            clear_rebase_journal(&gd)?;
        }
        operation_failure(g, &work, out, wt, "git rebase")
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DeleteBranchOutcome {
    Deleted { message: String },
    NeedsForce { sha: String },
}

// Lock every registered worktree HEAD through Git's ref backend (including reftable).
// Recheck both symbolic HEADs and detached operations after prepare acquires those locks.
pub(super) fn deletion_heads(g: &Git, work: &Path, branch: &str) -> Result<Vec<PathBuf>> {
    let mut heads = Vec::new();
    for tree in repo::list_worktrees(g, work)?
        .into_iter()
        .filter(|t| !t.bare)
    {
        let gd = repo::git_dir(g, Path::new(&tree.path))?.canonicalize()?;
        let mut occupied = tree.branch.as_deref() == Some(branch);
        for state in [
            "BISECT_START",
            "rebase-merge/head-name",
            "rebase-apply/head-name",
        ] {
            match fs::read_to_string(gd.join(state)) {
                Ok(name) => occupied |= name.trim().trim_start_matches("refs/heads/") == branch,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        if occupied {
            return invalid(format!(
                "分支 {branch} 正被工作树使用（{}），请先结束操作或切换分支",
                tree.path
            ));
        }
        heads.push(gd);
    }
    heads.sort();
    Ok(heads)
}

pub(super) fn with_locked_heads(
    g: &Git,
    heads: &[PathBuf],
    action: &(dyn Fn() -> Result<()> + Sync),
) -> Result<()> {
    let Some((gd, rest)) = heads.split_first() else {
        return action();
    };
    let oid = repo::rev_parse(g, gd, "HEAD")?;
    g.ref_transaction(gd, &format!("verify HEAD {oid}\n"), &|| {
        with_locked_heads(g, rest, action)
    })
}

/// 普通删除遇到未合并分支时返回确认所需的提交；强制删除必须匹配该提交。
pub fn delete_local_branch(
    g: &Git,
    repo: &Path,
    branch: &str,
    force_at: Option<&str>,
) -> Result<DeleteBranchOutcome> {
    if repo::is_bare(g, repo)? || repo::is_mirror(g, repo) {
        return invalid("请选择普通工作仓库删除本地分支");
    }
    let gd = repo::git_dir(g, repo)?;
    let _lock = OperationLock::acquire(&gd.join("offline-sync-operation"))?;
    validate_branch_name(g, repo, branch)?;
    if !repo::rev_exists(g, repo, &format!("refs/heads/{branch}")) {
        return invalid(format!("本地分支 {branch} 不存在，请刷新列表"));
    }
    let heads = deletion_heads(g, repo, branch)?;
    let sha = repo::rev_parse(g, repo, &format!("refs/heads/{branch}"))?;
    if let Some(expected) = force_at {
        if expected != sha {
            return invalid("分支提交已变化，请刷新列表后重新确认删除");
        }
    } else {
        // 与 git branch -d 一致：优先检查上游，没有可用上游时检查 HEAD。
        let target = repo::rev_parse(g, repo, &format!("{branch}@{{upstream}}"))
            .unwrap_or_else(|_| "HEAD".into());
        let merged = g.exec(
            Some(repo),
            &args!["merge-base", "--is-ancestor", &sha, &target],
            None,
            false,
        )?;
        match merged.code {
            0 => {}
            1 => return Ok(DeleteBranchOutcome::NeedsForce { sha }),
            code => {
                return Err(SyncError::Git {
                    cmd: "git merge-base --is-ancestor".into(),
                    code,
                    stderr: merged.stderr,
                })
            }
        }
    }
    // CAS protects the checked tip. HEAD verification locks prevent a checkout
    // from slipping between the final occupancy check and the deletion commit.
    let common = super::review::common_dir(g, repo)?.canonicalize()?;
    let mut updates = format!("delete refs/heads/{branch} {sha}\n");
    if heads.contains(&common) {
        let oid = repo::rev_parse(g, &common, "HEAD")?;
        updates.push_str(&format!("verify HEAD {oid}\n"));
    }
    // Cross-worktree HEAD names are read-only to update-ref. Hold each linked
    // HEAD in its own transaction, with the shared ref deletion innermost.
    let linked: Vec<_> = heads.iter().filter(|gd| **gd != common).cloned().collect();
    with_locked_heads(g, &linked, &|| {
        g.ref_transaction(&common, &updates, &|| {
            if deletion_heads(g, repo, branch)? != heads {
                return invalid("工作树列表已变化，请刷新后重新删除");
            }
            Ok(())
        })
    })?;
    let config = g.exec(
        Some(repo),
        &args![
            "config",
            "--local",
            "--get-regexp",
            format!("^branch\\.{}\\.", regex::escape(branch))
        ],
        None,
        false,
    )?;
    if config.ok() {
        g.run(
            repo,
            args![
                "config",
                "--local",
                "--remove-section",
                format!("branch.{branch}")
            ],
        )?;
    } else if config.code != 1 {
        return Err(SyncError::Git {
            cmd: "git config --local --get-regexp".into(),
            code: config.code,
            stderr: config.stderr,
        });
    }
    Ok(DeleteBranchOutcome::Deleted {
        message: format!("已删除本地分支 {branch}"),
    })
}

// ======================================================================
// 外网端
// ======================================================================

/// 外网镜像里的全部引用。镜像是 bare 仓库，内网分支就放在 `refs/heads/*`，
/// 与内网镜像的布局一致（`repo::base_ref_prefix` 据此自动选前缀）。
fn mirror_refs(g: &Git, repo: &Path) -> Result<BTreeMap<String, String>> {
    Ok(repo::list_refs(g, repo, &["refs/heads", "refs/tags"])?
        .into_iter()
        .collect())
}

/// The bundle header determines object format; version 2 and version 3 without
/// an object-format capability use SHA-1.
fn bundle_object_format(bundle: &Path) -> Result<String> {
    use std::io::{BufRead, BufReader};

    let mut lines = BufReader::new(fs::File::open(bundle)?).lines();
    match lines.next().transpose()?.as_deref() {
        Some("# v2 git bundle") => return Ok("sha1".into()),
        Some("# v3 git bundle") => {}
        _ => return invalid("不是受支持的 Git bundle 文件"),
    }
    let mut format = None;
    for line in lines {
        let line = line?;
        if !line.starts_with('@') {
            break;
        }
        if let Some(value) = line.strip_prefix("@object-format=") {
            if format.is_some() || !matches!(value, "sha1" | "sha256") {
                return invalid("bundle 对象格式无效或不受支持");
            }
            format = Some(value.to_string());
        }
    }
    Ok(format.unwrap_or_else(|| "sha1".into()))
}

/// The manifest and mirror snapshot the caller displayed before import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportConfirmation {
    pub manifest: Manifest,
    pub last_in_seq: u32,
    pub mirror_refs: BTreeMap<String, String>,
    pub allow_full_gap: bool,
}

/// 内网 → 外网：把包导入**外网镜像**（bare 仓库）。
///
/// 镜像不是开发仓库：它只是内网状态在外网的一份只读副本，开发仓库 clone 它、
/// 把它当作 `origin`。这样 `origin` 始终是一个活的本地远端，
/// `git fetch origin <任意分支>` 和 `git worktree add` 都能正常工作；
/// 导入也不再碰开发仓库，不会和正在跑的 agent 抢工作区。
///
/// 首次和增量都先 unbundle 对象、校验，再以一次事务更新 heads/tags；
/// 首次只是多一步 `git init --bare`。
/// 刻意不用 `git clone --mirror <bundle>`：那会留下一个指向 U 盘上 bundle 文件的
/// `remote.origin`，正是旧实现里 `couldn't find remote ref` 的成因。
pub fn import_in(
    g: &Git,
    bundle: &Path,
    mirror_dir: &Path,
    confirmation: Option<&ImportConfirmation>,
) -> Result<()> {
    let confirmation =
        confirmation.ok_or_else(|| SyncError::Invalid("缺少导入确认，请刷新后重新导入".into()))?;
    let _lock = OperationLock::acquire(mirror_dir)?;
    // Resolve shared state before reading the import cursor. If the transfer
    // medium is unavailable recovery fails explicitly and import does not start.
    recover_export(mirror_dir)?;
    let manifest = Manifest::read_for(bundle)?
        .ok_or_else(|| SyncError::Invalid("包清单已缺失，请刷新后重新确认导入".into()))?;
    // Compare every manifest field; ref order alone has no meaning.
    let mut expected = confirmation.manifest.clone();
    let mut actual = manifest.clone();
    expected.refs.sort_by(|a, b| a.name.cmp(&b.name));
    actual.refs.sort_by(|a, b| a.name.cmp(&b.name));
    if expected != actual {
        return invalid("包清单已变化，请刷新后重新确认导入");
    }
    let m = &manifest;

    if matches!(m.kind, BundleKind::Back | BundleKind::Patch) {
        return invalid("这是回传包，应在内网端导入");
    }

    // All subsequent verification and unbundling uses this private copy and the
    // in-memory manifest, even if the transfer path is replaced during import.
    let frozen = tempfile::NamedTempFile::new()?;
    fs::copy(bundle, frozen.path())?;
    let bundle = frozen.path();
    let object_format = bundle_object_format(bundle)?;
    // ---------- 首次：建空镜像 ----------
    let created = !repo::is_ext_mirror(g, mirror_dir);
    let mut state: MirrorState = repo::load_state(mirror_dir)?;
    let before = if created {
        BTreeMap::new()
    } else {
        mirror_refs(g, mirror_dir)?
    };

    if state.last_in_seq != confirmation.last_in_seq || before != confirmation.mirror_refs {
        return invalid("镜像序号或引用已变化，请刷新后重新确认导入");
    }

    if created {
        if repo::is_nonempty_dir(mirror_dir) {
            return invalid(format!(
                "目录不是外网镜像，也不是空目录：{}。\
                 如果这是旧版本的开发仓库，请删除后重新导入全量包（旧仓库不再兼容）",
                mirror_dir.display()
            ));
        }
        let (major, minor, _) = g.version()?;
        let mut init = args!["init", "--bare"];
        if (major, minor) >= (2, 29) {
            init.push(format!("--object-format={object_format}").into());
        } else if object_format != "sha1" {
            return invalid("SHA-256 bundle 需要支持 SHA-256 的 Git（至少 2.29），请升级 Git");
        }
        // Older supported Git versions only support SHA-1 and lack --object-format.
        fs::create_dir_all(mirror_dir)?;
        g.run(mirror_dir, init)?;
        repo::mark_ext_mirror(g, mirror_dir)?;
    }
    let configured = g.exec(
        Some(mirror_dir),
        &args!["config", "--local", "--get", "extensions.objectFormat"],
        None,
        false,
    )?;
    let actual_format = match configured.code {
        0 => configured.stdout.trim(),
        1 => "sha1",
        code => {
            return Err(SyncError::Git {
                cmd: "git config --local --get extensions.objectFormat".into(),
                code,
                stderr: configured.stderr,
            })
        }
    };
    if actual_format != object_format {
        // An empty ref set does not imply an empty object database or state files.
        return invalid(format!(
            "镜像对象格式 {actual_format} 与 bundle 的 {object_format} 不一致；已保留全部数据。请选用新的空目录重新导入全量包"
        ));
    }

    // 空镜像只能用全量包填。不能只看"这次新建了镜像"：
    // 首次导入的 fetch 失败会留下一个已标记但没有引用的镜像，
    // 那时再导增量包就会得到一个残缺的仓库。
    if mirror_refs(g, mirror_dir)?.is_empty() && m.kind != BundleKind::Full {
        return invalid("外网镜像还是空的，首次导入必须使用全量包（full）");
    }

    if let Some(rid) = &state.repo_id {
        if rid != &m.repo_id {
            return invalid("该包与当前镜像不是同一个项目（根提交不同）");
        }
    }
    if m.kind == BundleKind::Full && m.seq < state.last_in_seq {
        g.info(format!(
            "警告：正在用较旧的全量包 #{} 回退镜像（当前 #{}）；分支和标签将按该快照同步",
            m.seq, state.last_in_seq
        ));
    }
    if m.kind == BundleKind::Full
        && state.last_in_seq > 0
        && m.seq > state.last_in_seq.saturating_add(1)
        && !confirmation.allow_full_gap
    {
        return invalid("全量包跳号需要明确确认，请刷新后确认引用变化");
    }
    if m.kind == BundleKind::Incr && state.last_in_seq > 0 {
        if m.seq <= state.last_in_seq {
            return invalid(format!(
                "包 #{} 已导入过（上次导入 #{}）",
                m.seq, state.last_in_seq
            ));
        }
        if m.seq != state.last_in_seq + 1 {
            return invalid(format!(
                "序号不连续：上次导入 #{}，本包 #{}，中间的包可能遗漏",
                state.last_in_seq, m.seq
            ));
        }
    }

    let baseline = if m.kind == BundleKind::Incr {
        before.values().cloned().collect()
    } else {
        Vec::new()
    };
    validate_bundle_snapshot(g, mirror_dir, bundle, m, &baseline)?;

    let wanted = unpack_snapshot(g, mirror_dir, bundle, Some(&manifest))?;
    let current: MirrorState = repo::load_state(mirror_dir)?;
    if current.last_in_seq != state.last_in_seq
        || current.repo_id != state.repo_id
        || mirror_refs(g, mirror_dir)? != before
    {
        return invalid("镜像序号或引用已变化，请刷新后重新确认导入");
    }
    // Format 1 full/incr manifests are complete mirror snapshots: prune tags as
    // well as branches.
    replace_refs(g, mirror_dir, &before, &wanted)?;

    state.last_in_seq = m.seq;
    if state.repo_id.is_none() {
        state.repo_id = Some(m.repo_id.clone());
    }

    state.last_import_at = Some(now_secs());

    let after = mirror_refs(g, mirror_dir)?;

    // 让镜像的 HEAD 指向一个真实存在的分支。`git init --bare` 的 HEAD 指向
    // `init.defaultBranch`（可能是 master 或任何名字），如果它不存在，
    // 从镜像 clone 出来的开发仓库不会检出任何分支。
    // 优先用 manifest 的主线分支，否则退而取任意一个分支。
    let head_ok = repo::current_branch(g, mirror_dir)
        .is_some_and(|b| after.contains_key(&format!("refs/heads/{b}")));
    if !head_ok {
        let wanted = Some(format!("refs/heads/{}", manifest.base_branch))
            .filter(|h| after.contains_key(h))
            .or_else(|| after.keys().find(|n| n.starts_with("refs/heads/")).cloned());
        if let Some(head) = wanted {
            g.run(mirror_dir, args!["symbolic-ref", "HEAD", &head])?;
        }
    }

    // Persist the sequence last: a failed HEAD repair or state write leaves this
    // same package retryable; refs are already a validated idempotent snapshot.
    repo::save_state(mirror_dir, &state)?;
    Ok(())
}

/// 在外网仓库设置提交身份和换行符策略。
pub fn configure_repo(g: &Git, repo: &Path, name: &str, email: &str) -> Result<()> {
    if !name.trim().is_empty() {
        g.run(repo, args!["config", "user.name", name.trim()])?;
    }
    if !email.trim().is_empty() {
        g.run(repo, args!["config", "user.email", email.trim()])?;
    }
    g.run(repo, args!["config", "core.autocrlf", "input"])?;
    Ok(())
}

/// 推送到镜像的占位 URL。镜像是内网状态的只读副本，推进去会污染它，
/// 于是把 push 地址设成一个不存在的远端，`git push` 会立刻失败。
const PUSH_DISABLED: &str = "OFFLINE-SYNC-PUSH-TO-MIRROR-DISABLED";

/// 从外网镜像克隆一个开发仓库。`origin` 指向本地镜像目录，永远有效。
pub fn create_dev_repo(
    g: &Git,
    mirror_dir: &Path,
    dev_dir: &Path,
    name: &str,
    email: &str,
) -> Result<()> {
    if !repo::is_ext_mirror(g, mirror_dir) {
        return invalid(format!(
            "{} 不是外网镜像，请先导入全量包",
            mirror_dir.display()
        ));
    }
    if repo::is_nonempty_dir(dev_dir) {
        return invalid(format!("目录非空：{}", dev_dir.display()));
    }
    if let Some(parent) = dev_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    g.run_nocwd(args!["clone", mirror_dir, dev_dir])?;
    g.run(
        dev_dir,
        args!["remote", "set-url", "--push", "origin", PUSH_DISABLED],
    )?;
    configure_repo(g, dev_dir, name, email)?;
    Ok(())
}

/// 两个路径是否指向同一个目录。优先比较 canonicalize 后的结果
/// （消解软链接、`..` 和 macOS 的 /tmp → /private/tmp），失败时退回字符串比较。
fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// 开发仓库从镜像同步：内网分支的新增、更新、删除都由这一步带过来。
///
/// 先确认 `origin` 真的指向本工具的镜像再动手：这一步带 `--prune --prune-tags`，
/// 万一配置里的开发仓库路径填错、落到某个无关仓库上，会删掉那个仓库的本地 tag。
pub fn sync_dev_repo(g: &Git, dev_dir: &Path, mirror_dir: &Path) -> Result<()> {
    validate_dev_origin(g, dev_dir, mirror_dir)?;
    g.run(
        dev_dir,
        args![
            "fetch",
            "--no-tags",
            "--prune",
            "--refmap=",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
            "+refs/tags/*:refs/tags/*"
        ],
    )?;
    Ok(())
}

/// Validate the resolved fetch URL, including relative local paths and insteadOf.
fn validate_dev_origin(g: &Git, dev: &Path, mirror: &Path) -> Result<()> {
    if !repo::is_ext_mirror(g, mirror) {
        return invalid("所选目录不是外网镜像");
    }
    validate_dev_repo_origin(g, dev, mirror)
}

fn validate_dev_repo_origin(g: &Git, dev: &Path, mirror: &Path) -> Result<()> {
    if repo::is_bare(g, dev)? {
        return invalid("开发仓库不能是裸仓库");
    }
    let top = g.query(dev, args!["rev-parse", "--show-toplevel"])?;
    if !same_dir(dev, Path::new(top.trim())) {
        return invalid("开发目录必须是工作树根目录");
    }
    let urls = g.query(dev, args!["remote", "get-url", "--all", "origin"])?;
    let urls: Vec<_> = urls.lines().collect();
    if urls.len() != 1 {
        return invalid("开发仓库 origin 必须只有一个镜像地址");
    }
    let raw = urls[0].strip_prefix("file://").unwrap_or(urls[0]);
    let path = Path::new(raw);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        dev.join(path)
    };
    if !same_dir(&path, mirror) {
        return invalid("开发仓库的实际 origin 未绑定所选镜像");
    }
    Ok(())
}

/// Only a missing directory or a readable, empty real directory can be cloned.
fn can_clone_into(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.into()),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            invalid("开发目录不是安全的普通目录")
        }
        Ok(_) => Ok(fs::read_dir(path)?.next().transpose()?.is_none()),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn sync_updates(
    g: &Git,
    mirror: &Path,
    bundle: Option<&Path>,
    confirmation: Option<&ImportConfirmation>,
    dev_dirs: &[String],
    name: &str,
    email: &str,
) -> Result<()> {
    g.check_cancelled()?;
    if let Some(bundle) = bundle {
        import_in(g, bundle, mirror, confirmation)?;
    }
    for path in dev_dirs {
        g.check_cancelled()?;
        let dev = Path::new(path);
        if can_clone_into(dev)? {
            create_dev_repo(g, mirror, dev, name, email)?;
        } else {
            sync_dev_repo(g, dev, mirror)?;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSyncStatus {
    pub path: String,
    pub status: String,
    pub error: Option<String>,
}

pub fn dev_sync_status(g: &Git, mirror: &Path, dev_dirs: &[String]) -> Vec<DevSyncStatus> {
    // 同一轮查询共用镜像身份和引用快照，不随开发仓库数重复启动 Git。
    let mut wanted = None;
    dev_dirs
        .iter()
        .map(|path| {
            let inspected = (|| -> Result<&str> {
                if can_clone_into(Path::new(path))? {
                    return Ok("notCloned");
                }
                let dev = Path::new(path);
                if wanted.is_none() {
                    if !repo::is_ext_mirror(g, mirror) {
                        return invalid("所选目录不是外网镜像");
                    }
                    wanted = Some(mirror_refs(g, mirror)?);
                }
                validate_dev_repo_origin(g, dev, mirror)?;
                let actual: BTreeMap<_, _> =
                    repo::list_refs(g, dev, &["refs/remotes/origin", "refs/tags"])?
                        .into_iter()
                        .filter(|(name, _)| name != "refs/remotes/origin/HEAD")
                        .map(|(name, oid)| {
                            (name.replacen("refs/remotes/origin/", "refs/heads/", 1), oid)
                        })
                        .collect();
                Ok(if Some(&actual) == wanted.as_ref() {
                    "upToDate"
                } else {
                    "needsFetch"
                })
            })();
            match inspected {
                Ok(status) => DevSyncStatus {
                    path: path.clone(),
                    status: status.into(),
                    error: None,
                },
                Err(error) => DevSyncStatus {
                    path: path.clone(),
                    status: "unknown".into(),
                    error: Some(super::git::redact(&error.to_string())),
                },
            }
        })
        .collect()
}

/// 新建开发分支。给了 `worktree_path` 就建成独立 worktree（多分支并行开发），
/// 否则在当前工作树上 `switch -c`。
pub fn create_branch(
    g: &Git,
    repo: &Path,
    name: &str,
    base_branch: &str,
    worktree_path: Option<&Path>,
) -> Result<()> {
    validate_branch_name(g, repo, name)?;
    if repo::rev_exists(g, repo, &format!("refs/heads/{name}")) {
        return invalid(format!("分支 {name} 已存在"));
    }
    let base = format!("origin/{base_branch}");
    if !repo::rev_exists(g, repo, &base) {
        return invalid(format!("找不到 {base}，请先导入内网包并同步开发仓库"));
    }
    match worktree_path {
        Some(wt) => {
            if repo::is_nonempty_dir(wt) {
                return invalid(format!("worktree 目录非空：{}", wt.display()));
            }
            if let Some(parent) = wt.parent() {
                fs::create_dir_all(parent)?;
            }
            g.run(repo, args!["worktree", "add", wt, "-b", name, base])?;
        }
        None => {
            g.run(repo, args!["switch", "-c", name, base])?;
        }
    };
    // syncBase 存在 git config 里，主仓库和所有 worktree 共享，写一次即可
    repo::set_sync_base(g, repo, name, base_branch)?;
    Ok(())
}

/// 未提交的修改会被导出漏掉。要查所有工作树，不只主工作树：
/// 分支很可能是在某个 linked worktree 里开发的。
fn dirty_warning(g: &Git, repo: &Path) -> Option<String> {
    let dirty: Vec<String> = repo::dirty_worktrees(g, repo)
        .into_iter()
        .map(|w| match &w.branch {
            Some(b) => format!("{b}（{}）", w.path),
            None => w.path.clone(),
        })
        .collect();
    (!dirty.is_empty())
        .then(|| format!("以下工作树有未提交的修改，不会被导出：{}", dirty.join("、")))
}

/// Bind the return package to both the selected mirror and the development history.
/// Run before recovery/publication: even a pending export belongs to this project.
fn return_source(
    g: &Git,
    dev: &Path,
    mirror: &Path,
    mainline: &str,
) -> Result<(MirrorState, String)> {
    validate_dev_origin(g, dev, mirror)?;
    let state: MirrorState = repo::load_state(mirror)?;
    let identity = repo::repo_id(g, mirror, &format!("refs/heads/{mainline}"))?;
    let dev_identity = repo::repo_id(g, dev, &format!("refs/remotes/origin/{mainline}"))?;
    if dev_identity != identity || state.repo_id.as_ref().is_some_and(|id| id != &identity) {
        return invalid("开发仓库、镜像和同步状态的项目身份不一致，不能导出回传");
    }
    Ok((state, identity))
}

/// 外网 → 内网：打包内网还没有的提交（`<branches> --not --remotes=origin`）。
#[allow(clippy::too_many_arguments)]
pub fn export_back(
    g: &Git,
    repo: &Path,
    mirror_dir: &Path,
    branches: &[String],
    transfer_dir: &Path,
    repo_name: &str,
    base_branch: &str,
    releases: &[String],
) -> Result<ExportOutcome> {
    let _lock = OperationLock::acquire(mirror_dir)?;
    let (mut state, rid) = return_source(g, repo, mirror_dir, base_branch)?;
    if let Some(outcome) = recover_export(mirror_dir)? {
        return Ok(outcome);
    }
    if branches.is_empty() {
        return invalid("请至少选择一个分支");
    }
    fs::create_dir_all(transfer_dir)?;
    let staging = tempfile::Builder::new()
        .prefix(".offline-sync-export-")
        .tempdir_in(transfer_dir)?;
    // 回传序号由镜像统一分配：多个开发仓库 / worktree 各自计数会撞号
    let seq = state
        .back_seq
        .checked_add(1)
        .ok_or_else(|| SyncError::Invalid("回传序号溢出".into()))?;
    let file_name = format!("{}-back-{seq:04}.bundle", sanitize(repo_name));
    let bundle = staging.path().join(&file_name);

    let mut refs = Vec::new();
    let mut revisions = Vec::new();
    for b in branches {
        let r = format!("refs/heads/{b}");
        refs.push(RefEntry {
            name: r.clone(),
            sha: repo::rev_parse(g, repo, &r)?,
            base: Some(repo::resolve_base(g, repo, b, base_branch, releases).0),
        });
        revisions.push(r);
    }
    let baseline: Vec<_> = repo::list_refs(g, repo, &["refs/remotes/origin"])?
        .into_iter()
        .map(|(_, oid)| oid)
        .collect();
    revisions.extend(baseline.iter().map(|oid| format!("^{oid}")));

    if let Some(nothing) = create_and_verify_bundle(
        g,
        repo,
        &bundle,
        &revisions,
        "所选分支没有内网尚未包含的新提交",
    )? {
        return Ok(nothing);
    }

    let manifest = Manifest {
        format: FORMAT,
        kind: BundleKind::Back,
        repo_name: repo_name.to_string(),
        repo_id: rid,
        seq,
        created_at: now_secs(),
        payload: file_name,
        base_branch: base_branch.to_string(),
        refs,
        tool_version: tool_version(),
    };
    validate_bundle_snapshot(g, repo, &bundle, &manifest, &baseline)?;
    state.back_seq = seq;
    publish_export(
        mirror_dir,
        transfer_dir,
        staging,
        manifest,
        &state,
        dirty_warning(g, repo).into_iter().collect(),
    )
}

/// 外网 → 内网：导出 patch 目录（`git format-patch --binary origin/<base>..<branch>`）。
#[allow(clippy::too_many_arguments)]
pub fn export_patches(
    g: &Git,
    repo: &Path,
    mirror_dir: &Path,
    branch: &str,
    transfer_dir: &Path,
    repo_name: &str,
    base_branch: &str,
    releases: &[String],
) -> Result<ExportOutcome> {
    let _lock = OperationLock::acquire(mirror_dir)?;
    let (mut state, rid) = return_source(g, repo, mirror_dir, base_branch)?;
    if let Some(outcome) = recover_export(mirror_dir)? {
        return Ok(outcome);
    }
    let seq = state
        .back_seq
        .checked_add(1)
        .ok_or_else(|| SyncError::Invalid("回传序号溢出".into()))?;
    let dir_name = format!(
        "{}-patch-{seq:04}-{}",
        sanitize(repo_name),
        sanitize(branch)
    );
    fs::create_dir_all(transfer_dir)?;
    let staging = tempfile::Builder::new()
        .prefix(".offline-sync-export-")
        .tempdir_in(transfer_dir)?;
    let dir = staging.path().join(&dir_name);
    let (branch_base, _) = repo::resolve_base(g, repo, branch, base_branch, releases);
    let from = format!("origin/{branch_base}");
    if !repo::rev_exists(g, repo, &from) {
        return invalid(format!("找不到 {branch} 的基准分支 {from}"));
    }
    // Freeze both ends: validation, format-patch and manifest must describe one snapshot.
    let base = repo::rev_parse(g, repo, &from)?;
    let tip = repo::rev_parse(g, repo, &format!("refs/heads/{branch}"))?;
    let range = format!("{base}..{tip}");
    if !g
        .query(repo, args!["rev-list", "--merges", "--max-count=1", &range])?
        .trim()
        .is_empty()
    {
        return invalid("待导出范围包含合并提交，Patch 会遗漏合并时的改动；请使用 Bundle 回传");
    }
    if repo::commits_between(g, repo, &base, &tip)?.is_empty() {
        return Ok(ExportOutcome::NothingToSync {
            message: format!("{branch} 相对 {from} 没有新提交"),
        });
    }
    for oid in g.query(repo, args!["rev-list", &range])?.lines() {
        if g.query(
            repo,
            args![
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-only",
                "-r",
                oid
            ],
        )?
        .trim()
        .is_empty()
        {
            return invalid("待导出范围包含空提交，Patch 无法保留空提交；请使用 Bundle 回传");
        }
    }
    fs::create_dir_all(&dir)?;
    g.run(repo, args!["format-patch", "--binary", "-o", &dir, range])?;

    let refs = vec![RefEntry {
        name: format!("refs/heads/{branch}"),
        sha: tip,
        base: Some(branch_base),
    }];
    let manifest = Manifest {
        format: FORMAT,
        kind: BundleKind::Patch,
        repo_name: repo_name.to_string(),
        repo_id: rid,
        seq,
        created_at: now_secs(),
        payload: dir_name,
        base_branch: base_branch.to_string(),
        refs,
        tool_version: tool_version(),
    };
    state.back_seq = seq;
    publish_export(
        mirror_dir,
        transfer_dir,
        staging,
        manifest,
        &state,
        dirty_warning(g, repo).into_iter().collect(),
    )
}
