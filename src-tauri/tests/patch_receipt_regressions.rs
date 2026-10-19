//! Patch receipt persistence, conflict completion and interrupted finalization.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use git_offline_sync_lib::core::git::{Git, LogEvent, LogKind};
use git_offline_sync_lib::core::manifest::{BundleKind, Manifest, RefEntry, FORMAT};
use git_offline_sync_lib::core::{repo, review, sync};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=Patch Tester",
            "-c",
            "user.email=patch@example.invalid",
        ])
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

struct Fixture {
    root: tempfile::TempDir,
    work: PathBuf,
    usb: PathBuf,
    patches: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join("work");
        git(root.path(), &["init", "-b", "main", work.to_str().unwrap()]);
        git(&work, &["config", "user.name", "Patch Tester"]);
        git(&work, &["config", "user.email", "patch@example.invalid"]);
        git(&work, &["config", "commit.gpgSign", "false"]);
        // These fixtures assert exact bytes; do not inherit the host's checkout EOL policy.
        git(&work, &["config", "core.autocrlf", "false"]);
        git(&work, &["config", "core.eol", "lf"]);
        fs::write(work.join("file"), "base\n").unwrap();
        git(&work, &["add", "file"]);
        git(&work, &["commit", "-m", "base"]);
        let base = git(&work, &["rev-parse", "HEAD"]);
        git(&work, &["update-ref", "refs/remotes/origin/main", &base]);
        git(&work, &["switch", "-c", "source"]);
        fs::write(work.join("file"), "returned\n").unwrap();
        git(&work, &["commit", "-am", "returned"]);
        let tip = git(&work, &["rev-parse", "HEAD"]);
        let usb = root.path().join("usb");
        let patches = usb.join("patches");
        fs::create_dir_all(&patches).unwrap();
        git(
            &work,
            &[
                "format-patch",
                "--binary",
                "-o",
                patches.to_str().unwrap(),
                "main..source",
            ],
        );
        Manifest {
            format: FORMAT,
            kind: BundleKind::Patch,
            repo_name: "test".into(),
            repo_id: base,
            seq: 1,
            created_at: 1,
            payload: "patches".into(),
            base_branch: "main".into(),
            refs: vec![RefEntry {
                name: "refs/heads/source".into(),
                sha: tip,
                base: Some("main".into()),
            }],
            tool_version: "test".into(),
        }
        .write_for(&patches)
        .unwrap();
        git(&work, &["switch", "main"]);
        Self {
            root,
            work,
            usb,
            patches,
        }
    }

    fn received(&self, g: &Git) -> bool {
        review::list_return_packages(g, &self.work, &self.usb)
            .unwrap()
            .into_iter()
            .find(|p| Path::new(&p.package.payload_path) == self.patches)
            .unwrap()
            .received
    }

    fn conflict(&self) {
        fs::write(self.work.join("file"), "upstream\n").unwrap();
        git(&self.work, &["commit", "-am", "upstream"]);
        git(
            &self.work,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
    }
}

#[test]
fn successful_patch_receipt_survives_reload_copy_and_duplicate_import() {
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    for linked in [false, true] {
        let f = Fixture::new();
        let wt = f.root.path().join("received");
        assert!(!f.received(&g));
        let result = sync::import_patches(
            &g,
            &f.work,
            &f.patches,
            "received",
            "main",
            false,
            linked.then_some(wt.as_path()),
        )
        .unwrap();
        assert!(result.ok);
        assert_eq!(
            repo::list_worktrees(&g, &f.work).unwrap().len(),
            if linked { 2 } else { 1 }
        );
        assert!(f.received(&Git::new(None, &log)));
        let target = if linked { &wt } else { &f.work };
        assert_eq!(
            fs::read_to_string(target.join("file")).unwrap(),
            "returned\n"
        );
        let tip = git(target, &["rev-parse", "HEAD"]);
        let refs = repo::list_refs(&g, &f.work, &["refs"]).unwrap();

        let copy = f.usb.join("renamed");
        fs::create_dir(&copy).unwrap();
        for entry in fs::read_dir(&f.patches).unwrap() {
            let entry = entry.unwrap();
            fs::copy(entry.path(), copy.join(entry.file_name())).unwrap();
        }
        let mut manifest = Manifest::read_for(&f.patches).unwrap().unwrap();
        manifest.payload = "renamed".into();
        manifest.write_for(&copy).unwrap();
        assert!(review::list_return_packages(&g, &f.work, &f.usb)
            .unwrap()
            .iter()
            .all(|p| p.received));
        let unused = f.root.path().join("must-not-create");
        let repeat = sync::import_patches(
            &g,
            &f.work,
            &copy,
            "different-branch",
            "main",
            false,
            Some(&unused),
        )
        .unwrap();
        assert!(repeat.ok);
        assert!(!unused.exists());
        assert_eq!(repo::list_refs(&g, &f.work, &["refs"]).unwrap(), refs);
        assert_eq!(git(target, &["rev-parse", "HEAD"]), tip);
    }
}

#[test]
fn patch_conflict_is_received_only_after_continue_and_abort_stays_pending() {
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let f = Fixture::new();
    f.conflict();
    let aborted = f.root.path().join("aborted");
    let first = sync::import_patches(
        &g,
        &f.work,
        &f.patches,
        "aborted",
        "main",
        false,
        Some(&aborted),
    )
    .unwrap();
    assert!(!first.ok);
    assert!(!f.received(&g));
    assert!(sync::abort(&g, &aborted).unwrap().ok);
    assert!(!f.received(&g));
    assert!(!repo::git_dir(&g, &aborted)
        .unwrap()
        .join("offline-sync-patch.json")
        .exists());

    let resolved = f.root.path().join("resolved");
    let second = sync::import_patches(
        &g,
        &f.work,
        &f.patches,
        "resolved",
        "main",
        false,
        Some(&resolved),
    )
    .unwrap();
    assert!(!second.ok);
    let unused = f.root.path().join("unused");
    let duplicate = sync::import_patches(
        &g,
        &f.work,
        &f.patches,
        "unused",
        "main",
        false,
        Some(&unused),
    )
    .unwrap();
    assert!(!duplicate.ok);
    assert_eq!(
        Path::new(duplicate.worktree.as_deref().unwrap())
            .canonicalize()
            .unwrap(),
        resolved.canonicalize().unwrap()
    );
    assert!(!unused.exists());
    fs::write(resolved.join("file"), "resolved\n").unwrap();
    git(&resolved, &["add", "file"]);
    assert!(sync::continue_op(&g, &resolved).unwrap().ok);
    assert!(f.received(&g));
    assert_eq!(git(&f.work, &["branch", "--show-current"]), "main");
}

#[test]
fn patch_import_in_existing_worktree_protects_changes_and_can_continue_conflicts() {
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let f = Fixture::new();
    let initial = git(&f.work, &["rev-parse", "HEAD"]);
    for tracked in [false, true] {
        let dirty = f.work.join(if tracked { "file" } else { "new-file" });
        fs::write(&dirty, "local edits\n").unwrap();
        assert!(
            sync::import_patches(&g, &f.work, &f.patches, "received", "main", false, None).is_err()
        );
        assert_eq!(fs::read_to_string(&dirty).unwrap(), "local edits\n");
        assert_eq!(git(&f.work, &["rev-parse", "HEAD"]), initial);
        assert!(!repo::rev_exists(&g, &f.work, "refs/heads/received"));
        assert!(!f.received(&g));
        if tracked {
            git(&f.work, &["restore", "file"]);
        } else {
            fs::remove_file(dirty).unwrap();
        }
    }
    f.conflict();
    let main = git(&f.work, &["rev-parse", "main"]);
    let result =
        sync::import_patches(&g, &f.work, &f.patches, "received", "main", false, None).unwrap();
    assert!(!result.ok);
    assert_eq!(repo::list_worktrees(&g, &f.work).unwrap().len(), 1);
    assert_eq!(git(&f.work, &["branch", "--show-current"]), "received");
    fs::write(f.work.join("file"), "resolved\n").unwrap();
    git(&f.work, &["add", "file"]);
    assert!(sync::continue_op(&g, &f.work).unwrap().ok);
    assert!(f.received(&g));
    assert_eq!(git(&f.work, &["rev-parse", "main"]), main);
}

#[test]
fn external_am_completion_is_recovered_but_aborted_unrelated_commits_are_not_received() {
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    for complete in [false, true] {
        let f = Fixture::new();
        f.conflict();
        assert!(
            !sync::import_patches(&g, &f.work, &f.patches, "received", "main", false, None)
                .unwrap()
                .ok
        );
        if complete {
            fs::write(f.work.join("file"), "resolved\n").unwrap();
            git(&f.work, &["add", "file"]);
            git(&f.work, &["am", "--continue"]);
            assert!(sync::continue_op(&g, &f.work).unwrap().ok);
            assert!(f.received(&g));
        } else {
            git(&f.work, &["am", "--abort"]);
            fs::write(f.work.join("unrelated"), "unrelated\n").unwrap();
            git(&f.work, &["add", "unrelated"]);
            git(&f.work, &["commit", "-m", "unrelated work"]);
            assert!(sync::continue_op(&g, &f.work).is_err());
            assert!(!f.received(&g));
        }
    }
}

#[test]
fn external_partial_am_never_marks_the_entire_package_received() {
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    for mailbox in [false, true] {
        for action in ["quit", "skip", "complete"] {
            let f = Fixture::new();
            git(&f.work, &["switch", "source"]);
            git(&f.work, &["reset", "--hard", "main"]);
            fs::write(f.work.join("first"), "first patch\n").unwrap();
            git(&f.work, &["add", "first"]);
            git(&f.work, &["commit", "-m", "first"]);
            fs::write(f.work.join("file"), "second patch\n").unwrap();
            git(&f.work, &["commit", "-am", "second"]);
            for entry in fs::read_dir(&f.patches).unwrap() {
                fs::remove_file(entry.unwrap().path()).unwrap();
            }
            if mailbox {
                let mail = git(&f.work, &["format-patch", "--stdout", "main..source"]);
                fs::write(f.patches.join("series.patch"), format!("{mail}\n")).unwrap();
            } else {
                git(
                    &f.work,
                    &[
                        "format-patch",
                        "-o",
                        f.patches.to_str().unwrap(),
                        "main..source",
                    ],
                );
            }
            let mut manifest = Manifest::read_for(&f.patches).unwrap().unwrap();
            manifest.refs[0].sha = git(&f.work, &["rev-parse", "source"]);
            manifest.write_for(&f.patches).unwrap();
            git(&f.work, &["switch", "main"]);
            f.conflict();
            assert!(
                !sync::import_patches(&g, &f.work, &f.patches, "received", "main", false, None)
                    .unwrap()
                    .ok
            );
            assert_eq!(
                git(&f.work, &["rev-list", "--count", "origin/main..HEAD"]),
                "1"
            );
            let gd = repo::git_dir(&g, &f.work).unwrap();
            if action == "complete" {
                fs::write(f.work.join("file"), "resolved\n").unwrap();
                git(&f.work, &["add", "file"]);
                git(&f.work, &["am", "--continue"]);
                assert!(sync::continue_op(&g, &f.work).unwrap().ok);
                assert!(f.received(&g));
                assert!(!gd.join("offline-sync-patch.json").exists());
            } else {
                git(
                    &f.work,
                    &["am", if action == "quit" { "--quit" } else { "--skip" }],
                );
                let head = git(&f.work, &["rev-parse", "HEAD"]);
                let index = fs::read(gd.join("index")).unwrap();
                assert!(sync::continue_op(&g, &f.work).is_err());
                assert!(sync::import_patches(
                    &g, &f.work, &f.patches, "retry", "main", false, None
                )
                .is_err());
                assert!(!f.received(&g));
                assert!(gd.join("offline-sync-patch.json").exists());
                assert_eq!(git(&f.work, &["rev-parse", "HEAD"]), head);
                assert_eq!(fs::read(gd.join("index")).unwrap(), index);
                assert!(!repo::rev_exists(&g, &f.work, "refs/heads/retry"));
            }
        }
    }
}

#[test]
fn legacy_patch_journal_cannot_infer_external_completion() {
    let f = Fixture::new();
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    f.conflict();
    assert!(
        !sync::import_patches(&g, &f.work, &f.patches, "received", "main", false, None)
            .unwrap()
            .ok
    );
    let journal = repo::git_dir(&g, &f.work)
        .unwrap()
        .join("offline-sync-patch.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("expected_commits");
    fs::write(&journal, serde_json::to_vec(&value).unwrap()).unwrap();
    fs::write(f.work.join("file"), "resolved\n").unwrap();
    git(&f.work, &["add", "file"]);
    git(&f.work, &["am", "--continue"]);
    assert!(sync::continue_op(&g, &f.work).is_err());
    assert!(!f.received(&g));
    assert!(journal.exists());
}

#[test]
fn invalid_patch_packages_do_not_hide_healthy_packages() {
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    for received in [false, true] {
        let f = Fixture::new();
        if received {
            assert!(
                sync::import_patches(&g, &f.work, &f.patches, "received", "main", false, None)
                    .unwrap()
                    .ok
            );
        }
        let mut manifest = Manifest::read_for(&f.patches).unwrap().unwrap();
        for name in ["empty", "invalid"] {
            let dir = f.usb.join(name);
            fs::create_dir(&dir).unwrap();
            if name == "invalid" {
                fs::create_dir(dir.join("not-a-file.patch")).unwrap();
            }
            manifest.seq += 1;
            manifest.payload = name.into();
            manifest.write_for(&dir).unwrap();
        }
        let packages = review::list_return_packages(&g, &f.work, &f.usb).unwrap();
        assert_eq!(packages.len(), 3);
        for package in packages {
            if Path::new(&package.package.payload_path) == f.patches {
                assert_eq!(package.received, received);
                assert!(package.error.is_none());
            } else {
                assert!(!package.received);
                assert!(package.error.is_some());
                assert!(package.receipt_key.is_none());
            }
        }
        assert!(sync::import_patches(
            &g,
            &f.work,
            &f.usb.join("empty"),
            "invalid",
            "main",
            false,
            None
        )
        .is_err());
    }
}

#[test]
fn failed_patch_receipt_write_can_finish_without_reapplying_commits() {
    for next_package in [false, true] {
        let f = Fixture::new();
        let blocked = f.work.join(".git/refs/offline-sync/patch-receipts");
        let blocked_in_log = blocked.clone();
        let log = move |event: LogEvent| {
            if matches!(event.kind, LogKind::Cmd) && event.text.contains("am --3way") {
                fs::create_dir_all(blocked_in_log.parent().unwrap()).unwrap();
                fs::write(&blocked_in_log, "blocked").unwrap();
            }
        };
        let g = Git::new(None, &log);
        assert!(
            sync::import_patches(&g, &f.work, &f.patches, "received", "main", false, None).is_err()
        );
        assert_eq!(
            fs::read_to_string(f.work.join("file")).unwrap(),
            "returned\n"
        );
        let tip = git(&f.work, &["rev-parse", "HEAD"]);
        let gd = repo::git_dir(&g, &f.work).unwrap();
        assert!(gd.join("offline-sync-patch.json").exists());
        fs::remove_file(blocked).unwrap();
        let silent = |_: LogEvent| {};
        let retry = Git::new(None, &silent);
        if next_package {
            let mut manifest = Manifest::read_for(&f.patches).unwrap().unwrap();
            manifest.seq += 1;
            manifest.write_for(&f.patches).unwrap();
            assert!(
                sync::import_patches(&retry, &f.work, &f.patches, "next", "main", false, None)
                    .unwrap()
                    .ok
            );
        } else {
            assert!(sync::continue_op(&retry, &f.work).unwrap().ok);
        }
        assert!(f.received(&retry));
        assert_eq!(git(&f.work, &["rev-parse", "received"]), tip);
        assert_eq!(
            repo::list_refs(&retry, &f.work, &["refs/offline-sync/patch-receipts"])
                .unwrap()
                .len(),
            if next_package { 2 } else { 1 }
        );
        assert!(!gd.join("offline-sync-patch.json").exists());
    }
}
