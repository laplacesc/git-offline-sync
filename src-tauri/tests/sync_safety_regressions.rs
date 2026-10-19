//! Regression tests for patch snapshots, branch deletion CAS and bundle object formats.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use git_offline_sync_lib::core::git::{Git, LogEvent, LogKind};
use git_offline_sync_lib::core::manifest::Manifest;
use git_offline_sync_lib::core::{repo, sync};

static ENV: Mutex<()> = Mutex::new(());

struct Fixture {
    root: tempfile::TempDir,
    _env: MutexGuard<'static, ()>,
}

impl Fixture {
    fn new() -> Self {
        let guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("gitconfig");
        fs::write(
            &config,
            "[init]\n defaultBranch = main\n[user]\n name = Tester\n email = tester@example.com\n[commit]\n gpgSign = false\n",
        )
        .unwrap();
        std::env::set_var("GIT_CONFIG_GLOBAL", config);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        std::env::remove_var("GIT_DEFAULT_HASH");
        Self { root, _env: guard }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    fn seed(&self, format: &str) -> PathBuf {
        let seed = self.path("seed");
        let log = |_: LogEvent| {};
        let (major, minor, _) = Git::new(None, &log).version().unwrap();
        let mut args = vec!["init", "-q"];
        let format_arg = format!("--object-format={format}");
        if (major, minor) >= (2, 29) {
            args.push(&format_arg);
        } else {
            assert_eq!(format, "sha1");
        }
        args.push(seed.to_str().unwrap());
        git(self.root.path(), &args);
        commit(&seed, "base", "base\n");
        let sha = git(&seed, &["rev-parse", "HEAD"]);
        git(&seed, &["update-ref", "refs/remotes/origin/main", &sha]);
        seed
    }

    fn supports_sha256(&self) -> bool {
        let out = Command::new("git")
            .args(["init", "--bare", "--object-format=sha256"])
            .arg(self.path("sha256-probe"))
            .output()
            .unwrap();
        if !out.status.success() {
            eprintln!(
                "Git does not support SHA-256; skipping: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        out.status.success()
    }
}

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

fn commit(dir: &Path, name: &str, content: &str) {
    fs::write(dir.join(name), content).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "-qm", name]);
}

fn exported(out: sync::ExportOutcome) -> PathBuf {
    match out {
        sync::ExportOutcome::Exported { payload, .. } => payload.into(),
        other => panic!("{other:?}"),
    }
}

fn patches(
    f: &Fixture,
    g: &Git,
    seed: &Path,
) -> git_offline_sync_lib::core::error::Result<sync::ExportOutcome> {
    sync::export_patches(
        g,
        seed,
        &f.path("mirror"),
        "topic",
        &f.path("usb"),
        "test",
        "main",
        &[],
    )
}

#[test]
fn merge_only_patch_is_rejected_without_publishing_or_advancing_sequence() {
    let f = Fixture::new();
    let seed = f.seed("sha1");
    let first = git(&seed, &["rev-parse", "HEAD"]);
    commit(&seed, "second", "second\n");
    let base = git(&seed, &["rev-parse", "HEAD"]);
    git(&seed, &["update-ref", "refs/remotes/origin/main", &base]);
    commit(&seed, "merge-only", "must survive export\n");
    let tree = git(&seed, &["rev-parse", "HEAD^{tree}"]);
    let merge = git(
        &seed,
        &[
            "commit-tree",
            &tree,
            "-p",
            &base,
            "-p",
            &first,
            "-m",
            "merge resolution",
        ],
    );
    git(&seed, &["branch", "topic", &merge]);
    assert_eq!(
        git(&seed, &["rev-list", "--count", "origin/main..topic"]),
        "1"
    );
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let state = repo::MirrorState {
        back_seq: 7,
        ..Default::default()
    };
    repo::save_state(&f.path("mirror"), &state).unwrap();
    let state_path = f.path("mirror/offline-sync/state.json");
    let before = fs::read(&state_path).unwrap();
    let error = patches(&f, &g, &seed).unwrap_err().to_string();
    assert!(
        error.contains("合并提交") && error.contains("Bundle"),
        "{error}"
    );
    assert_eq!(fs::read(&state_path).unwrap(), before);
    assert_eq!(fs::read_dir(f.path("usb")).unwrap().count(), 0);
    assert!(!f.path("mirror/offline-sync/export-pending.json").exists());
}

#[test]
fn patch_range_and_manifest_keep_the_checked_tip_when_both_refs_move() {
    let f = Fixture::new();
    let seed = f.seed("sha1");
    let base = git(&seed, &["rev-parse", "HEAD"]);
    git(&seed, &["checkout", "-qb", "topic"]);
    commit(&seed, "topic-file", "checked snapshot\n");
    let tip = git(&seed, &["rev-parse", "HEAD"]);
    let tree = git(&seed, &["rev-parse", "HEAD^{tree}"]);
    let newer = git(
        &seed,
        &[
            "commit-tree",
            &tree,
            "-p",
            &tip,
            "-p",
            &base,
            "-m",
            "concurrent merge",
        ],
    );
    let changed = Arc::new(AtomicBool::new(false));
    let did_change = changed.clone();
    let path = seed.clone();
    let moved_base = tip.clone();
    let log = move |event: LogEvent| {
        if event.kind == LogKind::Cmd
            && event.text.starts_with("git format-patch ")
            && !did_change.swap(true, Ordering::SeqCst)
        {
            git(&path, &["update-ref", "refs/heads/topic", &newer]);
            git(
                &path,
                &["update-ref", "refs/remotes/origin/main", &moved_base],
            );
        }
    };
    let g = Git::new(None, &log);
    let payload = exported(patches(&f, &g, &seed).unwrap());
    assert!(changed.load(Ordering::SeqCst));
    let manifest = Manifest::read_for(&payload).unwrap().unwrap();
    assert_eq!(manifest.refs[0].sha, tip);
    let files: Vec<_> = fs::read_dir(&payload)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    let patch = fs::read_to_string(&files[0]).unwrap();
    assert!(patch.starts_with(&format!("From {tip} ")));
    assert!(patch.contains("+checked snapshot"));
    assert_eq!(
        repo::load_state::<repo::MirrorState>(&f.path("mirror"))
            .unwrap()
            .back_seq,
        1
    );
}

#[test]
fn branch_deletion_cas_keeps_concurrent_update_for_normal_and_forced_deletes() {
    let f = Fixture::new();
    let seed = f.seed("sha1");
    let old = git(&seed, &["rev-parse", "HEAD"]);
    commit(&seed, "new", "new commit\n");
    let new = git(&seed, &["rev-parse", "HEAD"]);
    for force in [false, true] {
        git(&seed, &["branch", "-f", "topic", &old]);
        git(&seed, &["config", "branch.topic.syncBase", "main"]);
        let changed = Arc::new(AtomicBool::new(false));
        let did_change = changed.clone();
        let path = seed.clone();
        let new_tip = new.clone();
        let log = move |event: LogEvent| {
            if event.kind == LogKind::Cmd
                && event.text.starts_with("git update-ref ")
                && !did_change.swap(true, Ordering::SeqCst)
            {
                git(&path, &["update-ref", "refs/heads/topic", &new_tip]);
            }
        };
        let g = Git::new(None, &log);
        assert!(
            sync::delete_local_branch(&g, &seed, "topic", force.then_some(old.as_str())).is_err()
        );
        assert!(changed.load(Ordering::SeqCst));
        assert_eq!(git(&seed, &["rev-parse", "topic"]), new);
        assert_eq!(git(&seed, &["config", "branch.topic.syncBase"]), "main");
    }
}

#[test]
fn branch_deletion_preserves_guards_and_removes_branch_config_after_success() {
    let f = Fixture::new();
    let seed = f.seed("sha1");
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    assert!(sync::delete_local_branch(&g, &seed, "main", None).is_err());
    git(&seed, &["checkout", "-qb", "topic"]);
    commit(&seed, "unmerged", "needs confirmation\n");
    let sha = git(&seed, &["rev-parse", "HEAD"]);
    git(&seed, &["checkout", "main"]);
    git(&seed, &["config", "branch.topic.syncBase", "main"]);
    assert!(
        matches!(sync::delete_local_branch(&g, &seed, "topic", None).unwrap(), sync::DeleteBranchOutcome::NeedsForce { sha: actual } if actual == sha)
    );
    assert!(sync::delete_local_branch(&g, &seed, "topic", Some(&"0".repeat(40))).is_err());
    let wt = f.path("linked");
    git(&seed, &["worktree", "add", wt.to_str().unwrap(), "topic"]);
    assert!(sync::delete_local_branch(&g, &seed, "topic", Some(&sha)).is_err());
    git(&seed, &["worktree", "remove", wt.to_str().unwrap()]);
    assert!(matches!(
        sync::delete_local_branch(&g, &seed, "topic", Some(&sha)).unwrap(),
        sync::DeleteBranchOutcome::Deleted { .. }
    ));
    assert!(!repo::rev_exists(&g, &seed, "refs/heads/topic"));
    assert!(!git(&seed, &["config", "--local", "--list"]).contains("branch.topic."));
    git(&seed, &["branch", "merged"]);
    assert!(matches!(
        sync::delete_local_branch(&g, &seed, "merged", None).unwrap(),
        sync::DeleteBranchOutcome::Deleted { .. }
    ));
    git(&seed, &["config", "remote.origin.mirror", "true"]);
    git(&seed, &["branch", "protected"]);
    assert!(sync::delete_local_branch(&g, &seed, "protected", None).is_err());
    assert!(repo::rev_exists(&g, &seed, "protected"));
}

#[test]
fn branch_deletion_preserves_a_branch_while_rebase_detaches_its_worktree() {
    let f = Fixture::new();
    let seed = f.seed("sha1");
    git(&seed, &["switch", "-c", "topic"]);
    commit(&seed, "base", "topic change\n");
    let tip = git(&seed, &["rev-parse", "topic"]);
    git(&seed, &["switch", "main"]);
    commit(&seed, "base", "main change\n");
    let wt = f.path("rebasing");
    git(&seed, &["worktree", "add", wt.to_str().unwrap(), "topic"]);
    let rebase = Command::new("git")
        .current_dir(&wt)
        .args(["rebase", "main"])
        .output()
        .unwrap();
    assert!(!rebase.status.success());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    assert!(repo::list_worktrees(&g, &seed)
        .unwrap()
        .iter()
        .all(|t| t.branch.as_deref() != Some("topic")));
    for forced in [false, true] {
        assert!(
            sync::delete_local_branch(&g, &seed, "topic", forced.then_some(tip.as_str())).is_err()
        );
        assert_eq!(git(&seed, &["rev-parse", "topic"]), tip);
        assert!(repo::in_progress(&repo::git_dir(&g, &wt).unwrap()).is_some());
    }
}

#[test]
fn deletion_rechecks_concurrent_checkout_under_head_locks() {
    for format in ["files", "reftable"] {
        for linked in [false, true] {
            for forced in [false, true] {
                let f = Fixture::new();
                let seed = f.seed("sha1");
                if format == "reftable" {
                    let migrated = Command::new("git")
                        .current_dir(&seed)
                        .args(["refs", "migrate", "--ref-format=reftable"])
                        .output()
                        .unwrap();
                    if !migrated.status.success() {
                        eprintln!(
                            "reftable unavailable: {}",
                            String::from_utf8_lossy(&migrated.stderr)
                        );
                        continue;
                    }
                }
                git(&seed, &["branch", "topic"]);
                git(&seed, &["config", "branch.topic.syncBase", "main"]);
                let sha = git(&seed, &["rev-parse", "topic"]);
                let target = if linked {
                    let path = f.path("linked");
                    git(
                        &seed,
                        &["worktree", "add", "--detach", path.to_str().unwrap()],
                    );
                    path
                } else {
                    seed.clone()
                };
                let moved = Arc::new(AtomicBool::new(false));
                let did_move = moved.clone();
                let target_in_log = target.clone();
                let log = move |e: LogEvent| {
                    if e.kind == LogKind::Cmd
                        && e.text.starts_with("git update-ref ")
                        && !did_move.swap(true, Ordering::SeqCst)
                    {
                        git(&target_in_log, &["switch", "topic"]);
                    }
                };
                let g = Git::new(None, &log);
                assert!(sync::delete_local_branch(
                    &g,
                    &seed,
                    "topic",
                    forced.then_some(sha.as_str())
                )
                .is_err());
                assert!(moved.load(Ordering::SeqCst));
                assert_eq!(git(&target, &["symbolic-ref", "HEAD"]), "refs/heads/topic");
                assert_eq!(git(&seed, &["rev-parse", "topic"]), sha);
                assert_eq!(git(&seed, &["config", "branch.topic.syncBase"]), "main");
                // Abort must release both HEAD and branch locks.
                git(&target, &["switch", "--detach"]);
                let silent = |_: LogEvent| {};
                sync::delete_local_branch(&Git::new(None, &silent), &seed, "topic", Some(&sha))
                    .unwrap();
            }
        }
    }
}

#[test]
fn prepared_deletion_blocks_checkout_until_commit() {
    for format in ["files", "reftable"] {
        for linked in [false, true] {
            let f = Fixture::new();
            let seed = f.seed("sha1");
            if format == "reftable" {
                let migrated = Command::new("git")
                    .current_dir(&seed)
                    .args(["refs", "migrate", "--ref-format=reftable"])
                    .output()
                    .unwrap();
                if !migrated.status.success() {
                    continue;
                }
            }
            git(&seed, &["branch", "topic"]);
            let sha = git(&seed, &["rev-parse", "topic"]);
            let target = if linked {
                let path = f.path("linked");
                git(
                    &seed,
                    &["worktree", "add", "--detach", path.to_str().unwrap()],
                );
                path
            } else {
                seed.clone()
            };
            let attempted = Arc::new(AtomicBool::new(false));
            let did_attempt = attempted.clone();
            let target_in_log = target.clone();
            let log = move |e: LogEvent| {
                if e.kind == LogKind::Stdout && e.text == "prepare: ok" {
                    did_attempt.store(true, Ordering::SeqCst);
                    let switched = Command::new("git")
                        .current_dir(&target_in_log)
                        .args(["switch", "topic"])
                        .output()
                        .unwrap();
                    assert!(!switched.status.success());
                }
            };
            let g = Git::new(None, &log);
            assert!(matches!(
                sync::delete_local_branch(&g, &seed, "topic", None).unwrap(),
                sync::DeleteBranchOutcome::Deleted { .. }
            ));
            assert!(attempted.load(Ordering::SeqCst));
            assert!(!repo::rev_exists(&g, &seed, "refs/heads/topic"));
            assert_eq!(git(&target, &["rev-parse", "HEAD"]), sha);
            git(&target, &["switch", "-c", "after-deletion"]);
        }
    }
}

#[test]
fn branch_deletion_preserves_bisect_start_in_main_and_linked_worktrees() {
    for linked in [false, true] {
        let f = Fixture::new();
        let seed = f.seed("sha1");
        for n in 0..3 {
            commit(&seed, "base", &format!("version {n}\n"));
        }
        git(&seed, &["branch", "topic"]);
        git(&seed, &["branch", "--set-upstream-to", "main", "topic"]);
        let sha = git(&seed, &["rev-parse", "topic"]);
        let target = if linked {
            let path = f.path("linked");
            git(&seed, &["worktree", "add", path.to_str().unwrap(), "topic"]);
            path
        } else {
            git(&seed, &["switch", "topic"]);
            seed.clone()
        };
        git(&target, &["bisect", "start", "HEAD", "HEAD~3"]);
        let log = |_: LogEvent| {};
        let g = Git::new(None, &log);
        let head = git(&target, &["rev-parse", "HEAD"]);
        for forced in [false, true] {
            assert!(
                sync::delete_local_branch(&g, &seed, "topic", forced.then_some(sha.as_str()))
                    .is_err()
            );
            assert_eq!(git(&seed, &["rev-parse", "topic"]), sha);
            assert_eq!(git(&target, &["rev-parse", "HEAD"]), head);
        }
        git(&target, &["bisect", "reset"]);
        assert_eq!(git(&target, &["branch", "--show-current"]), "topic");
    }
}

#[test]
fn cancelling_prepared_deletion_aborts_and_releases_locks() {
    use git_offline_sync_lib::core::git::OperationRegistry;
    let f = Fixture::new();
    let seed = f.seed("sha1");
    git(&seed, &["branch", "topic"]);
    let registry = OperationRegistry::default();
    let guard = registry.start().unwrap();
    let control = guard.control.clone();
    let log = move |e: LogEvent| {
        if e.kind == LogKind::Stdout && e.text == "prepare: ok" {
            control.cancel();
            // Keep the reader here long enough for the cancellation monitor to run.
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    };
    let g = Git::new(None, &log).with_control(guard.control.clone());
    assert!(sync::delete_local_branch(&g, &seed, "topic", None).is_err());
    git(&seed, &["switch", "topic"]);
}

#[test]
fn sha256_bundle_round_trip_with_manifest_and_manual_bundle() {
    let f = Fixture::new();
    if !f.supports_sha256() {
        return;
    }
    let seed = f.seed("sha256");
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let mirror = f.path("internal.git");
    sync::init_mirror(&g, seed.to_str().unwrap(), &mirror).unwrap();
    let full = exported(
        sync::export_out(&g, &mirror, &f.path("usb"), "test", "main", true, false).unwrap(),
    );
    let external = f.path("external.git");
    sync::import_in(&g, &full, &external, false).unwrap();
    let initial = git(&seed, &["rev-parse", "main"]);
    assert_eq!(git(&external, &["rev-parse", "main"]), initial);
    assert_eq!(initial.len(), 64);
    let dev = f.path("dev");
    sync::create_dev_repo(&g, &external, &dev, "Tester", "tester@example.com").unwrap();
    sync::create_branch(&g, &dev, "topic", "main", None).unwrap();
    commit(&dev, "returned", "SHA-256 round trip\n");
    let tip = git(&dev, &["rev-parse", "HEAD"]);
    let back = exported(
        sync::export_back(
            &g,
            &dev,
            &external,
            &["topic".into()],
            &f.path("usb"),
            "test",
            "main",
            &[],
        )
        .unwrap(),
    );
    sync::import_back(&g, &seed, &back, "main", &[]).unwrap();
    assert_eq!(git(&seed, &["rev-parse", "topic"]), tip);
    assert_eq!(
        git(&seed, &["show", "topic:returned"]),
        "SHA-256 round trip"
    );
    let manual = f.path("manual.bundle");
    git(
        &seed,
        &["bundle", "create", manual.to_str().unwrap(), "--all"],
    );
    let manual_mirror = f.path("manual.git");
    sync::import_in(&g, &manual, &manual_mirror, false).unwrap();
    assert_eq!(git(&manual_mirror, &["rev-parse", "topic"]), tip);
    assert_eq!(
        git(&manual_mirror, &["config", "extensions.objectFormat"]),
        "sha256"
    );
}

#[test]
fn sha1_bundle_overrides_sha256_local_default() {
    let f = Fixture::new();
    if !f.supports_sha256() {
        return;
    }
    let seed = f.seed("sha1");
    let manual = f.path("manual.bundle");
    git(
        &seed,
        &["bundle", "create", manual.to_str().unwrap(), "--all"],
    );
    std::env::set_var("GIT_DEFAULT_HASH", "sha256");
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let external = f.path("external.git");
    let result = sync::import_in(&g, &manual, &external, false);
    std::env::remove_var("GIT_DEFAULT_HASH");
    result.unwrap();
    assert_eq!(
        git(&external, &["rev-parse", "main"]),
        git(&seed, &["rev-parse", "main"])
    );
    assert_eq!(
        git(&external, &["rev-parse", "--show-object-format"]),
        "sha1"
    );
}

#[cfg(unix)]
#[test]
fn git_225_sha1_import_avoids_new_format_options_and_sha256_fails_before_init() {
    use std::os::unix::fs::PermissionsExt;

    let f = Fixture::new();
    let seed = f.seed("sha1");
    let manual = f.path("legacy.bundle");
    git(
        &seed,
        &["bundle", "create", manual.to_str().unwrap(), "--all"],
    );
    let wrapper = f.path("git-225");
    fs::write(
        &wrapper,
        "#!/bin/sh\nfor arg in \"$@\"; do\n case \"$arg\" in\n  --version) printf 'git version 2.25.0\\n'; exit 0 ;;\n  --object-format=*|--show-object-format) exit 99 ;;\n esac\ndone\nexec git \"$@\"\n",
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let log = |_: LogEvent| {};
    let g = Git::new(Some(wrapper.to_str().unwrap()), &log);
    assert!(sync::check_git(&g)
        .unwrap_err()
        .to_string()
        .contains("2.36"));
    // Direct legacy SHA-1 import remains readable, but application operations
    // require 2.36 for lossless worktree path enumeration.
    let external = f.path("legacy.git");
    sync::import_in(&g, &manual, &external, false).unwrap();
    assert_eq!(
        git(&external, &["rev-parse", "main"]),
        git(&seed, &["rev-parse", "main"])
    );

    // The capability alone suffices to reject unsupported Git before creating a mirror.
    let sha256 = f.path("sha256.bundle");
    fs::write(&sha256, "# v3 git bundle\n@object-format=sha256\n\n").unwrap();
    let unsupported = f.path("unsupported.git");
    let error = sync::import_in(&g, &sha256, &unsupported, false)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("升级 Git") && error.contains("SHA-256"),
        "{error}"
    );
    assert!(!unsupported.exists());
}

#[test]
fn mismatched_empty_mirror_keeps_unreferenced_objects_and_state() {
    let f = Fixture::new();
    if !f.supports_sha256() {
        return;
    }
    let seed = f.seed("sha256");
    let manual = f.path("manual.bundle");
    git(
        &seed,
        &["bundle", "create", manual.to_str().unwrap(), "--all"],
    );
    let external = f.path("external.git");
    git(
        f.root.path(),
        &[
            "init",
            "--bare",
            "--object-format=sha1",
            external.to_str().unwrap(),
        ],
    );
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    repo::mark_ext_mirror(&g, &external).unwrap();
    let loose = f.path("keep.txt");
    fs::write(&loose, "unreferenced data").unwrap();
    let oid = git(&external, &["hash-object", "-w", loose.to_str().unwrap()]);
    repo::save_state(
        &external,
        &repo::MirrorState {
            back_seq: 9,
            ..Default::default()
        },
    )
    .unwrap();
    let config = fs::read(external.join("config")).unwrap();
    let state = fs::read(external.join("offline-sync/state.json")).unwrap();
    let error = sync::import_in(&g, &manual, &external, false)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("对象格式") && error.contains("新的空目录"),
        "{error}"
    );
    assert_eq!(
        git(&external, &["cat-file", "blob", &oid]),
        "unreferenced data"
    );
    assert_eq!(fs::read(external.join("config")).unwrap(), config);
    assert_eq!(
        fs::read(external.join("offline-sync/state.json")).unwrap(),
        state
    );
    let recovered = f.path("recovered.git");
    sync::import_in(&g, &manual, &recovered, false).unwrap();
    assert_eq!(
        git(&recovered, &["rev-parse", "main"]),
        git(&seed, &["rev-parse", "main"])
    );
}
