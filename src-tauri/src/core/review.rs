//! Format-1 return receipts, in-place review branches and frozen push plans.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    LazyLock, Mutex,
};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::error::{invalid, Result, SyncError};
use super::git::{redact, Git};
use super::manifest::{BundleKind, Manifest};
use super::repo::{self, CommitInfo};
use super::storage::OperationLock;
use super::sync::{self, ImportedBranch, OpOutcome};
use crate::args;

const RECEIPTS: &str = "refs/offline-sync/return-receipts/";
const PATCH_RECEIPTS: &str = "refs/offline-sync/patch-receipts/";
const PUSHED: &str = "refs/offline-sync/review-pushed/";

pub(super) fn common_dir(g: &Git, work: &Path) -> Result<PathBuf> {
    let common = g.query(work, args!["rev-parse", "--git-common-dir"])?;
    let common = work.join(common.trim());
    // Keep Git-facing paths in its native spelling (Windows canonicalize adds
    // a verbatim prefix). OperationLock canonicalizes the lock identity itself.
    Ok(std::path::absolute(common)?)
}

fn require_work_repo(g: &Git, work: &Path) -> Result<()> {
    if repo::is_bare(g, work)? {
        return invalid("请选择普通工作仓库，禁止在镜像仓库接收或推送");
    }
    let mirror = g.exec(
        Some(work),
        &args!["config", "--bool", "remote.origin.mirror"],
        None,
        false,
    )?;
    if (mirror.ok() && mirror.stdout.trim() == "true") || (!mirror.ok() && mirror.code != 1) {
        return invalid("禁止使用 mirror 推送配置");
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewItem {
    source: String,
    local: String,
    original: String,
    base: String,
    item_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    key: String,
    items: Vec<ReviewItem>,
    warnings: Vec<String>,
}

fn read_receipt(g: &Git, work: &Path, reference: &str) -> Result<Receipt> {
    let receipt: Receipt =
        serde_json::from_str(&g.query(work, args!["cat-file", "blob", reference])?)?;
    if reference != format!("{RECEIPTS}{}", receipt.key) || receipt.items.is_empty() {
        return invalid(format!("回传接收记录损坏：{reference}"));
    }
    Ok(receipt)
}

fn read_receipts(g: &Git, work: &Path) -> Result<Vec<Receipt>> {
    let refs = g.exec(
        Some(work),
        &args!["for-each-ref", "--format=%(refname)", RECEIPTS],
        None,
        false,
    )?;
    // Git can report a broken loose ref as a warning and still exit zero.
    if !refs.ok() || !refs.stderr.trim().is_empty() {
        return invalid(format!(
            "无法完整读取回传接收记录：{}",
            redact(refs.stderr.trim())
        ));
    }
    refs.stdout
        .lines()
        .map(|reference| read_receipt(g, work, reference))
        .collect()
}

pub fn review_sources(g: &Git, work: &Path) -> Result<HashMap<String, String>> {
    let mut sources = HashMap::new();
    for receipt in read_receipts(g, work)? {
        for item in receipt.items {
            if sources.insert(item.local, item.source).is_some() {
                return invalid("回传接收记录含重复审查分支映射");
            }
        }
    }
    Ok(sources)
}

/// Historical verification of the current local commit; no remote query is needed.
pub fn pushed_branches(g: &Git, work: &Path, branches: &[repo::BranchInfo]) -> Result<Vec<String>> {
    let markers: HashMap<_, _> = repo::list_refs(g, work, &[PUSHED])?.into_iter().collect();
    let heads: HashMap<_, _> = branches.iter().map(|b| (&b.name, &b.sha)).collect();
    let mut pushed = Vec::new();
    for receipt in read_receipts(g, work)? {
        for item in receipt.items {
            let reference = format!("{PUSHED}{}/{}", receipt.key, item.item_id);
            if let (Some(marker), Some(head)) = (markers.get(&reference), heads.get(&item.local)) {
                if marker == *head {
                    pushed.push(item.local);
                }
            }
        }
    }
    pushed.sort();
    Ok(pushed)
}

/// Use the same format-1 identity for reception and read-only package queries.
fn return_key(g: &Git, work: &Path, bundle: &Path, manifest: Option<&Manifest>) -> Result<String> {
    let bundle = std::path::absolute(bundle)?;
    let payload_oid = g.query(work, args!["hash-object", "--no-filters", "--", &bundle])?;
    let mut canonical = manifest.cloned();
    if let Some(m) = canonical.as_mut() {
        m.payload.clear();
        m.refs.sort_by(|a, b| a.name.cmp(&b.name));
    }
    let key_input = serde_json::to_string(&(payload_oid.trim(), canonical))?;
    Ok(
        g.query_stdin(work, args!["hash-object", "--stdin"], &key_input)?
            .trim()
            .to_owned(),
    )
}

/// Patch receipts stay separate from bundle review branches: applying mail patches
/// creates new commits and retains the destination branch chosen by the user.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PatchReceipt {
    pub key: String,
    pub branch: String,
    pub worktree: String,
    pub head: String,
}

pub(super) fn patch_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut patches = fs::read_dir(dir)?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    patches.retain(|p| p.extension().is_some_and(|x| x == "patch"));
    patches.sort();
    for patch in &patches {
        if !fs::metadata(patch)?.is_file() {
            return invalid(format!("补丁条目不是文件：{}", patch.display()));
        }
    }
    if patches.is_empty() {
        return invalid("目录里没有 .patch 文件");
    }
    Ok(patches)
}

pub(super) fn patch_key(
    g: &Git,
    work: &Path,
    patches: &[PathBuf],
    manifest: Option<&Manifest>,
) -> Result<String> {
    let mut payload = Vec::new();
    for patch in patches {
        let path = std::path::absolute(patch)?;
        let oid = g.query(work, args!["hash-object", "--no-filters", "--", &path])?;
        // Only ordered contents matter; copying or renaming a package preserves identity.
        payload.push(oid.trim().to_owned());
    }
    let mut canonical = manifest.cloned();
    if let Some(m) = canonical.as_mut() {
        m.payload.clear();
        m.refs.sort_by(|a, b| a.name.cmp(&b.name));
    }
    Ok(g.query_stdin(
        work,
        args!["hash-object", "--stdin"],
        &serde_json::to_string(&(payload, canonical))?,
    )?
    .trim()
    .to_owned())
}

pub(super) fn patch_receipts(g: &Git, work: &Path) -> Result<Vec<PatchReceipt>> {
    let refs = g.exec(
        Some(work),
        &args!["for-each-ref", "--format=%(refname)", PATCH_RECEIPTS],
        None,
        false,
    )?;
    if !refs.ok() || !refs.stderr.trim().is_empty() {
        return invalid("无法完整读取补丁接收记录");
    }
    refs.stdout
        .lines()
        .map(|reference| {
            let receipt: PatchReceipt =
                serde_json::from_str(&g.query(work, args!["cat-file", "blob", reference])?)?;
            if reference != format!("{PATCH_RECEIPTS}{}", receipt.key)
                || !super::manifest::valid_oid(&receipt.head)
                || !super::manifest::valid_ref(&format!("refs/heads/{}", receipt.branch))
                || receipt.worktree.is_empty()
            {
                return invalid(format!("补丁接收记录损坏：{reference}"));
            }
            Ok(receipt)
        })
        .collect()
}

pub(super) fn record_patch_received(g: &Git, work: &Path, receipt: &PatchReceipt) -> Result<()> {
    if patch_receipts(g, work)?
        .iter()
        .any(|r| r.key == receipt.key)
    {
        return Ok(());
    }
    let blob = g.query_stdin(
        work,
        args!["hash-object", "-w", "--stdin"],
        &serde_json::to_string(receipt)?,
    )?;
    g.query_stdin(
        work,
        args!["update-ref", "--no-deref", "--stdin"],
        &format!("create {PATCH_RECEIPTS}{} {}\n", receipt.key, blob.trim()),
    )?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnPackageInfo {
    #[serde(flatten)]
    pub package: sync::PackageInfo,
    pub received: bool,
    pub receipt_key: Option<String>,
    pub error: Option<String>,
}

pub fn list_return_packages(g: &Git, work: &Path, dir: &Path) -> Result<Vec<ReturnPackageInfo>> {
    let packages = sync::list_packages(dir)?;
    let mut received_keys = HashSet::new();
    let mut patch_keys = HashSet::new();
    // An uncreated work directory must not prevent browsing transfer media.
    // A present but broken .git is an error, not an empty receipt collection.
    let has_repo = if !work.try_exists()? {
        false
    } else {
        match fs::symlink_metadata(work.join(".git")) {
            Ok(_) => {
                require_work_repo(g, work)?;
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.into()),
        }
    };
    if has_repo {
        patch_keys.extend(
            patch_receipts(g, work)?
                .into_iter()
                .map(|receipt| receipt.key),
        );
        received_keys.extend(
            read_receipts(g, work)?
                .into_iter()
                .map(|receipt| receipt.key),
        );
    }
    packages
        .into_iter()
        .map(|package| {
            let is_return = package
                .manifest
                .as_ref()
                .is_none_or(|m| m.kind == BundleKind::Back);
            let is_patch = package
                .manifest
                .as_ref()
                .is_some_and(|m| m.kind == BundleKind::Patch);
            let identity = (|| -> Result<Option<String>> {
                if package.payload_exists && is_patch {
                    let patches = patch_files(Path::new(&package.payload_path))?;
                    if has_repo && !patch_keys.is_empty() {
                        let key = patch_key(g, work, &patches, package.manifest.as_ref())?;
                        return Ok(patch_keys.contains(&key).then_some(key));
                    }
                } else if has_repo
                    && !received_keys.is_empty()
                    && package.payload_exists
                    && is_return
                {
                    let key = return_key(
                        g,
                        work,
                        Path::new(&package.payload_path),
                        package.manifest.as_ref(),
                    )?;
                    return Ok(received_keys.contains(&key).then_some(key));
                }
                Ok(None)
            })();
            let (receipt_key, error) = match identity {
                Ok(key) => (key, None),
                Err(error) => (None, Some(redact(&error.to_string()))),
            };
            Ok(ReturnPackageInfo {
                package,
                received: receipt_key.is_some(),
                receipt_key,
                error,
            })
        })
        .collect()
}

fn review_item(g: &Git, work: &Path, branch: &str) -> Result<Option<(String, ReviewItem)>> {
    for receipt in read_receipts(g, work)? {
        if let Some(item) = receipt.items.into_iter().find(|i| i.local == branch) {
            return Ok(Some((receipt.key, item)));
        }
    }
    if branch.starts_with("review/") {
        return invalid("审查分支缺少接收记录，无法确定原始推送目标");
    }
    Ok(None)
}

/// Called by the rebase journal finalizer while holding the worktree operation lock.
pub(super) fn mark_review_ready(g: &Git, work: &Path, branch: &str, oid: &str) -> Result<()> {
    if !branch.starts_with("review/") {
        return Ok(());
    }
    for receipt in read_receipts(g, work)? {
        if let Some(item) = receipt.items.iter().find(|i| i.local == branch) {
            g.run(
                work,
                args![
                    "update-ref",
                    "--no-deref",
                    format!(
                        "refs/offline-sync/review-ready/{}/{}",
                        receipt.key, item.item_id
                    ),
                    oid
                ],
            )?;
            break;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReturnResult {
    pub branches: Vec<ImportedBranch>,
    pub warnings: Vec<String>,
    pub outcomes: Vec<OpOutcome>,
}

/// The receipt and all inbox/review refs enter one CAS transaction. They are
/// authoritative even if later config, branch switching or rebase is interrupted.
pub fn import_return(
    g: &Git,
    work: &Path,
    bundle: &Path,
    base_branch: &str,
    releases: &[String],
) -> Result<ImportReturnResult> {
    require_work_repo(g, work)?;
    let common = common_dir(g, work)?;
    let _lock = OperationLock::acquire(&common.join("offline-sync-operation"))?;
    g.check_cancelled()?;
    let manifest = Manifest::read_for(bundle)?;
    if manifest
        .as_ref()
        .is_some_and(|m| m.kind != BundleKind::Back)
    {
        return invalid("组合接收只支持回传 bundle；patch 请使用补丁导入入口");
    }
    let base_ref = format!("refs/remotes/origin/{base_branch}");
    let identity = repo::repo_id(g, work, &base_ref)?;
    if manifest.as_ref().is_some_and(|m| m.repo_id != identity) {
        return invalid("回传包与当前工作仓库不是同一个项目");
    }

    // Freeze the bytes before hashing/unbundling. Filename and mount point do not
    // participate in the local identity, so renamed/copied packages stay idempotent.
    let frozen = tempfile::NamedTempFile::new()?;
    fs::copy(bundle, frozen.path())?;
    let key = return_key(g, work, frozen.path(), manifest.as_ref())?;
    let receipt_ref = format!("{RECEIPTS}{key}");
    let existing = repo::list_refs(g, work, &[&receipt_ref])?
        .into_iter()
        .any(|(name, _)| name == receipt_ref);
    let receipt = if existing {
        read_receipt(g, work, &receipt_ref)?
    } else {
        let heads = sync::unpack_snapshot(g, work, frozen.path(), manifest.as_ref())?;
        let mut items = Vec::new();
        let mut warnings = Vec::new();
        if manifest.is_none() {
            warnings.push("兼容手工 bundle：已核对各分支与当前项目具有共同历史".into());
        }
        let mut transaction = String::new();
        for (reference, oid) in heads {
            let Some(source) = reference.strip_prefix("refs/heads/") else {
                continue;
            };
            // Also validate manual bundles before creating any public/private ref.
            if !g
                .exec(
                    Some(work),
                    &args!["merge-base", &base_ref, &oid],
                    None,
                    false,
                )?
                .ok()
            {
                return invalid("回传分支与当前项目没有共同历史");
            }
            let item_id = g
                .query_stdin(work, args!["hash-object", "--stdin"], &reference)?
                .trim()
                .to_owned();
            let local = format!("review/{key}/{item_id}");
            let recorded = manifest
                .as_ref()
                .and_then(|m| m.refs.iter().find(|r| r.name == reference))
                .and_then(|r| r.base.clone());
            let base = match recorded {
                Some(base) => base,
                None => {
                    let mut best: Option<(u64, String)> = None;
                    if source.starts_with("hotfix/") {
                        for release in releases {
                            let remote = format!("refs/remotes/origin/{release}");
                            if repo::rev_exists(g, work, &remote) {
                                let count = g
                                    .query(
                                        work,
                                        args!["rev-list", "--count", format!("{remote}..{oid}")],
                                    )?
                                    .trim()
                                    .parse::<u64>()
                                    .map_err(|_| {
                                        SyncError::Invalid("无法计算发布分支基准".into())
                                    })?;
                                if best.as_ref().is_none_or(|(n, _)| count < *n) {
                                    best = Some((count, release.clone()));
                                }
                            }
                        }
                    }
                    warnings.push(format!("{source} 未记录基准，按旧格式规则推断"));
                    best.map(|(_, b)| b).unwrap_or_else(|| base_branch.into())
                }
            };
            transaction.push_str(&format!("create refs/offline-sync/inbox/{key}/{item_id} {oid}\ncreate refs/heads/{local} {oid}\n"));
            items.push(ReviewItem {
                source: source.into(),
                local,
                original: oid,
                base,
                item_id,
            });
        }
        if items.is_empty() {
            return invalid("回传包中没有分支");
        }
        let receipt = Receipt {
            key: key.clone(),
            items,
            warnings,
        };
        let blob = g.query_stdin(
            work,
            args!["hash-object", "-w", "--stdin"],
            &serde_json::to_string(&receipt)?,
        )?;
        transaction.push_str(&format!("create {receipt_ref} {}\n", blob.trim()));
        g.query_stdin(
            work,
            args!["update-ref", "--no-deref", "--stdin"],
            &transaction,
        )?;
        receipt
    };
    if receipt.key != key {
        return invalid("回传接收记录与包摘要不一致");
    }
    // The receipt seeds missing metadata; a later base change is authoritative.
    for item in &receipt.items {
        if repo::get_sync_base(g, work, &item.local).is_none() {
            repo::set_sync_base(g, work, &item.local, &item.base)?;
        }
    }
    // Reception keeps its CAS lock through metadata repair, but rebase acquires
    // the worktree lock itself (the same lock for the main working repository).
    drop(_lock);
    g.run(
        work,
        args![
            "fetch",
            "--no-tags",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*"
        ],
    )?;
    let mut outcomes = Vec::new();
    for item in &receipt.items {
        g.check_cancelled()?;
        let top_level = g.query(work, args!["rev-parse", "--show-toplevel"])?;
        let mut wt_string = top_level
            .strip_suffix('\n')
            .unwrap_or(&top_level)
            .to_owned();
        let outcome = (|| -> Result<OpOutcome> {
            let gd = repo::git_dir(g, work)?;
            let lock = OperationLock::acquire(&gd.join("offline-sync-operation"))?;
            // Recover a completed rebase before consulting its ready marker.
            // A failed marker write retains the journal for a later retry.
            sync::recover_rebase(g, work, &gd)?;
            let reference = format!("refs/heads/{}", item.local);
            let source = repo::rev_parse(g, work, &reference)?;
            let ready_ref = format!("refs/offline-sync/review-ready/{key}/{}", item.item_id);
            let ready = repo::list_refs(g, work, &[&ready_ref])?
                .into_iter()
                .find(|(r, _)| r == &ready_ref)
                .map(|(_, oid)| oid);
            let active = repo::in_progress_all(g, work);
            // Rebase detaches HEAD, so branch occupancy also needs operation metadata.
            for tree in repo::list_worktrees(g, work)? {
                let owns_branch = tree.branch.as_deref() == Some(item.local.as_str())
                    || active.iter().any(|op| {
                        op.path == tree.path && op.branch.as_deref() == Some(item.local.as_str())
                    });
                if owns_branch && Path::new(&tree.path).canonicalize()? != work.canonicalize()? {
                    wt_string = tree.path;
                    return invalid(format!(
                        "审查分支已被现有工作区占用：{wt_string}；请先在那里完成或中止操作并切换分支"
                    ));
                }
            }
            let item_active = active
                .iter()
                .any(|op| op.branch.as_deref() == Some(item.local.as_str()));
            if ready.as_deref() == Some(source.as_str()) && !item_active {
                return Ok(OpOutcome {
                    ok: true,
                    message: "此回传分支已整理完成".into(),
                    worktree: Some(wt_string.clone()),
                    ..Default::default()
                });
            }
            if let Some(operation) = repo::in_progress(&gd) {
                let files = g.query(work, args!["diff", "--name-only", "--diff-filter=U"])?;
                return Ok(OpOutcome {
                    ok: false,
                    conflict: true,
                    files: files.lines().map(str::to_owned).collect(),
                    message: format!("工作仓库中有未完成的 {operation}，请解决冲突后继续或中止"),
                    worktree: Some(wt_string.clone()),
                });
            }
            if gd.join("offline-sync-patch.json").try_exists()? {
                return invalid("补丁接收记录尚未完成，请先在当前工作仓库继续或中止操作");
            }
            sync::ensure_worktree_clean(g, work)?;
            let base =
                repo::get_sync_base(g, work, &item.local).unwrap_or_else(|| item.base.clone());
            // rebase_onto rechecks local changes and unfinished operations under
            // its own lock before switching to the dedicated review branch.
            drop(lock);
            let mut outcome = sync::rebase_onto(g, work, &item.local, &base, false)?;
            outcome.worktree = Some(wt_string.clone());
            Ok(outcome)
        })();
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(SyncError::Cancelled) => return Err(SyncError::Cancelled),
            Err(error) => OpOutcome {
                message: redact(&error.to_string()),
                worktree: Some(wt_string),
                ..Default::default()
            },
        };
        let stop = !outcome.ok;
        outcomes.push(outcome);
        if stop {
            break;
        }
    }
    let mut branches = Vec::new();
    for item in receipt.items {
        let sha = repo::rev_parse(g, work, &format!("refs/heads/{}", item.local))?;
        let base = repo::get_sync_base(g, work, &item.local).unwrap_or(item.base);
        let base_ref = format!("refs/remotes/origin/{base}");
        let commits = if repo::rev_exists(g, work, &base_ref) {
            repo::commits_between(g, work, &base_ref, &sha)?
        } else {
            Vec::new()
        };
        branches.push(ImportedBranch {
            source: item.source,
            local: item.local,
            sha,
            base,
            commits,
        });
    }
    Ok(ImportReturnResult {
        branches,
        warnings: receipt.warnings,
        outcomes,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPlan {
    pub plan_id: String,
    pub source_oid: String,
    pub target_ref: String,
    pub remote_url: String,
    pub remote_oid: Option<String>,
    pub base_oid: String,
    pub commits: Vec<CommitInfo>,
    pub non_fast_forward: bool,
}

struct StoredPlan {
    plan: PushPlan,
    work: PathBuf,
    common: PathBuf,
    source_ref: String,
    pushed_ref: Option<String>,
    remote_url: String,
    configuration: String,
    force: bool,
}

static PLANS: LazyLock<Mutex<HashMap<String, StoredPlan>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_PLAN: AtomicU64 = AtomicU64::new(1);

fn remote_configuration(g: &Git, work: &Path) -> Result<(String, String)> {
    require_work_repo(g, work)?;
    let pushspec = g.exec(
        Some(work),
        &args!["config", "--get-all", "remote.origin.push"],
        None,
        false,
    )?;
    if pushspec.code != 1 {
        return invalid("origin 配置了 push refspec 或配置不可读，请清除后使用明确目标推送");
    }
    let fetch = g.query(work, args!["remote", "get-url", "--all", "origin"])?;
    let push = g.query(
        work,
        args!["remote", "get-url", "--push", "--all", "origin"],
    )?;
    if fetch.lines().count() != 1 || push.lines().count() != 1 {
        return invalid("origin 必须只有一个 fetch 地址和一个 push 地址");
    }
    let url = push.trim().to_owned();
    if url.is_empty() || url.starts_with('-') || url == "OFFLINE-SYNC-PUSH-TO-MIRROR-DISABLED" {
        return invalid("该远程地址禁止推送");
    }
    let local = Path::new(url.strip_prefix("file://").unwrap_or(&url));
    let local = if local.is_absolute() {
        local.to_path_buf()
    } else {
        work.join(local)
    };
    if local.exists() && repo::is_ext_mirror(g, &local) {
        return invalid("禁止向外网镜像推送");
    }
    let configuration = g.query(
        work,
        args![
            "config",
            "--null",
            "--get-regexp",
            r"^(remote\.origin\.|push\.|url\.)"
        ],
    )?;
    Ok((url, configuration))
}

// A one-use alias is rewritten exactly once to the already resolved address.
// An explicit pushurl disables pushInsteadOf; the alias prevents insteadOf from
// matching the final address a second time. Nothing is saved in repository config.
struct FrozenRemote {
    name: String,
    config: Vec<OsString>,
    _file: tempfile::NamedTempFile,
}

impl FrozenRemote {
    fn new(g: &Git, work: &Path, url: &str) -> Result<Self> {
        let name = format!(
            "offline-sync-frozen-{}-{}",
            std::process::id(),
            NEXT_PLAN.fetch_add(1, Ordering::Relaxed)
        );
        let existing = g.exec(
            Some(work),
            &args!["config", "--get-regexp", format!(r"^remote\.{name}\.")],
            None,
            false,
        )?;
        if existing.code != 1 {
            return invalid("临时推送 remote 名称已被配置占用或配置不可读，请重新检查");
        }
        let alias = format!("{name}:");
        let file = tempfile::NamedTempFile::new()?;
        fs::write(
            file.path(),
            format!("[remote \"{name}\"]\nurl = {alias}\npushurl = {alias}\n"),
        )?;
        // Pass the URL-containing key separately: URLs may contain '=' and
        // therefore cannot safely be embedded in a `-c key=value` argument.
        g.query(
            work,
            args![
                "config",
                "--file",
                file.path(),
                "--add",
                format!("url.{url}.insteadOf"),
                &alias
            ],
        )?;
        let remote = Self {
            config: args!["-c", format!("include.path={}", file.path().display())],
            name,
            _file: file,
        };
        // Check both effective addresses, including any existing rewrite rules.
        let resolved = g.query(work, remote.command(args!["remote", "-v"]))?;
        let prefix = format!("{}\t", remote.name);
        let addresses: Vec<_> = resolved
            .lines()
            .filter(|line| line.starts_with(&prefix))
            .collect();
        if addresses
            != [
                format!("{prefix}{url} (fetch)"),
                format!("{prefix}{url} (push)"),
            ]
        {
            return invalid("临时 remote 地址与已确认地址不一致，请检查 URL 重写配置");
        }
        Ok(remote)
    }

    fn command(&self, command: Vec<OsString>) -> Vec<OsString> {
        let mut args = self.config.clone();
        args.extend(command);
        args
    }
}

fn remote_oid(g: &Git, work: &Path, remote: &FrozenRemote, target: &str) -> Result<Option<String>> {
    let output = g.query(
        work,
        remote.command(args!["ls-remote", "--refs", "--", &remote.name, target]),
    )?;
    let mut found = None;
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let oid = parts.next().unwrap_or_default();
        if parts.next() != Some(target) || !super::manifest::valid_oid(oid) || found.is_some() {
            return invalid("远程返回了不明确的目标引用");
        }
        found = Some(oid.to_owned());
    }
    Ok(found)
}

pub fn prepare_push(
    g: &Git,
    work: &Path,
    branch: &str,
    force_with_lease: bool,
) -> Result<PushPlan> {
    let work = std::path::absolute(work)?;
    let common = common_dir(g, &work)?;
    let _lock = OperationLock::acquire(&common.join("offline-sync-operation"))?;
    let (url, configuration) = remote_configuration(g, &work)?;
    let source_ref = format!("refs/heads/{branch}");
    if !super::manifest::valid_ref(&source_ref) {
        return invalid("推送分支名无效");
    }
    let item = review_item(g, &work, branch)?;
    let target = item
        .as_ref()
        .map(|(_, i)| i.source.as_str())
        .unwrap_or(branch);
    let target_ref = format!("refs/heads/{target}");
    if !super::manifest::valid_ref(&target_ref) {
        return invalid("原始推送目标无效");
    }
    let source_oid = repo::rev_parse(g, &work, &source_ref)?;
    let remote = FrozenRemote::new(g, &work, &url)?;
    let old = remote_oid(g, &work, &remote, &target_ref)?;
    if let Some(oid) = &old {
        if !repo::rev_exists(g, &work, oid) {
            g.run(
                &work,
                remote.command(args![
                    "fetch",
                    "--no-tags",
                    "--no-write-fetch-head",
                    &remote.name,
                    &target_ref
                ]),
            )?;
            if remote_oid(g, &work, &remote, &target_ref)?.as_ref() != Some(oid) {
                return invalid("远程分支已变化，请重新检查");
            }
        }
    }
    let base_oid = match &old {
        Some(oid) => oid.clone(),
        None => {
            let base = repo::get_sync_base(g, &work, branch)
                .or_else(|| item.as_ref().map(|(_, i)| i.base.clone()));
            let reference = match base {
                Some(base) => format!("refs/remotes/origin/{base}"),
                None => "refs/remotes/origin/HEAD".into(),
            };
            repo::rev_parse(g, &work, &reference)?
        }
    };
    let non_fast_forward = if let Some(oid) = &old {
        let check = g.exec(
            Some(&work),
            &args!["merge-base", "--is-ancestor", oid, &source_oid],
            None,
            false,
        )?;
        if check.code > 1 {
            return invalid("无法判断远程目标是否可以快进");
        }
        !check.ok()
    } else {
        false
    };
    let plan = PushPlan {
        plan_id: format!(
            "{}-{}",
            std::process::id(),
            NEXT_PLAN.fetch_add(1, Ordering::Relaxed)
        ),
        commits: repo::commits_between(g, &work, &base_oid, &source_oid)?,
        source_oid,
        target_ref,
        remote_url: redact(&url),
        remote_oid: old,
        base_oid,
        non_fast_forward,
    };
    PLANS
        .lock()
        .map_err(|_| SyncError::Invalid("推送计划存储不可用".into()))?
        .insert(
            plan.plan_id.clone(),
            StoredPlan {
                plan: plan.clone(),
                work,
                common,
                source_ref,
                pushed_ref: item.map(|(key, i)| format!("{PUSHED}{key}/{}", i.item_id)),
                remote_url: url,
                configuration,
                force: force_with_lease,
            },
        );
    Ok(plan)
}

pub fn execute_push(g: &Git, plan_id: &str) -> Result<OpOutcome> {
    let stored = PLANS
        .lock()
        .map_err(|_| SyncError::Invalid("推送计划存储不可用".into()))?
        .remove(plan_id)
        .ok_or_else(|| SyncError::Invalid("推送计划已失效，请重新检查提交".into()))?;
    let plan = &stored.plan;
    let work = &stored.work;
    let _lock = OperationLock::acquire(&stored.common.join("offline-sync-operation"))?;
    let (url, configuration) = remote_configuration(g, work)?;
    if common_dir(g, work)?.canonicalize()? != stored.common.canonicalize()?
        || url != stored.remote_url
        || configuration != stored.configuration
        || repo::rev_parse(g, work, &stored.source_ref)? != plan.source_oid
    {
        return invalid("planStale：提交或远程配置已变化，请重新检查");
    }
    let remote = FrozenRemote::new(g, work, &url)?;
    if remote_oid(g, work, &remote, &plan.target_ref)? != plan.remote_oid {
        return invalid("planStale：远程目标已变化，请重新检查");
    }
    if plan.non_fast_forward && !stored.force {
        return invalid("目标不是快进更新，请明确确认 force-with-lease 后重新准备推送");
    }
    g.check_cancelled()?;
    let mut command = args![
        "-c",
        "push.followTags=false",
        "push",
        "--no-follow-tags",
        "--recurse-submodules=no"
    ];
    // Even a fast-forward push must not recreate a ref deleted after preflight.
    command.push(
        format!(
            "--force-with-lease={}:{}",
            plan.target_ref,
            plan.remote_oid.as_deref().unwrap_or("")
        )
        .into(),
    );
    command.extend(args![
        "--",
        &remote.name,
        format!("{}:{}", plan.source_oid, plan.target_ref)
    ]);
    let pushed = g.exec(Some(work), &remote.command(command), None, true);
    // Cancellation/timeout may occur after the server accepted the ref. A fresh
    // bounded control context is mandatory to establish the actual result.
    let verification = g.verification().with_timeout(Duration::from_secs(30));
    let observed = remote_oid(&verification, work, &remote, &plan.target_ref);
    match observed {
        Ok(Some(oid)) if oid == plan.source_oid => {
            let mut message = format!("已核实推送 {}", plan.target_ref);
            if let Some(reference) = &stored.pushed_ref {
                if let Err(error) = verification.run(
                    work,
                    args!["update-ref", "--no-deref", reference, &plan.source_oid],
                ) {
                    message = format!(
                        "已核实推送 {}，推送已完成但记录失败，请检查：{}",
                        plan.target_ref,
                        redact(&error.to_string())
                    );
                }
            }
            Ok(OpOutcome {
                ok: true,
                message,
                ..Default::default()
            })
        }
        Ok(actual) => {
            let detail = match pushed {
                Ok(out) => redact(out.stderr.trim()),
                Err(e) => redact(&e.to_string()),
            };
            Ok(OpOutcome { message: format!("推送结果未知：远程当前为 {}，未观察到计划提交；可能被拒绝或随后被其他提交更新，请检查后重新准备。{detail}", actual.as_deref().unwrap_or("不存在")), ..Default::default() })
        }
        Err(e) => Ok(OpOutcome {
            message: format!(
                "推送结果未知：无法核验远程目标，推送可能已经生效，请恢复连接后检查。{}",
                redact(&e.to_string())
            ),
            ..Default::default()
        }),
    }
}
