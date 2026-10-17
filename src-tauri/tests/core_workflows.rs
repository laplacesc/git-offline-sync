//! Business invariants exercised against real temporary Git repositories.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use git_offline_sync_lib::core::git::{Git, LogEvent, LogKind, OperationControl};
use git_offline_sync_lib::core::manifest::{manifest_path_for, Manifest};
use git_offline_sync_lib::core::{repo, review, sync};

static ENV: Mutex<()> = Mutex::new(());
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().into()
}
fn commit(dir: &Path, name: &str, text: &str) {
    fs::write(dir.join(name), text).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "-qm", name]);
}
fn payload(out: sync::ExportOutcome) -> PathBuf {
    match out {
        sync::ExportOutcome::Exported { payload, .. } => payload.into(),
        other => panic!("{other:?}"),
    }
}
struct Fixture {
    root: tempfile::TempDir,
    seed: PathBuf,
    remote: PathBuf,
    work: PathBuf,
    mirror: PathBuf,
    ext: PathBuf,
    dev: PathBuf,
    usb: PathBuf,
}
impl Fixture {
    fn new(g: &Git) -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path();
        let cfg = path.join("gitconfig");
        fs::write(
            &cfg,
            "[init]\n defaultBranch = main\n[user]\n name = Tester\n email = tester@example.com\n",
        )
        .unwrap();
        std::env::set_var("GIT_CONFIG_GLOBAL", &cfg);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        let seed = path.join("seed");
        let remote = path.join("remote.git");
        let work = path.join("work");
        let mirror = path.join("mirror.git");
        let ext = path.join("external.git");
        let dev = path.join("dev");
        let usb = path.join("usb");
        git(path, &["init", "-q", seed.to_str().unwrap()]);
        commit(&seed, "base", "base\n");
        git(
            path,
            &[
                "clone",
                "--bare",
                seed.to_str().unwrap(),
                remote.to_str().unwrap(),
            ],
        );
        git(
            &seed,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(
            path,
            &["clone", remote.to_str().unwrap(), work.to_str().unwrap()],
        );
        sync::init_mirror(g, remote.to_str().unwrap(), &mirror).unwrap();
        let full =
            payload(sync::export_out(g, &mirror, &usb, "test", "main", true, false).unwrap());
        sync::import_in(g, &full, &ext, false).unwrap();
        sync::create_dev_repo(g, &ext, &dev, "Tester", "tester@example.com").unwrap();
        Self {
            root,
            seed,
            remote,
            work,
            mirror,
            ext,
            dev,
            usb,
        }
    }
    fn back(&self, g: &Git) -> PathBuf {
        sync::create_branch(g, &self.dev, "feature/return", "main", None).unwrap();
        commit(&self.dev, "feature", "returned\n");
        payload(
            sync::export_back(
                g,
                &self.dev,
                &self.ext,
                &["feature/return".into()],
                &self.usb,
                "test",
                "main",
                &[],
            )
            .unwrap(),
        )
    }
    fn advance(&self, g: &Git) -> PathBuf {
        commit(&self.seed, "upstream", "advanced\n");
        git(&self.seed, &["push", "origin", "main"]);
        payload(sync::export_out(g, &self.mirror, &self.usb, "test", "main", true, false).unwrap())
    }
}

#[test]
fn return_package_query_recognizes_copied_packages_and_reports_corrupt_receipts() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let f = Fixture::new(&g);
    let bundle = f.back(&g);
    let before = review::list_return_packages(&g, &f.work, &f.usb).unwrap();
    assert!(before
        .iter()
        .all(|p| !p.received && p.receipt_key.is_none()));
    assert!(serde_json::to_value(&before[0]).unwrap()["receiptKey"].is_null());
    assert!(repo::status(&g, &f.ext, "main", &[])
        .unwrap()
        .review_sources
        .is_empty());
    let absent = f.root.path().join("not-cloned");
    assert_eq!(
        review::list_return_packages(&g, &absent, &f.usb)
            .unwrap()
            .len(),
        before.len()
    );
    assert!(!absent.exists());
    fs::create_dir(&absent).unwrap();
    assert!(review::list_return_packages(&g, &absent, &f.usb)
        .unwrap()
        .iter()
        .all(|p| !p.received));

    // Reception succeeds but upstream fetch fails before any worktree is built.
    let unavailable = f.root.path().join("unavailable.git");
    git(
        &f.work,
        &["remote", "set-url", "origin", unavailable.to_str().unwrap()],
    );
    assert!(review::import_return(&g, &f.work, &bundle, "main", &[]).is_err());
    let pending = repo::status(&g, &f.work, "main", &[]).unwrap();
    let pending_branch = pending
        .branches
        .iter()
        .find(|b| b.name.starts_with("review/"))
        .unwrap();
    assert!(pending_branch.worktree.is_none());
    assert_eq!(
        pending
            .review_sources
            .get(&pending_branch.name)
            .map(String::as_str),
        Some("feature/return")
    );
    assert_eq!(
        serde_json::to_value(&pending).unwrap()["reviewSources"][&pending_branch.name],
        "feature/return"
    );
    let pending_packages = review::list_return_packages(&g, &f.work, &f.usb).unwrap();
    let received = pending_packages.iter().find(|p| p.received).unwrap();
    assert!(pending_branch.name.starts_with(&format!(
        "review/{}/",
        received.receipt_key.as_ref().unwrap()
    )));
    git(
        &f.work,
        &["remote", "set-url", "origin", f.remote.to_str().unwrap()],
    );
    let accepted = review::import_return(&g, &f.work, &bundle, "main", &[]).unwrap();
    assert_eq!(accepted.branches[0].local, pending_branch.name);
    assert!(accepted.outcomes[0].ok);
    let copied_dir = f.root.path().join("other-medium");
    fs::create_dir(&copied_dir).unwrap();
    let copied = copied_dir.join("renamed.bundle");
    fs::copy(&bundle, &copied).unwrap();
    let mut manifest = Manifest::read_for(&bundle).unwrap().unwrap();
    manifest.payload = "renamed.bundle".into();
    manifest.write_for(&copied).unwrap();

    // A fresh executor obtains receipt state from Git, without any UI/process cache.
    let restarted = Git::new(None, &log);
    let packages = review::list_return_packages(&restarted, &f.work, &copied_dir).unwrap();
    assert_eq!(packages.len(), 1);
    assert!(packages[0].received);
    assert_eq!(packages[0].receipt_key, received.receipt_key);
    let restored = repo::status(&restarted, &f.work, "main", &[]).unwrap();
    assert_eq!(
        restored
            .review_sources
            .get(&accepted.branches[0].local)
            .map(String::as_str),
        Some("feature/return")
    );
    let json = serde_json::to_value(&packages[0]).unwrap();
    assert_eq!(json["receiptKey"], received.receipt_key.as_deref().unwrap());
    assert_eq!(json["payloadPath"], copied.to_string_lossy().as_ref());
    assert_eq!(json["payloadExists"], true);
    assert!(json.get("manifestPath").is_some());
    assert!(json.get("manifest").is_some());
    assert!(json.get("package").is_none());
    let retried = review::import_return(&restarted, &f.work, &copied, "main", &[]).unwrap();
    assert_eq!(retried.branches[0].local, accepted.branches[0].local);
    assert!(review::list_return_packages(&restarted, &f.work, &copied_dir).unwrap()[0].received);

    let receipts = repo::list_refs(&g, &f.work, &["refs/offline-sync/return-receipts"]).unwrap();
    let (reference, original) = &receipts[0];
    let corrupt = g
        .query_stdin(
            &f.work,
            git_offline_sync_lib::args!["hash-object", "-w", "--stdin"],
            "invalid receipt JSON",
        )
        .unwrap();
    git(&f.work, &["update-ref", reference, corrupt.trim()]);
    assert!(review::list_return_packages(&g, &f.work, &copied_dir).is_err());
    assert!(repo::status(&g, &f.work, "main", &[]).is_err());
    git(&f.work, &["update-ref", reference, original]);
    // Broken loose refs can otherwise disappear from for-each-ref with exit code 0.
    fs::write(
        f.work.join(".git/refs/offline-sync/return-receipts/broken"),
        "not-an-oid\n",
    )
    .unwrap();
    assert!(review::list_return_packages(&g, &f.work, &copied_dir).is_err());
    assert!(repo::status(&g, &f.work, "main", &[]).is_err());
}

#[test]
fn combined_sync_preserves_development_and_reads_real_refs() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let f = Fixture::new(&g);
    sync::create_branch(&g, &f.dev, "feature/local", "main", None).unwrap();
    commit(&f.dev, "local", "local\n");
    fs::write(f.dev.join("base"), "uncommitted\n").unwrap();
    let head = git(&f.dev, &["rev-parse", "HEAD"]);
    let fresh = f.root.path().join("new-dev");
    let dirs = vec![
        f.dev.to_string_lossy().into_owned(),
        fresh.to_string_lossy().into_owned(),
    ];
    let incr = f.advance(&g);
    sync::import_in(&g, &incr, &f.ext, false).unwrap();
    let status = sync::dev_sync_status(&g, &f.ext, &dirs);
    assert_eq!(status[0].status, "needsFetch");
    assert_eq!(status[1].status, "notCloned");
    let result =
        sync::sync_updates(&g, &f.ext, None, &dirs, "Tester", "tester@example.com").unwrap();
    assert!(result.imported.is_none());
    assert_eq!(result.repositories[0].status, "fetched");
    assert_eq!(result.repositories[1].status, "cloned");
    assert_eq!(git(&f.dev, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&f.dev, &["branch", "--show-current"]), "feature/local");
    assert_eq!(
        fs::read_to_string(f.dev.join("base")).unwrap(),
        "uncommitted\n"
    );
    assert!(sync::dev_sync_status(&g, &f.ext, &dirs)
        .iter()
        .all(|s| s.status == "upToDate"));
    git(&f.dev, &["tag", "status-tag"]);
    git(
        &f.dev,
        &["update-ref", "refs/offline-sync/test-private", "HEAD"],
    );
    let workspace = repo::status(&g, &f.dev, "main", &[]).unwrap();
    assert!(workspace
        .refs
        .iter()
        .any(|r| r.name == "refs/tags/status-tag"));
    assert!(workspace
        .refs
        .iter()
        .any(|r| r.name == "refs/heads/feature/local"));
    assert!(workspace
        .refs
        .iter()
        .all(|r| !r.name.starts_with("refs/offline-sync/")));
    let mirror_status = repo::status(&g, &f.ext, "main", &[]).unwrap();
    assert_eq!(
        mirror_status.refs.len(),
        repo::list_refs(&g, &f.ext, &["refs/heads", "refs/tags"])
            .unwrap()
            .len()
    );
    git(
        &fresh,
        &["remote", "set-url", "origin", f.remote.to_str().unwrap()],
    );
    let status = sync::dev_sync_status(&g, &f.ext, &dirs);
    assert_eq!(status[1].status, "unknown");
    assert!(status[1].error.is_some());
    let occupied = f.root.path().join("occupied");
    fs::create_dir(&occupied).unwrap();
    fs::write(occupied.join("keep"), "keep").unwrap();
    let statuses = sync::dev_sync_status(&g, &f.ext, &[occupied.to_string_lossy().into_owned()]);
    assert_eq!(statuses[0].status, "unknown");
}

#[test]
fn combined_sync_cancellation_does_not_start_later_repositories() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let quiet = |_: LogEvent| {};
    let setup = Git::new(None, &quiet);
    let f = Fixture::new(&setup);
    let incr = f.advance(&setup);
    let control = Arc::new(OperationControl::default());
    let cancel = control.clone();
    let logger = move |event: LogEvent| {
        if event.text.contains("git fetch") {
            cancel.cancel();
        }
    };
    let g = Git::new(None, &logger).with_control(control);
    let later = f.root.path().join("must-not-clone");
    let result = sync::sync_updates(
        &g,
        &f.ext,
        Some(&incr),
        &[
            f.dev.to_string_lossy().into_owned(),
            later.to_string_lossy().into_owned(),
        ],
        "",
        "",
    );
    assert!(result.is_err());
    assert!(!later.exists());
    assert_eq!(
        repo::load_state::<repo::MirrorState>(&f.ext)
            .unwrap()
            .last_in_seq,
        2
    );
    sync::sync_updates(
        &setup,
        &f.ext,
        None,
        &[f.dev.to_string_lossy().into_owned()],
        "",
        "",
    )
    .unwrap();
}

#[test]
fn receipts_reimport_after_rebase_without_touching_main_workspace_or_original_branch() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let f = Fixture::new(&g);
    let bundle = f.back(&g);
    f.advance(&g);
    git(&f.work, &["branch", "feature/return"]);
    let original = git(&f.work, &["rev-parse", "feature/return"]);
    let main = git(&f.work, &["rev-parse", "HEAD"]);
    fs::write(f.work.join("base"), "local work\n").unwrap();
    let first = review::import_return(&g, &f.work, &bundle, "main", &[]).unwrap();
    assert_eq!(first.branches.len(), 1);
    assert!(first.outcomes[0].ok, "{:?}", first.outcomes);
    let branch = &first.branches[0];
    assert_ne!(branch.sha, git(&f.dev, &["rev-parse", "feature/return"]));
    assert!(branch.local.starts_with("review/"));
    assert_eq!(git(&f.work, &["rev-parse", "HEAD"]), main);
    assert_eq!(git(&f.work, &["branch", "--show-current"]), "main");
    assert_eq!(git(&f.work, &["rev-parse", "feature/return"]), original);
    assert_eq!(
        fs::read_to_string(f.work.join("base")).unwrap(),
        "local work\n"
    );
    let copied = f.root.path().join("renamed.bundle");
    fs::copy(&bundle, &copied).unwrap();
    let mut manifest = Manifest::read_for(&bundle).unwrap().unwrap();
    manifest.payload = "renamed.bundle".into();
    manifest.write_for(&copied).unwrap();
    // Delete derived config; the immutable receipt must be enough to recover it.
    git(
        &f.work,
        &[
            "config",
            "--unset",
            &format!("branch.{}.syncBase", branch.local),
        ],
    );
    let second = review::import_return(&g, &f.work, &copied, "main", &[]).unwrap();
    assert_eq!(second.branches[0].local, branch.local);
    assert_eq!(second.branches[0].sha, branch.sha);
    assert_eq!(
        repo::list_refs(&g, &f.work, &["refs/heads/review"])
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        repo::list_refs(&g, &f.work, &["refs/offline-sync/return-receipts"])
            .unwrap()
            .len(),
        1
    );
    let plan = review::prepare_push(&g, &f.work, &branch.local, false).unwrap();
    assert_eq!(plan.target_ref, "refs/heads/feature/return");
    assert!(review::execute_push(&g, &plan.plan_id).unwrap().ok);
    assert_eq!(git(&f.remote, &["rev-parse", "feature/return"]), branch.sha);
    assert!(git(&f.remote, &["for-each-ref", "refs/heads/review"]).is_empty());
}

#[test]
fn frozen_push_address_is_not_rewritten_again() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    for mode in ["explicit-pushurl", "insteadOf-chain", "pushInsteadOf-chain"] {
        let mut f = Fixture::new(&g);
        let address_with_equals = f.root.path().join("remote=with space.git");
        fs::rename(&f.remote, &address_with_equals).unwrap();
        f.remote = address_with_equals;
        git(
            &f.work,
            &["config", "remote.origin.url", f.remote.to_str().unwrap()],
        );
        let other = f.root.path().join("other.git");
        git(
            f.root.path(),
            &[
                "clone",
                "--bare",
                f.seed.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        sync::create_branch(&g, &f.work, "feature/frozen", "main", None).unwrap();
        commit(&f.work, "frozen", "frozen\n");
        let address = f.remote.to_str().unwrap();
        let other_address = other.to_str().unwrap();
        match mode {
            "explicit-pushurl" => {
                git(&f.work, &["config", "remote.origin.pushurl", address]);
                git(
                    &f.work,
                    &[
                        "config",
                        &format!("url.{other_address}.pushInsteadOf"),
                        address,
                    ],
                );
            }
            "insteadOf-chain" => {
                git(
                    &f.work,
                    &["config", "remote.origin.pushurl", "frozen-input:"],
                );
                git(
                    &f.work,
                    &[
                        "config",
                        &format!("url.{address}.insteadOf"),
                        "frozen-input:",
                    ],
                );
                git(
                    &f.work,
                    &["config", &format!("url.{other_address}.insteadOf"), address],
                );
            }
            _ => {
                git(&f.work, &["config", "remote.origin.url", "frozen-input:"]);
                git(
                    &f.work,
                    &[
                        "config",
                        &format!("url.{address}.pushInsteadOf"),
                        "frozen-input:",
                    ],
                );
                git(
                    &f.work,
                    &[
                        "config",
                        &format!("url.{other_address}.pushInsteadOf"),
                        address,
                    ],
                );
            }
        }
        let before = fs::read(f.work.join(".git/config")).unwrap();
        let plan = review::prepare_push(&g, &f.work, "feature/frozen", false).unwrap();
        assert_eq!(plan.remote_url, address, "{mode}");
        let outcome = review::execute_push(&g, &plan.plan_id).unwrap();
        assert!(outcome.ok, "{mode}: {}", outcome.message);
        assert_eq!(
            git(&f.remote, &["rev-parse", "feature/frozen"]),
            plan.source_oid,
            "{mode}"
        );
        assert!(
            git(&other, &["for-each-ref", "refs/heads/feature/frozen"]).is_empty(),
            "{mode}"
        );
        assert_eq!(fs::read(f.work.join(".git/config")).unwrap(), before);
    }
}

#[test]
fn ordinary_push_does_not_recreate_a_target_deleted_after_preflight() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let quiet = |_: LogEvent| {};
    let setup = Git::new(None, &quiet);
    let f = Fixture::new(&setup);
    git(&f.seed, &["push", "origin", "main:feature/race"]);
    sync::create_branch(&setup, &f.work, "feature/race", "main", None).unwrap();
    commit(&f.work, "race", "race\n");
    let plan = review::prepare_push(&setup, &f.work, "feature/race", false).unwrap();
    assert!(!plan.non_fast_forward);
    assert!(plan.remote_oid.is_some());
    let deleted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let triggered = deleted.clone();
    let remote = f.remote.clone();
    let logger = move |event: LogEvent| {
        if event.kind == LogKind::Cmd && event.text.contains(" push ") {
            git(&remote, &["update-ref", "-d", "refs/heads/feature/race"]);
            triggered.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    };
    let g = Git::new(None, &logger);
    let outcome = review::execute_push(&g, &plan.plan_id).unwrap();
    assert!(deleted.load(std::sync::atomic::Ordering::SeqCst));
    assert!(!outcome.ok, "{}", outcome.message);
    assert!(git(&f.remote, &["for-each-ref", "refs/heads/feature/race"]).is_empty());
}

#[test]
fn reimport_preserves_a_review_rebased_to_release() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let f = Fixture::new(&g);
    let bundle = f.back(&g);
    let first = review::import_return(&g, &f.work, &bundle, "main", &[]).unwrap();
    assert!(first.outcomes[0].ok);
    let local = &first.branches[0].local;
    git(&f.seed, &["switch", "-c", "release"]);
    commit(&f.seed, "release-only", "release only\n");
    git(&f.seed, &["push", "origin", "release"]);
    assert!(
        sync::rebase_onto(&g, &f.work, local, "release", true)
            .unwrap()
            .ok
    );
    let ready_head = git(&f.work, &["rev-parse", local]);
    // Make another rebase visibly wrong, even if it happens to use release.
    commit(&f.seed, "later-release", "later release\n");
    git(&f.seed, &["push", "origin", "release"]);
    let retried = review::import_return(&g, &f.work, &bundle, "main", &["release".into()]).unwrap();
    assert!(retried.outcomes[0].ok, "{:?}", retried.outcomes);
    assert_eq!(git(&f.work, &["rev-parse", local]), ready_head);
    assert_eq!(
        repo::get_sync_base(&g, &f.work, local).as_deref(),
        Some("release")
    );
    assert_eq!(retried.branches[0].base, "release");
    assert!(retried.branches[0]
        .commits
        .iter()
        .all(|c| c.subject != "release-only"));
    let plan = review::prepare_push(&g, &f.work, local, false).unwrap();
    assert_eq!(
        plan.base_oid,
        git(&f.work, &["rev-parse", "origin/release"])
    );
    assert!(plan.commits.iter().all(|c| c.subject != "release-only"));
}

#[test]
fn push_confirmation_freezes_source_remote_config_and_explicit_lease() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let f = Fixture::new(&g);
    sync::create_branch(&g, &f.work, "feature/push", "main", None).unwrap();
    commit(&f.work, "one", "one\n");
    let stale = review::prepare_push(&g, &f.work, "feature/push", false).unwrap();
    commit(&f.work, "two", "two\n");
    assert!(review::execute_push(&g, &stale.plan_id)
        .unwrap_err()
        .to_string()
        .contains("planStale"));
    assert!(git(&f.remote, &["for-each-ref", "refs/heads/feature/push"]).is_empty());
    let changed = review::prepare_push(&g, &f.work, "feature/push", false).unwrap();
    git(&f.work, &["config", "push.default", "matching"]);
    assert!(review::execute_push(&g, &changed.plan_id).is_err());
    let success = review::prepare_push(&g, &f.work, "feature/push", false).unwrap();
    assert!(review::execute_push(&g, &success.plan_id).unwrap().ok);
    let previous = git(&f.remote, &["rev-parse", "feature/push"]);
    git(&f.work, &["reset", "--hard", "origin/main"]);
    commit(&f.work, "replacement", "replacement\n");
    let non_ff = review::prepare_push(&g, &f.work, "feature/push", false).unwrap();
    assert!(non_ff.non_fast_forward);
    assert!(review::execute_push(&g, &non_ff.plan_id).is_err());
    let lease = review::prepare_push(&g, &f.work, "feature/push", true).unwrap();
    assert_eq!(lease.remote_oid.as_deref(), Some(previous.as_str()));
    git(&f.seed, &["push", "origin", "main:feature/push", "--force"]);
    assert!(review::execute_push(&g, &lease.plan_id)
        .unwrap_err()
        .to_string()
        .contains("planStale"));
    let lease = review::prepare_push(&g, &f.work, "feature/push", true).unwrap();
    assert!(review::execute_push(&g, &lease.plan_id).unwrap().ok);
    git(
        &f.work,
        &[
            "config",
            "--add",
            "remote.origin.pushurl",
            f.remote.to_str().unwrap(),
        ],
    );
    git(
        &f.work,
        &["config", "--add", "remote.origin.pushurl", "other"],
    );
    assert!(review::prepare_push(&g, &f.work, "feature/push", true).is_err());
}

#[test]
fn push_effect_is_verified_even_after_cancellation() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let quiet = |_: LogEvent| {};
    let setup = Git::new(None, &quiet);
    let f = Fixture::new(&setup);
    sync::create_branch(&setup, &f.work, "feature/cancel", "main", None).unwrap();
    commit(&f.work, "cancel", "cancel\n");
    let plan = review::prepare_push(&setup, &f.work, "feature/cancel", false).unwrap();
    let control = Arc::new(OperationControl::default());
    let cancel = control.clone();
    let logger = move |event: LogEvent| {
        if event.text.starts_with("To ") {
            cancel.cancel();
        }
    };
    let g = Git::new(None, &logger).with_control(control.clone());
    let outcome = review::execute_push(&g, &plan.plan_id).unwrap();
    assert!(control.is_cancelled());
    assert!(outcome.ok, "{}", outcome.message);
    assert_eq!(
        git(&f.remote, &["rev-parse", "feature/cancel"]),
        plan.source_oid
    );
}

#[test]
fn old_export_journal_never_restores_stale_import_cursor_and_pending_blocks_import() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let f = Fixture::new(&g);
    let bundle = f.back(&g);
    let manifest = Manifest::read_for(&bundle).unwrap().unwrap();
    let old_state = repo::load_state::<repo::MirrorState>(&f.ext).unwrap();
    let incr = f.advance(&g);
    sync::import_in(&g, &incr, &f.ext, false).unwrap();
    // Simulate a legacy pending return export that published its files but did
    // not commit backSeq; an independently newer import must still survive.
    let mut current = repo::load_state::<repo::MirrorState>(&f.ext).unwrap();
    current.back_seq = 0;
    repo::save_state(&f.ext, &current).unwrap();
    let journal_path = f.ext.join("offline-sync/export-pending.json");
    let journal = serde_json::json!({"staging": f.root.path().join("gone-staging"), "destination": bundle, "manifest": manifest, "state": old_state, "warnings": []});
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    // Replay a legacy journal whose full state snapshot predates the import.
    sync::export_back(
        &g,
        &f.dev,
        &f.ext,
        &["feature/return".into()],
        &f.usb,
        "test",
        "main",
        &[],
    )
    .unwrap();
    let state = repo::load_state::<repo::MirrorState>(&f.ext).unwrap();
    assert_eq!(state.last_in_seq, 2);
    assert_eq!(state.back_seq, 1);
    let mut missing = journal.clone();
    missing["destination"] = serde_json::json!(f
        .root
        .path()
        .join("unavailable")
        .join(bundle.file_name().unwrap()));
    fs::write(&journal_path, serde_json::to_vec(&missing).unwrap()).unwrap();
    let before = repo::list_refs(&g, &f.ext, &["refs/heads", "refs/tags"]).unwrap();
    assert!(sync::import_in(&g, &incr, &f.ext, false).is_err());
    assert_eq!(
        repo::list_refs(&g, &f.ext, &["refs/heads", "refs/tags"]).unwrap(),
        before
    );
    assert_eq!(
        repo::load_state::<repo::MirrorState>(&f.ext)
            .unwrap()
            .last_in_seq,
        2
    );
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    let mut state = state;
    state.back_seq = 7;
    repo::save_state(&f.ext, &state).unwrap();
    assert!(sync::export_back(&g, &f.dev, &f.ext, &[], &f.usb, "test", "main", &[]).is_err());
    assert_eq!(
        repo::load_state::<repo::MirrorState>(&f.ext)
            .unwrap()
            .back_seq,
        7
    );
    assert!(manifest_path_for(&bundle).exists());
}

#[test]
fn review_conflict_retry_reuses_worktree_and_existing_continue_abort() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let f = Fixture::new(&g);
    sync::create_branch(&g, &f.dev, "feature/conflict", "main", None).unwrap();
    commit(&f.dev, "base", "external change\n");
    let bundle = payload(
        sync::export_back(
            &g,
            &f.dev,
            &f.ext,
            &["feature/conflict".into()],
            &f.usb,
            "test",
            "main",
            &[],
        )
        .unwrap(),
    );
    commit(&f.seed, "base", "internal change\n");
    git(&f.seed, &["push", "origin", "main"]);
    let original = git(&f.work, &["rev-parse", "HEAD"]);
    let first = review::import_return(&g, &f.work, &bundle, "main", &[]).unwrap();
    assert!(first.outcomes[0].conflict);
    let wt = PathBuf::from(first.outcomes[0].worktree.as_ref().unwrap());
    let retry = review::import_return(&g, &f.work, &bundle, "main", &[]).unwrap();
    assert_eq!(first.branches[0].local, retry.branches[0].local);
    assert_eq!(first.outcomes[0].worktree, retry.outcomes[0].worktree);
    assert!(retry.outcomes[0].conflict);
    sync::abort(&g, &wt).unwrap();
    assert!(
        repo::list_refs(&g, &f.work, &["refs/offline-sync/review-ready"])
            .unwrap()
            .is_empty()
    );
    let resumed = review::import_return(&g, &f.work, &bundle, "main", &[]).unwrap();
    assert!(resumed.outcomes[0].conflict);
    fs::write(wt.join("base"), "resolved\n").unwrap();
    git(&wt, &["add", "base"]);
    assert!(sync::continue_op(&g, &wt).unwrap().ok);
    let finished = review::import_return(&g, &f.work, &bundle, "main", &[]).unwrap();
    assert!(finished.outcomes[0].ok, "{:?}", finished.outcomes);
    assert_eq!(git(&f.work, &["rev-parse", "HEAD"]), original);
    assert_eq!(
        repo::list_refs(&g, &f.work, &["refs/heads/review"])
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn review_ready_survives_continue_recovery_and_marker_failure() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    for mode in [
        "continue",
        "crash-after-git",
        "marker-write-failure",
        "initial-write-failure",
    ] {
        let f = Fixture::new(&g);
        let bundle = f.back(&g);
        if mode != "initial-write-failure" {
            commit(&f.seed, "feature", "internal conflicting change\n");
            git(&f.seed, &["push", "origin", "main"]);
        }
        let work = f.work.clone();
        let logger = move |event: LogEvent| {
            if mode == "initial-write-failure"
                && event.kind == LogKind::Cmd
                && event.text.contains(" rebase ")
            {
                let local = git(
                    &work,
                    &[
                        "for-each-ref",
                        "--format=%(refname:short)",
                        "refs/heads/review",
                    ],
                );
                let lock = work
                    .join(".git/refs/offline-sync/review-ready")
                    .join(format!("{}.lock", local.strip_prefix("review/").unwrap()));
                fs::create_dir_all(lock.parent().unwrap()).unwrap();
                fs::write(lock, "fault injection").unwrap();
            }
        };
        let importing = Git::new(None, &logger);
        let first = review::import_return(&importing, &f.work, &bundle, "main", &[]).unwrap();
        let local = &first.branches[0].local;
        let wt = Path::new(first.outcomes[0].worktree.as_ref().unwrap());
        let ready = format!(
            "refs/offline-sync/review-ready/{}",
            local.strip_prefix("review/").unwrap()
        );
        let journal = repo::git_dir(&g, wt)
            .unwrap()
            .join("offline-sync-rebase.json");
        let marker_lock = f.work.join(".git").join(format!("{ready}.lock"));
        if mode == "initial-write-failure" {
            assert!(!first.outcomes[0].ok);
            assert!(
                journal.exists(),
                "completed Git operation must remain retryable"
            );
        } else {
            assert!(first.outcomes[0].conflict, "{mode}");
            assert!(repo::list_refs(&g, &f.work, &[&ready]).unwrap().is_empty());
            fs::write(wt.join("feature"), "resolved\n").unwrap();
            git(wt, &["add", "feature"]);
            match mode {
                "crash-after-git" => {
                    git(wt, &["-c", "core.editor=true", "rebase", "--continue"]);
                }
                "marker-write-failure" => {
                    fs::create_dir_all(marker_lock.parent().unwrap()).unwrap();
                    fs::write(&marker_lock, "fault injection").unwrap();
                    assert!(sync::continue_op(&g, wt).is_err());
                    assert!(journal.exists());
                }
                _ => {
                    assert!(sync::continue_op(&g, wt).unwrap().ok);
                    assert_eq!(
                        git(&f.work, &["rev-parse", &ready]),
                        git(wt, &["rev-parse", "HEAD"])
                    );
                }
            }
        }
        let completed = git(wt, &["rev-parse", "HEAD"]);
        assert!(repo::in_progress(&repo::git_dir(&g, wt).unwrap()).is_none());
        // Replaying the resolved patch on this update would conflict again.
        commit(&f.seed, "feature", "upstream changed again\n");
        git(&f.seed, &["push", "origin", "main"]);
        if mode == "marker-write-failure" {
            let failed_retry = review::import_return(&g, &f.work, &bundle, "main", &[]).unwrap();
            assert!(!failed_retry.outcomes[0].ok);
            assert_eq!(git(wt, &["rev-parse", "HEAD"]), completed);
            assert!(journal.exists());
            fs::remove_file(marker_lock).unwrap();
        } else if mode == "initial-write-failure" {
            fs::remove_file(marker_lock).unwrap();
        }
        let restarted = Git::new(None, &log);
        let retried = review::import_return(&restarted, &f.work, &bundle, "main", &[]).unwrap();
        assert!(retried.outcomes[0].ok, "{mode}: {:?}", retried.outcomes);
        assert_eq!(git(wt, &["rev-parse", "HEAD"]), completed, "{mode}");
        assert_eq!(git(&f.work, &["rev-parse", &ready]), completed, "{mode}");
        assert!(!journal.exists(), "{mode}");
    }
}

#[test]
fn receipt_transaction_failure_creates_neither_review_nor_inbox_refs() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let f = Fixture::new(&g);
    let bundle = f.back(&g);
    let blocked = f.work.join(".git/refs/offline-sync/return-receipts");
    fs::create_dir_all(blocked.parent().unwrap()).unwrap();
    fs::write(&blocked, "blocked namespace").unwrap();
    assert!(review::import_return(&g, &f.work, &bundle, "main", &[]).is_err());
    assert!(repo::list_refs(&g, &f.work, &["refs/heads/review"])
        .unwrap()
        .is_empty());
    assert!(repo::list_refs(&g, &f.work, &["refs/offline-sync/inbox"])
        .unwrap()
        .is_empty());
    fs::remove_file(blocked).unwrap();
    let recovered = review::import_return(&g, &f.work, &bundle, "main", &[]).unwrap();
    assert!(recovered.outcomes[0].ok);
}

#[test]
fn push_reports_unknown_when_server_accepted_but_verification_is_unavailable() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let quiet = |_: LogEvent| {};
    let setup = Git::new(None, &quiet);
    let f = Fixture::new(&setup);
    sync::create_branch(&setup, &f.work, "feature/unknown", "main", None).unwrap();
    commit(&f.work, "unknown", "unknown\n");
    let plan = review::prepare_push(&setup, &f.work, "feature/unknown", false).unwrap();
    let remote = f.remote.clone();
    let moved = f.root.path().join("disconnected.git");
    let disconnected = moved.clone();
    let logger = move |event: LogEvent| {
        if event.text.starts_with("To ") {
            fs::rename(&remote, &disconnected).unwrap();
        }
    };
    let g = Git::new(None, &logger);
    let result = review::execute_push(&g, &plan.plan_id).unwrap();
    assert!(!result.ok);
    assert!(result.message.contains("推送结果未知"));
    assert_eq!(
        git(&moved, &["rev-parse", "feature/unknown"]),
        plan.source_oid
    );
}
