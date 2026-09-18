//! 仓库查询：状态、分支、提交列表、同步状态文件。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Deserialize, Serialize};

use super::error::{invalid, Result};
use super::git::Git;
use crate::args;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub sha: String,
    /// 该分支的基准分支（主线或发布分支）
    pub base: String,
    /// 基准分支是按前缀推断出来的（没有 `branch.<name>.syncBase` 记录）
    pub base_inferred: bool,
    /// 相对 `origin/<base>`（镜像仓库为 `<base>`）领先/落后的提交数
    pub ahead: u32,
    pub behind: u32,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub path: String,
    pub exists: bool,
    pub is_repo: bool,
    pub is_bare: bool,
    pub is_mirror: bool,
    pub current_branch: Option<String>,
    pub dirty: bool,
    /// 正在进行的 rebase / am（需要解决冲突或中止）
    pub in_progress: Option<String>,
    pub branches: Vec<BranchInfo>,
    pub remote_url: Option<String>,
}

pub fn is_nonempty_dir(p: &Path) -> bool {
    fs::read_dir(p).map(|mut d| d.next().is_some()).unwrap_or(false)
}

pub fn git_dir(g: &Git, repo: &Path) -> Result<PathBuf> {
    let out = g.query(repo, args!["rev-parse", "--absolute-git-dir"])?;
    Ok(PathBuf::from(out.trim()))
}

pub fn is_bare(g: &Git, repo: &Path) -> Result<bool> {
    Ok(g.query(repo, args!["rev-parse", "--is-bare-repository"])?.trim() == "true")
}

pub fn is_mirror(g: &Git, repo: &Path) -> bool {
    g.exec(
        Some(repo),
        &args!["config", "--bool", "remote.origin.mirror"],
        None,
        false,
    )
    .map(|o| o.ok() && o.stdout.trim() == "true")
    .unwrap_or(false)
}

pub fn current_branch(g: &Git, repo: &Path) -> Option<String> {
    g.exec(
        Some(repo),
        &args!["symbolic-ref", "--short", "-q", "HEAD"],
        None,
        false,
    )
    .ok()
    .filter(|o| o.ok())
    .map(|o| o.stdout.trim().to_string())
    .filter(|s| !s.is_empty())
}

pub fn rev_exists(g: &Git, repo: &Path, rev: &str) -> bool {
    g.exec(
        Some(repo),
        &args!["rev-parse", "--verify", "--quiet", format!("{rev}^{{commit}}")],
        None,
        false,
    )
    .map(|o| o.ok())
    .unwrap_or(false)
}

pub fn rev_parse(g: &Git, repo: &Path, rev: &str) -> Result<String> {
    Ok(g
        .query(repo, args!["rev-parse", "--verify", format!("{rev}^{{commit}}")])?
        .trim()
        .to_string())
}

/// 仓库身份：基准分支最早的根提交。内外网两边历史相同则一致。
pub fn repo_id(g: &Git, repo: &Path, base_ref: &str) -> Result<String> {
    let out = g.query(repo, args!["rev-list", "--max-parents=0", base_ref])?;
    let mut roots: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    roots.sort_unstable();
    match roots.first() {
        Some(r) => Ok(r.to_string()),
        None => invalid(format!("无法确定仓库身份：{base_ref} 没有根提交")),
    }
}

/// 列出 `for-each-ref` 结果 (refname, objectname)。
pub fn list_refs(g: &Git, repo: &Path, patterns: &[&str]) -> Result<Vec<(String, String)>> {
    let mut a = args!["for-each-ref", "--format=%(refname) %(objectname)"];
    a.extend(patterns.iter().map(|p| p.into()));
    let out = g.query(repo, a)?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let (name, sha) = l.trim().split_once(' ')?;
            Some((name.to_string(), sha.to_string()))
        })
        .collect())
}

/// 给定对象中哪些在仓库里存在（批量，一次调用）。
pub fn existing_objects(g: &Git, repo: &Path, shas: &[String]) -> Result<Vec<String>> {
    if shas.is_empty() {
        return Ok(vec![]);
    }
    let input = shas.join("\n") + "\n";
    let out = g.query_stdin(repo, args!["cat-file", "--batch-check"], &input)?;
    Ok(out
        .lines()
        .filter(|l| !l.ends_with(" missing"))
        .filter_map(|l| l.split_whitespace().next().map(str::to_string))
        .collect())
}

pub fn commits_between(g: &Git, repo: &Path, from: &str, to: &str) -> Result<Vec<CommitInfo>> {
    let out = g.query(
        repo,
        args![
            "log",
            "--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%s",
            "--date=format:%Y-%m-%d %H:%M",
            format!("{from}..{to}")
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut p = l.split('\x1f');
            Some(CommitInfo {
                sha: p.next()?.to_string(),
                author: p.next()?.to_string(),
                email: p.next()?.to_string(),
                date: p.next()?.to_string(),
                subject: p.next().unwrap_or("").to_string(),
            })
        })
        .collect())
}

fn ahead_behind(g: &Git, repo: &Path, base: &str, branch: &str) -> (u32, u32) {
    let out = g.exec(
        Some(repo),
        &args![
            "rev-list",
            "--left-right",
            "--count",
            format!("{base}...refs/heads/{branch}")
        ],
        None,
        false,
    );
    match out {
        Ok(o) if o.ok() => {
            let mut it = o.stdout.split_whitespace().map(|n| n.parse().unwrap_or(0));
            let behind = it.next().unwrap_or(0);
            let ahead = it.next().unwrap_or(0);
            (ahead, behind)
        }
        _ => (0, 0),
    }
}

// ---------- 分支的基准分支 ----------

/// 记录分支基准的 git config 键：`branch.<name>.syncBase`（git 自己不使用这个键）。
fn sync_base_key(branch: &str) -> String {
    format!("branch.{branch}.syncBase")
}

pub fn get_sync_base(g: &Git, repo: &Path, branch: &str) -> Option<String> {
    g.exec(
        Some(repo),
        &args!["config", "--get", sync_base_key(branch)],
        None,
        false,
    )
    .ok()
    .filter(|o| o.ok())
    .map(|o| o.stdout.trim().to_string())
    .filter(|s| !s.is_empty())
}

pub fn set_sync_base(g: &Git, repo: &Path, branch: &str, base: &str) -> Result<()> {
    g.run(repo, args!["config", sync_base_key(branch), base])?;
    Ok(())
}

/// 基准分支在仓库里的引用前缀：工作仓库用 `refs/remotes/origin/`，裸仓库（镜像）用 `refs/heads/`。
pub fn base_ref_prefix(g: &Git, repo: &Path) -> &'static str {
    if is_bare(g, repo).unwrap_or(false) {
        "refs/heads/"
    } else {
        "refs/remotes/origin/"
    }
}

/// 按分支名前缀推断基准分支：`hotfix/` 在发布分支中选分叉点最近的一个
/// （`<release>..<branch>` 提交数最少），其他前缀用主线。
pub fn infer_base(
    g: &Git,
    repo: &Path,
    branch: &str,
    mainline: &str,
    releases: &[String],
    prefix: &str,
) -> String {
    if branch.starts_with("hotfix/") {
        let best = releases
            .iter()
            .filter(|r| rev_exists(g, repo, &format!("{prefix}{r}")))
            .map(|r| (ahead_behind(g, repo, &format!("{prefix}{r}"), branch).0, r))
            .min_by_key(|(ahead, _)| *ahead);
        if let Some((_, r)) = best {
            return r.clone();
        }
    }
    mainline.to_string()
}

/// 分支的基准分支：优先用 `branch.<name>.syncBase` 记录，没有时按前缀推断。
/// 返回 (基准分支, 是否为推断)。
pub fn resolve_base(
    g: &Git,
    repo: &Path,
    branch: &str,
    mainline: &str,
    releases: &[String],
) -> (String, bool) {
    match get_sync_base(g, repo, branch) {
        Some(b) => (b, false),
        None => {
            let prefix = base_ref_prefix(g, repo);
            (infer_base(g, repo, branch, mainline, releases, prefix), true)
        }
    }
}

pub fn in_progress(git_dir: &Path) -> Option<String> {
    if git_dir.join("rebase-merge").exists() {
        return Some("rebase".into());
    }
    let apply = git_dir.join("rebase-apply");
    if apply.exists() {
        return Some(if apply.join("applying").exists() {
            "am".into()
        } else {
            "rebase".into()
        });
    }
    if git_dir.join("MERGE_HEAD").exists() {
        return Some("merge".into());
    }
    None
}

pub fn status(g: &Git, path: &Path, mainline: &str, releases: &[String]) -> Result<RepoStatus> {
    let mut st = RepoStatus {
        path: path.to_string_lossy().into_owned(),
        exists: path.exists(),
        ..Default::default()
    };
    if !st.exists {
        return Ok(st);
    }
    let probe = g.exec(
        Some(path),
        &args!["rev-parse", "--is-bare-repository"],
        None,
        false,
    )?;
    if !probe.ok() {
        return Ok(st);
    }
    st.is_repo = true;
    st.is_bare = probe.stdout.trim() == "true";
    st.is_mirror = is_mirror(g, path);
    st.remote_url = g
        .exec(
            Some(path),
            &args!["config", "--get", "remote.origin.url"],
            None,
            false,
        )
        .ok()
        .filter(|o| o.ok())
        .map(|o| o.stdout.trim().to_string());

    if !st.is_bare {
        st.current_branch = current_branch(g, path);
        st.dirty = !g
            .query(path, args!["status", "--porcelain", "--untracked-files=no"])?
            .trim()
            .is_empty();
        st.in_progress = in_progress(&git_dir(g, path)?);
    }

    let prefix = if st.is_bare { "refs/heads/" } else { "refs/remotes/origin/" };
    for (name, sha) in list_refs(g, path, &["refs/heads"])? {
        let short = name.trim_start_matches("refs/heads/").to_string();
        let (base, base_inferred) = match get_sync_base(g, path, &short) {
            Some(b) => (b, false),
            None => (infer_base(g, path, &short, mainline, releases, prefix), true),
        };
        let base_ref = format!("{prefix}{base}");
        let (ahead, behind) = if rev_exists(g, path, &base_ref) {
            ahead_behind(g, path, &base_ref, &short)
        } else {
            (0, 0)
        };
        st.branches.push(BranchInfo {
            current: st.current_branch.as_deref() == Some(short.as_str()),
            name: short,
            sha,
            base,
            base_inferred,
            ahead,
            behind,
        });
    }
    Ok(st)
}

// ---------- 同步状态文件 ----------

const STATE_DIR: &str = "offline-sync";
const STATE_FILE: &str = "state.json";

/// 读取 `<dir>/offline-sync/state.json`，不存在则返回默认值。
pub fn load_state<T: DeserializeOwned + Default>(dir: &Path) -> Result<T> {
    let p = dir.join(STATE_DIR).join(STATE_FILE);
    if !p.exists() {
        return Ok(T::default());
    }
    Ok(serde_json::from_str(&fs::read_to_string(p)?)?)
}

pub fn save_state<T: Serialize>(dir: &Path, state: &T) -> Result<()> {
    let d = dir.join(STATE_DIR);
    fs::create_dir_all(&d)?;
    fs::write(d.join(STATE_FILE), serde_json::to_string_pretty(state)?)?;
    Ok(())
}

/// 内网镜像仓库的同步状态（存于镜像仓库目录内）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalState {
    pub repo_id: Option<String>,
    pub out_seq: u32,
    /// 上次导出时的全部分支/tag 对象，用作下次增量的 `--not` 基线
    pub last_heads: Vec<String>,
    pub last_export_at: Option<u64>,
}

/// 外网开发仓库的同步状态（存于 `.git/offline-sync`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalState {
    pub repo_id: Option<String>,
    pub last_in_seq: u32,
    pub back_seq: u32,
    pub last_import_at: Option<u64>,
}
