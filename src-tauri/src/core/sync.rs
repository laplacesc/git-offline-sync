//! 同步流程。
//!
//! 内网端（能访问 GitLab）：init_mirror → export_out → import_back / import_patches → rebase_onto → push
//! 外网端（AI 开发）：import_in → create_branch → export_back / export_patches

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::error::{invalid, Result, SyncError};
use super::git::Git;
use super::manifest::{BundleKind, Manifest, RefEntry, FORMAT};
use super::repo::{self, CommitInfo, InternalState, MirrorState};
use crate::args;

pub const MIN_GIT: (u32, u32) = (2, 25);

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
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
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
    wt.as_ref().map(|p| format!("（在 {p}）")).unwrap_or_default()
}

/// `git bundle create` + `bundle verify`，两端导出共用。
///
/// 返回 `Some(NothingToSync)` 表示没有可打包的提交，调用方直接返回它。
/// 任何失败都会删掉半成品：此时 manifest 还没写，残包会被 `list_packages`
/// 当成「未知」类型的可导入包列在界面上。
fn create_and_verify_bundle(
    g: &Git,
    cwd: &Path,
    bundle: &Path,
    a: Vec<std::ffi::OsString>,
    empty_msg: &str,
) -> Result<Option<ExportOutcome>> {
    let out = g.exec(Some(cwd), &a, None, true)?;
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
            stderr: out.stderr.trim().to_string(),
        });
    }
    if let Err(e) = g.run(cwd, args!["bundle", "verify", bundle]) {
        let _ = fs::remove_file(bundle);
        return Err(e);
    }
    Ok(None)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefChange {
    pub name: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInResult {
    /// 本次导入新建了外网镜像（首次导入）
    pub created: bool,
    pub seq: Option<u32>,
    pub changes: Vec<RefChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedBranch {
    /// 包里的分支名
    pub source: String,
    /// 实际写入的本地分支名（非快进时会改名）
    pub local: String,
    pub sha: String,
    /// 该分支的基准分支（来自 manifest，缺失时按前缀推断）
    pub base: String,
    pub commits: Vec<CommitInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBackResult {
    pub branches: Vec<ImportedBranch>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub manifest: Option<Manifest>,
    pub manifest_path: Option<String>,
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

fn ensure_worktree_clean(g: &Git, repo: &Path) -> Result<()> {
    if repo::is_bare(g, repo)? {
        return invalid("这是裸仓库（镜像），请选择工作仓库");
    }
    if let Some(op) = repo::in_progress(&repo::git_dir(g, repo)?) {
        return invalid(format!("仓库中有未完成的 {op}，请先解决冲突或中止"));
    }
    let dirty = g.query(repo, args!["status", "--porcelain", "--untracked-files=no"])?;
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

/// 列出传输目录里的包（按创建时间倒序）。没有 manifest 的 `.bundle` 也会列出。
pub fn list_packages(dir: &Path) -> Result<Vec<PackageInfo>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    let mut seen = std::collections::HashSet::new();
    for entry in fs::read_dir(dir)? {
        let p = entry?.path();
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if let Some(stem) = name.strip_suffix(".manifest.json") {
            let text = fs::read_to_string(&p)?;
            let m: Manifest = match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let payload = dir.join(&m.payload);
            seen.insert(stem.to_string());
            out.push(PackageInfo {
                payload_exists: payload.exists(),
                payload_path: payload.to_string_lossy().into_owned(),
                manifest_path: Some(p.to_string_lossy().into_owned()),
                manifest: Some(m),
            });
        }
    }
    for entry in fs::read_dir(dir)? {
        let p = entry?.path();
        if p.extension().is_some_and(|e| e == "bundle") {
            let stem = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            if !seen.contains(&stem) {
                out.push(PackageInfo {
                    manifest: None,
                    manifest_path: None,
                    payload_exists: true,
                    payload_path: p.to_string_lossy().into_owned(),
                });
            }
        }
    }
    out.sort_by_key(|p| std::cmp::Reverse(p.manifest.as_ref().map(|m| m.created_at).unwrap_or(0)));
    Ok(out)
}

pub fn list_commits(g: &Git, repo: &Path, from: &str, to: &str) -> Result<Vec<CommitInfo>> {
    repo::commits_between(g, repo, from, to)
}

/// 中止未完成的 rebase / am / merge。
pub fn abort(g: &Git, repo: &Path) -> Result<OpOutcome> {
    let gd = repo::git_dir(g, repo)?;
    match repo::in_progress(&gd).as_deref() {
        Some("rebase") => g.run(repo, args!["rebase", "--abort"])?,
        Some("am") => g.run(repo, args!["am", "--abort"])?,
        Some("merge") => g.run(repo, args!["merge", "--abort"])?,
        _ => return Ok(OpOutcome::done("没有需要中止的操作")),
    };
    Ok(OpOutcome::done("已中止"))
}

/// 冲突解决后继续 rebase / am。
pub fn continue_op(g: &Git, repo: &Path) -> Result<OpOutcome> {
    let gd = repo::git_dir(g, repo)?;
    let a = match repo::in_progress(&gd).as_deref() {
        Some("rebase") => args!["-c", "core.editor=true", "rebase", "--continue"],
        Some("am") => args!["am", "--continue"],
        _ => return Ok(OpOutcome::done("没有进行中的操作")),
    };
    let out = g.exec(Some(repo), &a, None, true)?;
    if out.ok() {
        Ok(OpOutcome::done("已继续完成"))
    } else {
        Ok(OpOutcome {
            ok: false,
            conflict: true,
            files: conflict_files(g, repo),
            message: out.stderr.trim().to_string(),
            worktree: None,
        })
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
    let full = force_full || state.last_heads.is_empty();
    let seq = state.out_seq + 1;
    let kind = if full { BundleKind::Full } else { BundleKind::Incr };
    let file_name = format!(
        "{}-out-{seq:04}-{}.bundle",
        sanitize(repo_name),
        if full { "full" } else { "incr" }
    );
    let bundle = transfer_dir.join(&file_name);

    // 只打包分支和 tag（GitLab 镜像里的 refs/merge-requests、refs/keep-around 等不需要）
    let mut a = args!["bundle", "create", &bundle];
    if full {
        a.push("HEAD".into());
    }
    a.push("--branches".into());
    a.push("--tags".into());
    let mut warnings = Vec::new();
    if !full {
        // 过滤掉已被 gc 的旧对象，否则 bundle create 会报 bad object
        let base = repo::existing_objects(g, mirror, &state.last_heads)?;
        if base.len() < state.last_heads.len() {
            warnings.push(format!(
                "{} 个旧基线对象已不存在，增量包可能偏大",
                state.last_heads.len() - base.len()
            ));
        }
        a.push("--not".into());
        a.extend(base.iter().map(Into::into));
    }

    if let Some(nothing) =
        create_and_verify_bundle(g, mirror, &bundle, a, "内网没有新提交，无需同步")?
    {
        return Ok(nothing);
    }

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
        refs: ref_entries.clone(),
        tool_version: tool_version(),
    };
    let mpath = manifest.write_for(&bundle)?;

    state.repo_id = Some(rid);
    state.out_seq = seq;
    state.last_heads = refs.into_iter().map(|(_, s)| s).collect();
    state.last_export_at = Some(now_secs());
    repo::save_state(mirror, &state)?;
    g.info(format!("已导出 #{seq}：{}", bundle.display()));

    Ok(ExportOutcome::Exported {
        kind,
        seq,
        payload: bundle.to_string_lossy().into_owned(),
        manifest: mpath.to_string_lossy().into_owned(),
        refs: ref_entries,
        warnings,
    })
}

fn parse_list_heads(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| {
            let (sha, name) = l.trim().split_once(' ')?;
            Some((name.to_string(), sha.to_string()))
        })
        .collect()
}

/// 外网 → 内网：把回传 bundle 中的分支导入工作仓库。
/// 分支已存在且无法快进时，导入为 `<分支>-import-<序号>`，不覆盖本地提交。
pub fn import_back(
    g: &Git,
    work: &Path,
    bundle: &Path,
    base_branch: &str,
    releases: &[String],
) -> Result<ImportBackResult> {
    if repo::is_bare(g, work)? || repo::is_mirror(g, work) {
        return invalid("请在工作仓库（非镜像）中导入回传包");
    }
    let manifest = Manifest::read_for(bundle)?;
    let mut warnings = Vec::new();
    let base_ref = format!("refs/remotes/origin/{base_branch}");
    if let Some(m) = &manifest {
        if !matches!(m.kind, BundleKind::Back) {
            return invalid("这不是回传包（back），请检查所选文件");
        }
        if repo::rev_exists(g, work, &base_ref) && repo::repo_id(g, work, &base_ref)? != m.repo_id {
            return invalid("回传包与当前仓库不是同一个项目（根提交不同）");
        }
    } else {
        warnings.push("未找到 manifest，跳过仓库身份检查".into());
    }

    g.run(work, args!["bundle", "verify", bundle])?;
    let heads = parse_list_heads(&g.query(work, args!["bundle", "list-heads", bundle])?);
    // 分支名 → 检出它的工作树路径。不能只看主工作树的 HEAD：
    // 被 linked worktree 占用的分支同样 fetch 不进去，git 会报
    // "refusing to fetch into branch ... checked out at ..."，
    // 那条消息不含 non-fast-forward/rejected，会被当成未知错误抛出，
    // 而此时循环里前面的分支已经导入了，留下一次半完成的导入。
    let checked_out: std::collections::HashMap<String, String> = repo::list_worktrees(g, work)
        .unwrap_or_default()
        .into_iter()
        .filter(|w| !w.bare)
        .filter_map(|w| w.branch.clone().map(|b| (b, w.path)))
        .collect();
    let seq_tag = manifest
        .as_ref()
        .map(|m| format!("{:04}", m.seq))
        .unwrap_or_else(|| now_secs().to_string());

    // 先把所有被检出的分支一次查清再动手：中途失败会留下一次半完成的导入
    let blocked: Vec<String> = heads
        .iter()
        .filter_map(|(name, _)| name.strip_prefix("refs/heads/"))
        .filter_map(|b| checked_out.get(b).map(|w| (b, w)))
        .map(|(b, w)| format!("{b}（在 {w}）"))
        .collect();
    if !blocked.is_empty() {
        return invalid(format!(
            "这些分支已被检出，无法直接导入，请先在对应工作树切换到其他分支：{}",
            blocked.join("、")
        ));
    }

    let mut branches = Vec::new();
    for (name, sha) in heads {
        let Some(branch) = name.strip_prefix("refs/heads/") else {
            continue;
        };
        let mut local = branch.to_string();
        let out = g.exec(
            Some(work),
            &args!["fetch", bundle, format!("refs/heads/{branch}:refs/heads/{branch}")],
            None,
            true,
        )?;
        if !out.ok() {
            if out.stderr.contains("non-fast-forward") || out.stderr.contains("rejected") {
                local = format!("{branch}-import-{seq_tag}");
                g.run(
                    work,
                    args!["fetch", bundle, format!("refs/heads/{branch}:refs/heads/{local}")],
                )?;
                warnings.push(format!(
                    "本地 {branch} 与回传内容已分叉（可能在内网 rebase 过），已导入为 {local}"
                ));
            } else {
                return Err(SyncError::Git {
                    cmd: format!("git fetch {}", bundle.display()),
                    code: out.code,
                    stderr: out.stderr.trim().to_string(),
                });
            }
        }
        let recorded = manifest
            .as_ref()
            .and_then(|m| m.refs.iter().find(|r| r.name == name))
            .and_then(|r| r.base.clone());
        let base = match recorded {
            Some(b) => b,
            None => repo::infer_base(g, work, &local, base_branch, releases, "refs/remotes/origin/"),
        };
        repo::set_sync_base(g, work, &local, &base)?;
        let origin_base = format!("refs/remotes/origin/{base}");
        let commits = if repo::rev_exists(g, work, &origin_base) {
            repo::commits_between(g, work, &origin_base, &format!("refs/heads/{local}"))?
        } else {
            warnings.push(format!(
                "{local} 的基准分支 origin/{base} 不存在，请先 fetch origin"
            ));
            vec![]
        };
        branches.push(ImportedBranch {
            source: branch.to_string(),
            local,
            sha,
            base,
            commits,
        });
    }
    if branches.is_empty() {
        return invalid("回传包里没有分支");
    }
    Ok(ImportBackResult { branches, warnings })
}

/// 外网 → 内网：以 patch 目录方式导入（`git am --3way`）。
#[allow(clippy::too_many_arguments)]
pub fn import_patches(
    g: &Git,
    work: &Path,
    patch_dir: &Path,
    branch: &str,
    base_branch: &str,
    fetch_upstream: bool,
    worktree_path: Option<&Path>,
) -> Result<OpOutcome> {
    // 建成独立 worktree 时不碰主工作树，也就不要求它干净；
    // 只有要在主工作树上 switch 时才需要它干净。
    if worktree_path.is_none() {
        ensure_worktree_clean(g, work)?;
    } else if repo::is_bare(g, work)? {
        return invalid("这是裸仓库（镜像），请选择工作仓库");
    }
    validate_branch_name(g, work, branch)?;
    if repo::rev_exists(g, work, &format!("refs/heads/{branch}")) {
        return invalid(format!("分支 {branch} 已存在，请换一个名字"));
    }
    let mut patches: Vec<PathBuf> = fs::read_dir(patch_dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "patch"))
        .collect();
    patches.sort();
    if patches.is_empty() {
        return invalid("目录里没有 .patch 文件");
    }
    if fetch_upstream {
        g.run(work, args!["fetch", "origin", "--prune"])?;
    }
    let base = format!("origin/{base_branch}");
    // 补丁应用到哪个目录：给了 worktree 就在那里建分支并 am，
    // 不抢主工作树（内网工作仓库可能正开着别的分支）。
    let target: PathBuf = match worktree_path {
        Some(wt) => {
            if repo::is_nonempty_dir(wt) {
                return invalid(format!("worktree 目录非空：{}", wt.display()));
            }
            if let Some(parent) = wt.parent() {
                fs::create_dir_all(parent)?;
            }
            g.run(work, args!["worktree", "add", wt, "-b", branch, &base])?;
            wt.to_path_buf()
        }
        None => {
            g.run(work, args!["switch", "-c", branch, &base])?;
            work.to_path_buf()
        }
    };
    repo::set_sync_base(g, work, branch, base_branch)?;
    let wt_out = worktree_path.map(|p| p.to_string_lossy().into_owned());
    let mut a = args!["am", "--3way"];
    a.extend(patches.iter().map(Into::into));
    let out = g.exec(Some(&target), &a, None, true)?;
    if out.ok() {
        Ok(OpOutcome::done(format!("已应用 {} 个补丁到 {branch}", patches.len())).at(wt_out))
    } else {
        Ok(OpOutcome {
            ok: false,
            conflict: true,
            files: conflict_files(g, &target),
            message: format!("补丁应用冲突{}：解决后点击“继续”，或点击“中止”", at_worktree(&wt_out)),
            worktree: wt_out,
        })
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
    let work: PathBuf = wt.as_deref().map_or_else(|| repo.to_path_buf(), PathBuf::from);

    ensure_worktree_clean(g, &work)?;
    if fetch_upstream {
        g.run(repo, args!["fetch", "origin", "--prune"])?;
    }
    let target = format!("origin/{onto}");
    if !repo::rev_exists(g, repo, &target) {
        return invalid(format!("找不到 {target}"));
    }
    let old = repo::get_sync_base(g, repo, branch)
        .filter(|b| b != onto && repo::rev_exists(g, repo, &format!("origin/{b}")));
    if wt.is_none() {
        g.run(&work, args!["switch", branch])?;
    }
    // 先写记录：冲突后“继续”完成时，记录也已经是新基准
    repo::set_sync_base(g, repo, branch, onto)?;
    let a = match &old {
        Some(b) => args!["rebase", "--onto", &target, format!("origin/{b}")],
        None => args!["rebase", &target],
    };
    let out = g.exec(Some(&work), &a, None, true)?;
    if out.ok() {
        Ok(OpOutcome::done(match &old {
            Some(b) => format!("{branch} 已从 origin/{b} 移到最新的 {target}"),
            None => format!("{branch} 已基于最新的 {target}"),
        })
        .at(wt))
    } else {
        Ok(OpOutcome {
            ok: false,
            conflict: true,
            files: conflict_files(g, &work),
            message: format!("rebase 冲突{}：解决后点击“继续”，或点击“中止”", at_worktree(&wt)),
            worktree: wt,
        })
    }
}

/// 推送到内网远程。拒绝在镜像仓库执行（mirror 推送会覆盖/删除远程分支）。
pub fn push_branch(g: &Git, work: &Path, branch: &str, force_with_lease: bool) -> Result<OpOutcome> {
    if repo::is_bare(g, work)? || repo::is_mirror(g, work) {
        return invalid("禁止在镜像仓库中推送：会覆盖或删除远程分支。请在工作仓库中推送");
    }
    let mut a = args!["push", "-u"];
    if force_with_lease {
        a.push("--force-with-lease".into());
    }
    a.push("origin".into());
    a.push(format!("refs/heads/{branch}:refs/heads/{branch}").into());
    g.run(work, a)?;
    Ok(OpOutcome::done(format!("已推送 {branch}")))
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

/// 内网 → 外网：把包导入**外网镜像**（bare 仓库）。
///
/// 镜像不是开发仓库：它只是内网状态在外网的一份只读副本，开发仓库 clone 它、
/// 把它当作 `origin`。这样 `origin` 始终是一个活的本地远端，
/// `git fetch origin <任意分支>` 和 `git worktree add` 都能正常工作；
/// 导入也不再碰开发仓库，不会和正在跑的 agent 抢工作区。
///
/// 首次和增量走同一条 fetch 路径，首次只是多一步 `git init --bare`。
/// 刻意不用 `git clone --mirror <bundle>`：那会留下一个指向 U 盘上 bundle 文件的
/// `remote.origin`，正是旧实现里 `couldn't find remote ref` 的成因。
pub fn import_in(g: &Git, bundle: &Path, mirror_dir: &Path, allow_gap: bool) -> Result<ImportInResult> {
    let manifest = Manifest::read_for(bundle)?;
    if let Some(m) = &manifest {
        if matches!(m.kind, BundleKind::Back | BundleKind::Patch) {
            return invalid("这是回传包，应在内网端导入");
        }
    }

    // ---------- 首次：建空镜像 ----------
    let created = !repo::is_ext_mirror(g, mirror_dir);
    if created {
        if repo::is_nonempty_dir(mirror_dir) {
            return invalid(format!(
                "目录不是外网镜像，也不是空目录：{}。\
                 如果这是旧版本的开发仓库，请删除后重新导入全量包（旧仓库不再兼容）",
                mirror_dir.display()
            ));
        }
        fs::create_dir_all(mirror_dir)?;
        g.run(mirror_dir, args!["init", "--bare"])?;
        repo::mark_ext_mirror(g, mirror_dir)?;
    }

    // 空镜像只能用全量包填。不能只看"这次新建了镜像"：
    // 首次导入的 fetch 失败会留下一个已标记但没有引用的镜像，
    // 那时再导增量包就会得到一个残缺的仓库。
    if mirror_refs(g, mirror_dir)?.is_empty() {
        if let Some(m) = &manifest {
            if m.kind != BundleKind::Full {
                return invalid("外网镜像还是空的，首次导入必须使用全量包（full）");
            }
        }
    }

    let mut state: MirrorState = repo::load_state(mirror_dir)?;
    if let Some(m) = &manifest {
        if let Some(rid) = &state.repo_id {
            if rid != &m.repo_id {
                return invalid("该包与当前镜像不是同一个项目（根提交不同）");
            }
        }
        if m.kind == BundleKind::Incr && state.last_in_seq > 0 {
            if m.seq <= state.last_in_seq {
                return invalid(format!(
                    "包 #{} 已导入过（上次导入 #{}）",
                    m.seq, state.last_in_seq
                ));
            }
            if m.seq != state.last_in_seq + 1 && !allow_gap {
                return invalid(format!(
                    "序号不连续：上次导入 #{}，本包 #{}，中间的包可能遗漏",
                    state.last_in_seq, m.seq
                ));
            }
        }
    }

    g.run(mirror_dir, args!["bundle", "verify", bundle])?;
    let before = mirror_refs(g, mirror_dir)?;
    g.run(
        mirror_dir,
        args![
            "fetch",
            "--no-tags",
            bundle,
            "+refs/heads/*:refs/heads/*",
            "+refs/tags/*:refs/tags/*"
        ],
    )?;

    // 用 manifest 校正：增量包不含"指向旧提交的新分支"，也不含删除信息。
    // 这套校正只在镜像层做一次，开发仓库靠 `fetch --prune` 跟上。
    if let Some(m) = &manifest {
        let wanted: Vec<String> = m.refs.iter().map(|r| r.sha.clone()).collect();
        let have: std::collections::HashSet<String> =
            repo::existing_objects(g, mirror_dir, &wanted)?.into_iter().collect();
        let mut script = String::new();
        let mut keep = std::collections::HashSet::new();
        for (b, sha) in m.branches() {
            let r = format!("refs/heads/{b}");
            keep.insert(r.clone());
            if have.contains(sha) {
                script.push_str(&format!("update {r} {sha}\n"));
            }
        }
        for (t, sha) in m.tags() {
            if have.contains(sha) {
                script.push_str(&format!("update refs/tags/{t} {sha}\n"));
            }
        }
        for (name, _) in mirror_refs(g, mirror_dir)? {
            if name.starts_with("refs/heads/") && !keep.contains(&name) {
                script.push_str(&format!("delete {name}\n"));
            }
        }
        if !script.is_empty() {
            g.query_stdin(mirror_dir, args!["update-ref", "--stdin"], &script)?;
        }
        state.last_in_seq = m.seq;
        if state.repo_id.is_none() {
            state.repo_id = Some(m.repo_id.clone());
        }
    }
    state.last_import_at = Some(now_secs());
    repo::save_state(mirror_dir, &state)?;

    let after = mirror_refs(g, mirror_dir)?;

    // 让镜像的 HEAD 指向一个真实存在的分支。`git init --bare` 的 HEAD 指向
    // `init.defaultBranch`（可能是 master 或任何名字），如果它不存在，
    // 从镜像 clone 出来的开发仓库不会检出任何分支。
    // 优先用 manifest 的主线分支；没有 manifest（可以直接导入裸 bundle）
    // 或该分支不存在时，退而取任意一个分支，总之不能让 HEAD 悬空。
    let head_ok = repo::current_branch(g, mirror_dir)
        .is_some_and(|b| after.contains_key(&format!("refs/heads/{b}")));
    if !head_ok {
        let wanted = manifest
            .as_ref()
            .map(|m| format!("refs/heads/{}", m.base_branch))
            .filter(|h| after.contains_key(h))
            .or_else(|| after.keys().find(|n| n.starts_with("refs/heads/")).cloned());
        if let Some(head) = wanted {
            g.run(mirror_dir, args!["symbolic-ref", "HEAD", &head])?;
        }
    }

    let mut changes = Vec::new();
    for (name, new) in &after {
        let old = before.get(name);
        if old != Some(new) {
            changes.push(RefChange {
                name: name.clone(),
                old: old.cloned(),
                new: Some(new.clone()),
            });
        }
    }
    for (name, old) in &before {
        if !after.contains_key(name) {
            changes.push(RefChange {
                name: name.clone(),
                old: Some(old.clone()),
                new: None,
            });
        }
    }
    Ok(ImportInResult {
        created,
        seq: manifest.map(|m| m.seq),
        changes,
    })
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
    g.run(dev_dir, args!["remote", "set-url", "--push", "origin", PUSH_DISABLED])?;
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
    let origin = g
        .exec(Some(dev_dir), &args!["config", "--get", "remote.origin.url"], None, false)
        .ok()
        .filter(|o| o.ok())
        .map(|o| o.stdout.trim().to_string())
        .unwrap_or_default();
    if origin.is_empty() {
        return invalid(format!("{} 没有配置 origin，不是从镜像克隆出来的", dev_dir.display()));
    }
    if !same_dir(Path::new(&origin), mirror_dir) {
        return invalid(format!(
            "{} 的 origin 指向 {}，不是外网镜像 {}。\
             请检查配置里的开发仓库目录，或用「从镜像克隆」重新建一个",
            dev_dir.display(),
            origin,
            mirror_dir.display()
        ));
    }
    g.run(dev_dir, args!["fetch", "origin", "--prune", "--prune-tags", "--tags"])?;
    Ok(())
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
    if branches.is_empty() {
        return invalid("请至少选择一个分支");
    }
    fs::create_dir_all(transfer_dir)?;
    // 回传序号由镜像统一分配：多个开发仓库 / worktree 各自计数会撞号
    let mut state: MirrorState = repo::load_state(mirror_dir)?;
    let rid = match &state.repo_id {
        Some(r) => r.clone(),
        None => repo::repo_id(g, repo, &format!("refs/remotes/origin/{base_branch}"))?,
    };
    let seq = state.back_seq + 1;
    let file_name = format!("{}-back-{seq:04}.bundle", sanitize(repo_name));
    let bundle = transfer_dir.join(&file_name);

    let mut refs = Vec::new();
    let mut a = args!["bundle", "create", &bundle];
    for b in branches {
        let r = format!("refs/heads/{b}");
        refs.push(RefEntry {
            name: r.clone(),
            sha: repo::rev_parse(g, repo, &r)?,
            base: Some(repo::resolve_base(g, repo, b, base_branch, releases).0),
        });
        a.push(r.into());
    }
    a.extend(args!["--not", "--remotes=origin"]);

    if let Some(nothing) =
        create_and_verify_bundle(g, repo, &bundle, a, "所选分支没有内网尚未包含的新提交")?
    {
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
        refs: refs.clone(),
        tool_version: tool_version(),
    };
    let mpath = manifest.write_for(&bundle)?;
    state.back_seq = seq;
    repo::save_state(mirror_dir, &state)?;

    Ok(ExportOutcome::Exported {
        kind: BundleKind::Back,
        seq,
        payload: bundle.to_string_lossy().into_owned(),
        manifest: mpath.to_string_lossy().into_owned(),
        refs,
        warnings: dirty_warning(g, repo).into_iter().collect(),
    })
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
    let mut state: MirrorState = repo::load_state(mirror_dir)?;
    let rid = match &state.repo_id {
        Some(r) => r.clone(),
        None => repo::repo_id(g, repo, &format!("refs/remotes/origin/{base_branch}"))?,
    };
    let seq = state.back_seq + 1;
    let dir_name = format!("{}-patch-{seq:04}-{}", sanitize(repo_name), sanitize(branch));
    let dir = transfer_dir.join(&dir_name);
    if dir.exists() {
        return invalid(format!("目录已存在：{}", dir.display()));
    }
    let (branch_base, _) = repo::resolve_base(g, repo, branch, base_branch, releases);
    let from = format!("origin/{branch_base}");
    if !repo::rev_exists(g, repo, &from) {
        return invalid(format!("找不到 {branch} 的基准分支 {from}"));
    }
    let range = format!("{from}..refs/heads/{branch}");
    if repo::commits_between(g, repo, &from, &format!("refs/heads/{branch}"))?.is_empty() {
        return Ok(ExportOutcome::NothingToSync {
            message: format!("{branch} 相对 {from} 没有新提交"),
        });
    }
    fs::create_dir_all(&dir)?;
    g.run(repo, args!["format-patch", "--binary", "-o", &dir, range])?;

    let refs = vec![RefEntry {
        name: format!("refs/heads/{branch}"),
        sha: repo::rev_parse(g, repo, &format!("refs/heads/{branch}"))?,
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
        refs: refs.clone(),
        tool_version: tool_version(),
    };
    let mpath = manifest.write_for(&dir)?;
    state.back_seq = seq;
    repo::save_state(mirror_dir, &state)?;

    Ok(ExportOutcome::Exported {
        kind: BundleKind::Patch,
        seq,
        payload: dir.to_string_lossy().into_owned(),
        manifest: mpath.to_string_lossy().into_owned(),
        refs,
        warnings: dirty_warning(g, repo).into_iter().collect(),
    })
}
