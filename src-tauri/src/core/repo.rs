//! 仓库查询：状态、分支、提交列表、同步状态文件。

use std::collections::HashMap;
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
    /// 该分支被哪个 linked worktree 检出（没有则为 None）
    pub worktree: Option<String>,
}

/// 某个工作树上未完成的操作。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InProgressOp {
    /// 该工作树的路径，「继续 / 中止」必须发到这里
    pub path: String,
    pub branch: Option<String>,
    /// "rebase" / "am" / "merge"
    pub op: String,
    pub main: bool,
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
    /// 有未提交修改的工作树（含主工作树）。分支常常是在 linked worktree
    /// 里开发的，只看主工作树会漏掉那里的改动。
    pub dirty_trees: Vec<Worktree>,
    /// 主工作树上正在进行的 rebase / am（需要解决冲突或中止）
    pub in_progress: Option<String>,
    /// 所有工作树（含主工作树）上未完成的操作。
    ///
    /// rebase / am 的标记文件是每个 worktree 独立的，只看主工作树会漏掉
    /// linked worktree 里卡住的操作——那样界面就给不出「继续 / 中止」，
    /// 用户只能去终端解决。
    pub in_progress_trees: Vec<InProgressOp>,
    pub branches: Vec<BranchInfo>,
    pub remote_url: Option<String>,
}

pub fn is_nonempty_dir(p: &Path) -> bool {
    fs::read_dir(p).map(|mut d| d.next().is_some()).unwrap_or(false)
}

/// 当前工作树自己的 git 目录。在 linked worktree 里是 `.git/worktrees/<name>`，
/// 正因如此它能区分出 rebase / am / merge 的标记文件属于哪个工作树（见 [`in_progress`]）。
///
/// 同步状态文件不在这里：它存在镜像目录的 `offline-sync/state.json`，
/// 由 [`load_state`] / [`save_state`] 直接按镜像路径读写。
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

/// 标记外网镜像的 git config 键。外网镜像不是 `clone --mirror` 的产物
/// （那会留下一个指向 bundle 文件的 `remote.origin`），所以用自己的标记。
const ROLE_KEY: &str = "offlinesync.role";

pub fn mark_ext_mirror(g: &Git, dir: &Path) -> Result<()> {
    g.run(dir, args!["config", ROLE_KEY, "mirror"])?;
    Ok(())
}

/// 目录是不是本工具建的外网镜像（bare + `offlinesync.role=mirror`）。
pub fn is_ext_mirror(g: &Git, dir: &Path) -> bool {
    let role = g
        .exec(Some(dir), &args!["config", "--get", ROLE_KEY], None, false)
        .ok()
        .filter(|o| o.ok())
        .map(|o| o.stdout.trim().to_string())
        .unwrap_or_default();
    role == "mirror" && is_bare(g, dir).unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// 检出的分支（detached HEAD 时为 None）
    pub branch: Option<String>,
    pub bare: bool,
    /// 主工作树（`git worktree list` 的第一条）
    pub main: bool,
}

/// 解析 `git worktree list --porcelain`：主仓库和所有 linked worktree。
pub fn list_worktrees(g: &Git, repo: &Path) -> Result<Vec<Worktree>> {
    let out = g.query(repo, args!["worktree", "list", "--porcelain"])?;
    let mut all: Vec<Worktree> = Vec::new();
    let mut cur: Option<Worktree> = None;
    for line in out.lines() {
        let line = line.trim_end();
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(w) = cur.take() {
                all.push(w);
            }
            cur = Some(Worktree {
                path: path.to_string(),
                branch: None,
                bare: false,
                main: all.is_empty(),
            });
        } else if let Some(w) = cur.as_mut() {
            if line == "bare" {
                w.bare = true;
            } else if let Some(b) = line.strip_prefix("branch ") {
                w.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            }
        }
    }
    if let Some(w) = cur.take() {
        all.push(w);
    }
    Ok(all)
}

/// 有未提交修改的工作树（含主工作树）。
///
/// 只看主工作树会漏掉：分支很可能是在某个 linked worktree 里开发的，
/// 那里的改动同样不会被导出。取不到状态的工作树（目录已删、尚未 prune）跳过。
pub fn dirty_worktrees(g: &Git, repo: &Path) -> Vec<Worktree> {
    list_worktrees(g, repo)
        .unwrap_or_default()
        .into_iter()
        .filter(|w| !w.bare)
        .filter(|w| {
            g.query(
                Path::new(&w.path),
                args!["status", "--porcelain", "--untracked-files=no"],
            )
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        })
        .collect()
}

/// 分支被哪个 **linked** worktree 检出。主工作树不算：那里可以直接 `git switch`。
pub fn linked_worktree_for(g: &Git, repo: &Path, branch: &str) -> Option<Worktree> {
    list_worktrees(g, repo)
        .ok()?
        .into_iter()
        .find(|w| !w.main && !w.bare && w.branch.as_deref() == Some(branch))
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

/// 一次读出所有分支的基准记录：分支名 → 基准分支。
pub fn all_sync_bases(g: &Git, repo: &Path) -> HashMap<String, String> {
    let out = g.exec(
        Some(repo),
        &args!["config", "--get-regexp", r"^branch\..*\.syncbase$"],
        None,
        false,
    );
    let Ok(o) = out else { return HashMap::new() };
    // 没有任何记录时 git 返回 1，stdout 为空
    o.stdout
        .lines()
        .filter_map(|l| {
            let (key, val) = l.trim().split_once(' ')?;
            let name = key.strip_prefix("branch.")?.strip_suffix(".syncbase")?;
            Some((name.to_string(), val.trim().to_string()))
        })
        .collect()
}

/// 所有本地分支相对 `base_ref` 的 (领先, 落后)。
/// git ≥ 2.41 用一次 `for-each-ref %(ahead-behind:…)`，更早的版本逐个分支计算。
fn ahead_behind_all(g: &Git, repo: &Path, base_ref: &str) -> HashMap<String, (u32, u32)> {
    let out = g.exec(
        Some(repo),
        &args![
            "for-each-ref",
            format!("--format=%(refname) %(ahead-behind:{base_ref})"),
            "refs/heads"
        ],
        None,
        false,
    );
    if let Ok(o) = &out {
        if o.ok() {
            return o
                .stdout
                .lines()
                .filter_map(|l| {
                    let mut it = l.split_whitespace();
                    let name = it.next()?.strip_prefix("refs/heads/")?.to_string();
                    let ahead = it.next()?.parse().ok()?;
                    let behind = it.next()?.parse().ok()?;
                    Some((name, (ahead, behind)))
                })
                .collect();
        }
    }
    list_refs(g, repo, &["refs/heads"])
        .unwrap_or_default()
        .into_iter()
        .map(|(n, _)| {
            let short = n.trim_start_matches("refs/heads/").to_string();
            let ab = ahead_behind(g, repo, base_ref, &short);
            (short, ab)
        })
        .collect()
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

/// 扫描所有工作树上未完成的 rebase / am / merge。
///
/// 每个工作树的标记文件在它自己的 git 目录里（linked worktree 是
/// `.git/worktrees/<name>/`），所以必须逐个问 `git rev-parse --absolute-git-dir`，
/// 不能只看主工作树。取不到状态的工作树（目录已被删、尚未 prune）直接跳过。
pub fn in_progress_all(g: &Git, repo: &Path) -> Vec<InProgressOp> {
    list_worktrees(g, repo)
        .unwrap_or_default()
        .into_iter()
        .filter(|w| !w.bare)
        .filter_map(|w| {
            let gd = git_dir(g, Path::new(&w.path)).ok()?;
            let op = in_progress(&gd)?;
            Some(InProgressOp {
                // rebase 期间 HEAD 是 detached，`git worktree list` 不报分支名，
                // 而这正是最该告诉用户"哪个分支卡住了"的时刻：从 rebase 状态里补。
                branch: w.branch.or_else(|| rebasing_branch(&gd)),
                path: w.path,
                op,
                main: w.main,
            })
        })
        .collect()
}

/// 正在被 rebase / am 的分支名，取自 `<git_dir>/rebase-*/head-name`。
fn rebasing_branch(git_dir: &Path) -> Option<String> {
    ["rebase-merge", "rebase-apply"]
        .iter()
        .find_map(|d| fs::read_to_string(git_dir.join(d).join("head-name")).ok())
        .map(|s| s.trim().trim_start_matches("refs/heads/").to_string())
        .filter(|s| !s.is_empty() && s != "detached HEAD")
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
        st.in_progress = in_progress(&git_dir(g, path)?);
        st.in_progress_trees = in_progress_all(g, path);
        st.dirty_trees = dirty_worktrees(g, path);
    }

    let refs = list_refs(g, path, &["refs/heads"])?;
    if st.is_bare {
        // 镜像仓库只用于打包：界面只需要分支列表，不计算基准和领先/落后
        //（GitLab 镜像常有成百上千个分支，逐个计算会让界面长时间没有响应）
        st.branches = refs
            .into_iter()
            .map(|(name, sha)| BranchInfo {
                name: name.trim_start_matches("refs/heads/").to_string(),
                sha,
                base: mainline.to_string(),
                base_inferred: false,
                ahead: 0,
                behind: 0,
                current: false,
                worktree: None,
            })
            .collect();
        return Ok(st);
    }

    // 工作仓库：基准记录一次读出，领先/落后按基准分组批量计算
    let prefix = "refs/remotes/origin/";
    let recorded = all_sync_bases(g, path);
    let in_worktree: HashMap<String, String> = list_worktrees(g, path)
        .unwrap_or_default()
        .into_iter()
        .filter(|w| !w.main && !w.bare)
        .filter_map(|w| w.branch.clone().map(|b| (b, w.path)))
        .collect();
    let mut counts: HashMap<String, HashMap<String, (u32, u32)>> = HashMap::new();
    let mut counts_for = |base: &str| -> HashMap<String, (u32, u32)> {
        counts
            .entry(base.to_string())
            .or_insert_with(|| {
                let base_ref = format!("{prefix}{base}");
                if rev_exists(g, path, &base_ref) {
                    ahead_behind_all(g, path, &base_ref)
                } else {
                    HashMap::new()
                }
            })
            .clone()
    };
    for (name, sha) in refs {
        let short = name.trim_start_matches("refs/heads/").to_string();
        let (base, base_inferred) = match recorded.get(&short) {
            Some(b) => (b.clone(), false),
            None => {
                // 与 infer_base 相同的规则：hotfix/ 选分叉点最近（领先最少）的发布分支
                let best = if short.starts_with("hotfix/") {
                    releases
                        .iter()
                        .filter_map(|r| counts_for(r).get(&short).map(|c| (c.0, r)))
                        .min_by_key(|(ahead, _)| *ahead)
                        .map(|(_, r)| r.clone())
                } else {
                    None
                };
                (best.unwrap_or_else(|| mainline.to_string()), true)
            }
        };
        let (ahead, behind) = counts_for(&base).get(&short).copied().unwrap_or((0, 0));
        st.branches.push(BranchInfo {
            current: st.current_branch.as_deref() == Some(short.as_str()),
            worktree: in_worktree.get(&short).cloned(),
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

/// 外网镜像仓库的同步状态（存于 `<mirror>/offline-sync`）。
///
/// `back_seq` 也放在镜像里：多个开发仓库 / 多个 worktree 都从这里领回传包序号，
/// 否则各自计数会撞号，内网导入时会判定序号不连续。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorState {
    pub repo_id: Option<String>,
    pub last_in_seq: u32,
    pub back_seq: u32,
    pub last_import_at: Option<u64>,
}
