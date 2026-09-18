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
use super::repo::{self, CommitInfo, ExternalState, InternalState};
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
}

impl OpOutcome {
    fn done(msg: impl Into<String>) -> Self {
        OpOutcome {
            ok: true,
            message: msg.into(),
            ..Default::default()
        }
    }
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
    pub cloned: bool,
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

    let out = g.exec(Some(mirror), &a, None, true)?;
    if !out.ok() {
        let _ = fs::remove_file(&bundle);
        if out.stderr.contains("empty bundle") {
            return Ok(ExportOutcome::NothingToSync {
                message: "内网没有新提交，无需同步".into(),
            });
        }
        return Err(SyncError::Git {
            cmd: "git bundle create".into(),
            code: out.code,
            stderr: out.stderr.trim().to_string(),
        });
    }
    g.run(mirror, args!["bundle", "verify", &bundle])?;

    let ref_entries: Vec<RefEntry> = refs
        .iter()
        .map(|(n, s)| RefEntry {
            name: n.clone(),
            sha: s.clone(),
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
pub fn import_back(g: &Git, work: &Path, bundle: &Path, base_branch: &str) -> Result<ImportBackResult> {
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
    let current = repo::current_branch(g, work);
    let seq_tag = manifest
        .as_ref()
        .map(|m| format!("{:04}", m.seq))
        .unwrap_or_else(|| now_secs().to_string());

    let mut branches = Vec::new();
    for (name, sha) in heads {
        let Some(branch) = name.strip_prefix("refs/heads/") else {
            continue;
        };
        let mut local = branch.to_string();
        if current.as_deref() == Some(branch) {
            return invalid(format!(
                "分支 {branch} 当前已检出，无法直接导入，请先切换到其他分支"
            ));
        }
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
        let commits = if repo::rev_exists(g, work, &base_ref) {
            repo::commits_between(g, work, &base_ref, &format!("refs/heads/{local}"))?
        } else {
            vec![]
        };
        branches.push(ImportedBranch {
            source: branch.to_string(),
            local,
            sha,
            commits,
        });
    }
    if branches.is_empty() {
        return invalid("回传包里没有分支");
    }
    Ok(ImportBackResult { branches, warnings })
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
    ensure_worktree_clean(g, work)?;
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
    g.run(
        work,
        args!["switch", "-c", branch, format!("origin/{base_branch}")],
    )?;
    let mut a = args!["am", "--3way"];
    a.extend(patches.iter().map(Into::into));
    let out = g.exec(Some(work), &a, None, true)?;
    if out.ok() {
        Ok(OpOutcome::done(format!("已应用 {} 个补丁到 {branch}", patches.len())))
    } else {
        Ok(OpOutcome {
            ok: false,
            conflict: true,
            files: conflict_files(g, work),
            message: "补丁应用冲突：解决后点击“继续”，或点击“中止”".into(),
        })
    }
}

/// 拉取内网最新代码，把分支 rebase 到 `origin/<base>`。
pub fn rebase_onto(
    g: &Git,
    repo: &Path,
    branch: &str,
    base_branch: &str,
    fetch_upstream: bool,
) -> Result<OpOutcome> {
    ensure_worktree_clean(g, repo)?;
    if fetch_upstream {
        g.run(repo, args!["fetch", "origin", "--prune"])?;
    }
    g.run(repo, args!["switch", branch])?;
    let out = g.exec(
        Some(repo),
        &args!["rebase", format!("origin/{base_branch}")],
        None,
        true,
    )?;
    if out.ok() {
        Ok(OpOutcome::done(format!("{branch} 已基于最新的 origin/{base_branch}")))
    } else {
        Ok(OpOutcome {
            ok: false,
            conflict: true,
            files: conflict_files(g, repo),
            message: "rebase 冲突：解决后点击“继续”，或点击“中止”".into(),
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

fn origin_refs(g: &Git, repo: &Path) -> Result<BTreeMap<String, String>> {
    Ok(repo::list_refs(g, repo, &["refs/remotes/origin", "refs/tags"])?
        .into_iter()
        .filter(|(n, _)| n != "refs/remotes/origin/HEAD")
        .collect())
}

/// 内网 → 外网：导入全量或增量包。目标目录不存在（或为空）时 clone，否则 fetch。
pub fn import_in(g: &Git, bundle: &Path, repo_dir: &Path, allow_gap: bool) -> Result<ImportInResult> {
    let manifest = Manifest::read_for(bundle)?;
    if let Some(m) = &manifest {
        if matches!(m.kind, BundleKind::Back | BundleKind::Patch) {
            return invalid("这是回传包，应在内网端导入");
        }
    }

    // ---------- 首次：clone ----------
    if !repo::is_nonempty_dir(repo_dir) {
        if let Some(m) = &manifest {
            if m.kind != BundleKind::Full {
                return invalid("目标仓库不存在，首次导入必须使用全量包（full）");
            }
        }
        if let Some(parent) = repo_dir.parent() {
            fs::create_dir_all(parent)?;
        }
        g.run_nocwd(args!["clone", bundle, repo_dir])?;
        let state = ExternalState {
            repo_id: manifest.as_ref().map(|m| m.repo_id.clone()),
            last_in_seq: manifest.as_ref().map(|m| m.seq).unwrap_or(0),
            back_seq: 0,
            last_import_at: Some(now_secs()),
        };
        repo::save_state(&repo::git_dir(g, repo_dir)?, &state)?;
        let changes = origin_refs(g, repo_dir)?
            .into_iter()
            .map(|(name, sha)| RefChange {
                name,
                old: None,
                new: Some(sha),
            })
            .collect();
        return Ok(ImportInResult {
            cloned: true,
            seq: manifest.map(|m| m.seq),
            changes,
        });
    }

    // ---------- 增量：fetch ----------
    let gd = repo::git_dir(g, repo_dir)?;
    let mut state: ExternalState = repo::load_state(&gd)?;
    if let Some(m) = &manifest {
        if let Some(rid) = &state.repo_id {
            if rid != &m.repo_id {
                return invalid("该包与当前仓库不是同一个项目（根提交不同）");
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

    g.run(repo_dir, args!["bundle", "verify", bundle])?;
    let before = origin_refs(g, repo_dir)?;
    g.run(
        repo_dir,
        args![
            "fetch",
            "--no-tags",
            bundle,
            "+refs/heads/*:refs/remotes/origin/*",
            "+refs/tags/*:refs/tags/*"
        ],
    )?;

    // 用 manifest 校正远程跟踪分支：增量包不含"指向旧提交的新分支"，也不含删除信息
    if let Some(m) = &manifest {
        let wanted: Vec<String> = m.refs.iter().map(|r| r.sha.clone()).collect();
        let have: std::collections::HashSet<String> =
            repo::existing_objects(g, repo_dir, &wanted)?.into_iter().collect();
        let mut script = String::new();
        let mut keep = std::collections::HashSet::new();
        for (b, sha) in m.branches() {
            let r = format!("refs/remotes/origin/{b}");
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
        for (name, _) in origin_refs(g, repo_dir)? {
            if name.starts_with("refs/remotes/origin/") && !keep.contains(&name) {
                script.push_str(&format!("delete {name}\n"));
            }
        }
        if !script.is_empty() {
            g.query_stdin(repo_dir, args!["update-ref", "--stdin"], &script)?;
        }
        state.last_in_seq = m.seq;
        if state.repo_id.is_none() {
            state.repo_id = Some(m.repo_id.clone());
        }
    }
    state.last_import_at = Some(now_secs());
    repo::save_state(&gd, &state)?;

    let after = origin_refs(g, repo_dir)?;
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
        cloned: false,
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

pub fn create_branch(g: &Git, repo: &Path, name: &str, base_branch: &str) -> Result<()> {
    validate_branch_name(g, repo, name)?;
    if repo::rev_exists(g, repo, &format!("refs/heads/{name}")) {
        return invalid(format!("分支 {name} 已存在"));
    }
    let base = format!("origin/{base_branch}");
    if !repo::rev_exists(g, repo, &base) {
        return invalid(format!("找不到 {base}，请先导入内网包"));
    }
    g.run(repo, args!["switch", "-c", name, base])?;
    Ok(())
}

fn dirty_warning(g: &Git, repo: &Path) -> Option<String> {
    let s = g
        .query(repo, args!["status", "--porcelain", "--untracked-files=no"])
        .ok()?;
    (!s.trim().is_empty()).then(|| "工作区有未提交的修改，这些修改不会被导出".to_string())
}

/// 外网 → 内网：打包内网还没有的提交（`<branches> --not --remotes=origin`）。
pub fn export_back(
    g: &Git,
    repo: &Path,
    branches: &[String],
    transfer_dir: &Path,
    repo_name: &str,
    base_branch: &str,
) -> Result<ExportOutcome> {
    if branches.is_empty() {
        return invalid("请至少选择一个分支");
    }
    fs::create_dir_all(transfer_dir)?;
    let gd = repo::git_dir(g, repo)?;
    let mut state: ExternalState = repo::load_state(&gd)?;
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
        });
        a.push(r.into());
    }
    a.extend(args!["--not", "--remotes=origin"]);

    let out = g.exec(Some(repo), &a, None, true)?;
    if !out.ok() {
        let _ = fs::remove_file(&bundle);
        if out.stderr.contains("empty bundle") {
            return Ok(ExportOutcome::NothingToSync {
                message: "所选分支没有内网尚未包含的新提交".into(),
            });
        }
        return Err(SyncError::Git {
            cmd: "git bundle create".into(),
            code: out.code,
            stderr: out.stderr.trim().to_string(),
        });
    }
    g.run(repo, args!["bundle", "verify", &bundle])?;

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
    repo::save_state(&gd, &state)?;

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
pub fn export_patches(
    g: &Git,
    repo: &Path,
    branch: &str,
    transfer_dir: &Path,
    repo_name: &str,
    base_branch: &str,
) -> Result<ExportOutcome> {
    let gd = repo::git_dir(g, repo)?;
    let mut state: ExternalState = repo::load_state(&gd)?;
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
    let range = format!("origin/{base_branch}..refs/heads/{branch}");
    if repo::commits_between(g, repo, &format!("origin/{base_branch}"), &format!("refs/heads/{branch}"))?
        .is_empty()
    {
        return Ok(ExportOutcome::NothingToSync {
            message: format!("{branch} 相对 origin/{base_branch} 没有新提交"),
        });
    }
    fs::create_dir_all(&dir)?;
    g.run(repo, args!["format-patch", "--binary", "-o", &dir, range])?;

    let refs = vec![RefEntry {
        name: format!("refs/heads/{branch}"),
        sha: repo::rev_parse(g, repo, &format!("refs/heads/{branch}"))?,
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
    repo::save_state(&gd, &state)?;

    Ok(ExportOutcome::Exported {
        kind: BundleKind::Patch,
        seq,
        payload: dir.to_string_lossy().into_owned(),
        manifest: mpath.to_string_lossy().into_owned(),
        refs,
        warnings: dirty_warning(g, repo).into_iter().collect(),
    })
}
