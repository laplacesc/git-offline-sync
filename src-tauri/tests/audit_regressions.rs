//! Safety assertions converted from the independently reproduced audit probes.
mod support;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use git_offline_sync_lib::core::git::{Git, LogEvent, LogKind};
use git_offline_sync_lib::core::manifest::{manifest_path_for, Manifest};
use git_offline_sync_lib::core::{repo, sync};

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}

fn commit(path: &Path, name: &str) {
    fs::write(path.join(name), name).unwrap();
    git(path, &["add", name]);
    git(path, &["commit", "-qm", name]);
}

fn setup() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let seed = root.path().join("seed");
    git(
        root.path(),
        &["init", "-q", "-b", "main", seed.to_str().unwrap()],
    );
    git(&seed, &["config", "user.name", "Audit"]);
    git(&seed, &["config", "user.email", "audit@example.invalid"]);
    git(&seed, &["config", "commit.gpgsign", "false"]);
    commit(&seed, "base");
    git(&seed, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    (root, seed)
}

// Build a real exported/imported mirror before exercising return publication races.
fn bind_return_mirror(root: &Path, seed: &Path) {
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let internal = root.join("return-internal");
    let mirror = root.join("mirror");
    sync::init_mirror(&g, seed.to_str().unwrap(), &internal).unwrap();
    let full = payload(
        sync::export_out(
            &g,
            &internal,
            &root.join("bootstrap"),
            "test",
            "main",
            false,
            false,
        )
        .unwrap(),
    );
    support::import_confirmed(&g, &full, &mirror, false).unwrap();
    git(seed, &["remote", "add", "origin", mirror.to_str().unwrap()]);
}

fn payload(outcome: sync::ExportOutcome) -> PathBuf {
    match outcome {
        sync::ExportOutcome::Exported { payload, .. } => payload.into(),
        other => panic!("expected exported package: {other:?}"),
    }
}

fn refs(g: &Git, path: &Path) -> BTreeMap<String, String> {
    repo::list_refs(g, path, &["refs/heads", "refs/tags"])
        .unwrap()
        .into_iter()
        .collect()
}

fn files(path: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<_> = fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    entries.sort();
    entries
}

#[test]
fn fetch_ignores_custom_mapping_and_preserves_local_heads_index_and_worktree() {
    let (root, seed) = setup();
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let mirror = root.path().join("mirror");
    let dev = root.path().join("dev");
    git(
        root.path(),
        &[
            "clone",
            "--bare",
            seed.to_str().unwrap(),
            mirror.to_str().unwrap(),
        ],
    );
    repo::mark_ext_mirror(&g, &mirror).unwrap();
    git(
        &mirror,
        &["update-ref", "refs/heads/topic", "refs/heads/main"],
    );
    sync::create_dev_repo(&g, &mirror, &dev, "Audit", "audit@example.invalid").unwrap();
    git(&dev, &["config", "commit.gpgsign", "false"]);
    git(&dev, &["switch", "-c", "topic"]);
    commit(&dev, "local-only");
    git(&dev, &["switch", "main"]);
    git(
        &dev,
        &[
            "config",
            "--add",
            "remote.origin.fetch",
            "+refs/heads/topic:refs/heads/topic",
        ],
    );
    let local_heads = refs(&g, &dev);
    fs::write(dev.join("base"), "staged content").unwrap();
    git(&dev, &["add", "base"]);
    fs::write(dev.join("base"), "unstaged content").unwrap();
    fs::write(dev.join("untracked"), "keep me").unwrap();
    let index = git(&dev, &["diff", "--cached"]);
    let dirty = git(&dev, &["status", "--porcelain"]);
    commit(&seed, "upstream");
    let tip = git(&seed, &["rev-parse", "HEAD"]);
    git(&mirror, &["fetch", "origin", &tip]);
    git(&mirror, &["update-ref", "refs/heads/main", &tip]);
    git(&mirror, &["update-ref", "refs/heads/topic", &tip]);

    sync::sync_dev_repo(&g, &dev, &mirror).unwrap();
    assert_eq!(refs(&g, &dev), local_heads);
    assert_eq!(git(&dev, &["rev-parse", "origin/main"]), tip);
    assert_eq!(git(&dev, &["rev-parse", "origin/topic"]), tip);
    assert_eq!(git(&dev, &["diff", "--cached"]), index);
    assert_eq!(git(&dev, &["status", "--porcelain"]), dirty);
    assert_eq!(
        fs::read_to_string(dev.join("base")).unwrap(),
        "unstaged content"
    );
    assert_eq!(
        fs::read_to_string(dev.join("untracked")).unwrap(),
        "keep me"
    );
}

#[test]
fn outgoing_snapshot_races_never_publish_or_advance_full_incremental_or_fallback() {
    for mode in ["full", "incr", "fallback"] {
        let (root, seed) = setup();
        let quiet = |_: LogEvent| {};
        let setup = Git::new(None, &quiet);
        let mirror = root.path().join("internal");
        let usb = root.path().join("usb");
        git(
            root.path(),
            &[
                "clone",
                "--mirror",
                seed.to_str().unwrap(),
                mirror.to_str().unwrap(),
            ],
        );
        payload(sync::export_out(&setup, &mirror, &usb, "test", "main", false, true).unwrap());
        let old = git(&mirror, &["rev-parse", "main"]);
        commit(&seed, "one");
        let one = git(&seed, &["rev-parse", "main"]);
        commit(&seed, "two");
        let two = git(&seed, &["rev-parse", "main"]);
        git(&mirror, &["fetch", "origin", &two]);
        git(
            &mirror,
            &[
                "update-ref",
                "refs/heads/main",
                if mode == "fallback" { &old } else { &one },
            ],
        );
        if mode == "fallback" {
            git(&mirror, &["branch", "ref-only", &old]);
        }
        let state = fs::read(mirror.join("offline-sync/state.json")).unwrap();
        let published = files(&usb);
        let injection = mirror.clone();
        let count = AtomicUsize::new(0);
        let log = move |event: LogEvent| {
            if event.kind == LogKind::Cmd
                && event.text.starts_with("git bundle create")
                && count.fetch_add(1, Ordering::SeqCst) == usize::from(mode == "fallback")
            {
                git(&injection, &["update-ref", "refs/heads/main", &two]);
            }
        };
        let g = Git::new(None, &log);
        assert!(
            sync::export_out(&g, &mirror, &usb, "test", "main", false, mode == "full").is_err(),
            "{mode}"
        );
        assert_eq!(
            fs::read(mirror.join("offline-sync/state.json")).unwrap(),
            state,
            "{mode}"
        );
        assert_eq!(files(&usb), published, "{mode}");
    }
}

#[test]
fn return_snapshot_races_reject_changed_and_missing_advertisements() {
    for omit in [false, true] {
        let (root, seed) = setup();
        bind_return_mirror(root.path(), &seed);
        let base = git(&seed, &["rev-parse", "main"]);
        git(&seed, &["switch", "-c", "topic"]);
        commit(&seed, "one");
        git(&seed, &["branch", "other"]);
        let injection = seed.clone();
        let moved = AtomicBool::new(false);
        let log = move |event: LogEvent| {
            if event.kind == LogKind::Cmd
                && event.text.starts_with("git bundle create")
                && !moved.swap(true, Ordering::SeqCst)
            {
                if omit {
                    git(&injection, &["update-ref", "refs/heads/topic", &base]);
                } else {
                    commit(&injection, "two");
                }
            }
        };
        let g = Git::new(None, &log);
        let mirror = root.path().join("mirror");
        let usb = root.path().join("usb");
        assert!(sync::export_back(
            &g,
            &seed,
            &mirror,
            &["topic".into(), "other".into()],
            &usb,
            "test",
            "main",
            &[]
        )
        .is_err());
        assert_eq!(
            repo::load_state::<repo::MirrorState>(&mirror)
                .unwrap()
                .back_seq,
            0
        );
        assert!(files(&usb).is_empty());
        assert!(!mirror.join("offline-sync/export-pending.json").exists());
    }
}

#[test]
fn return_exclusions_are_frozen_and_covered_refs_may_be_omitted() {
    let (root, seed) = setup();
    bind_return_mirror(root.path(), &seed);
    let receiver = root.path().join("receiver");
    git(
        root.path(),
        &[
            "clone",
            "--bare",
            seed.to_str().unwrap(),
            receiver.to_str().unwrap(),
        ],
    );
    git(&seed, &["switch", "-c", "topic"]);
    commit(&seed, "one");
    let tip = git(&seed, &["rev-parse", "topic"]);
    let injection = seed.clone();
    let injected_tip = tip.clone();
    let moved = AtomicBool::new(false);
    let log = move |event: LogEvent| {
        if event.kind == LogKind::Cmd
            && event.text.starts_with("git bundle create")
            && !moved.swap(true, Ordering::SeqCst)
        {
            git(
                &injection,
                &["update-ref", "refs/remotes/origin/main", &injected_tip],
            );
        }
    };
    let g = Git::new(None, &log);
    let bundle = payload(
        sync::export_back(
            &g,
            &seed,
            &root.path().join("mirror"),
            &["main".into(), "topic".into()],
            &root.path().join("usb"),
            "test",
            "main",
            &[],
        )
        .unwrap(),
    );
    let advertised = git(&seed, &["bundle", "list-heads", bundle.to_str().unwrap()]);
    assert!(advertised.contains("refs/heads/topic"));
    assert!(!advertised.contains("refs/heads/main"));
    git(&receiver, &["bundle", "verify", bundle.to_str().unwrap()]);
    git(&receiver, &["bundle", "unbundle", bundle.to_str().unwrap()]);
    assert_eq!(git(&receiver, &["show", &format!("{tip}:one")]), "one");
}

#[test]
fn merge_continue_finishes_only_after_resolution_in_linked_worktree() {
    let (root, seed) = setup();
    let worktree = root.path().join("linked");
    git(
        &seed,
        &["worktree", "add", "-b", "topic", worktree.to_str().unwrap()],
    );
    fs::write(worktree.join("base"), "topic").unwrap();
    git(&worktree, &["commit", "-am", "topic"]);
    fs::write(seed.join("base"), "main").unwrap();
    git(&seed, &["commit", "-am", "main"]);
    let topic = git(&worktree, &["rev-parse", "HEAD"]);
    let main = git(&seed, &["rev-parse", "HEAD"]);
    let merge = Command::new("git")
        .current_dir(&worktree)
        .args(["merge", "main"])
        .output()
        .unwrap();
    assert!(!merge.status.success());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let gd = repo::git_dir(&g, &worktree).unwrap();
    let patch_journal = gd.join("offline-sync-patch.json");
    fs::write(&patch_journal, "unrelated patch receipt").unwrap();
    assert!(!sync::continue_op(&g, &worktree).unwrap().ok);
    assert_eq!(repo::in_progress(&gd).as_deref(), Some("merge"));
    assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), topic);
    fs::write(worktree.join("base"), "resolved").unwrap();
    git(&worktree, &["add", "base"]);
    assert!(sync::continue_op(&g, &worktree).unwrap().ok);
    assert_eq!(repo::in_progress(&gd), None);
    let parents = git(&worktree, &["show", "-s", "--format=%P", "HEAD"]);
    assert_eq!(parents, format!("{topic} {main}"));
    assert_eq!(git(&worktree, &["show", "HEAD:base"]), "resolved");
    assert!(git(&worktree, &["status", "--porcelain"]).is_empty());
    assert_eq!(
        fs::read_to_string(patch_journal).unwrap(),
        "unrelated patch receipt"
    );
}

#[test]
fn patch_rejects_empty_only_and_mixed_ranges_without_publication() {
    for mixed in [false, true] {
        let (root, seed) = setup();
        bind_return_mirror(root.path(), &seed);
        git(&seed, &["switch", "-c", "topic"]);
        if mixed {
            commit(&seed, "normal");
        }
        git(&seed, &["commit", "--allow-empty", "-m", "empty"]);
        let log = |_: LogEvent| {};
        let g = Git::new(None, &log);
        let mirror = root.path().join("mirror");
        let usb = root.path().join("usb");
        let before = refs(&g, &seed);
        let error = sync::export_patches(&g, &seed, &mirror, "topic", &usb, "test", "main", &[])
            .unwrap_err();
        assert!(error.to_string().contains("Bundle"));
        assert_eq!(refs(&g, &seed), before);
        assert_eq!(
            repo::load_state::<repo::MirrorState>(&mirror)
                .unwrap()
                .back_seq,
            0
        );
        assert!(files(&usb).is_empty());
        assert!(!mirror.join("offline-sync/export-pending.json").exists());
        // The same commits remain exportable without loss in Bundle mode.
        let bundle = payload(
            sync::export_back(
                &g,
                &seed,
                &mirror,
                &["topic".into()],
                &usb,
                "test",
                "main",
                &[],
            )
            .unwrap(),
        );
        assert!(bundle.exists());
        assert_eq!(
            repo::load_state::<repo::MirrorState>(&mirror)
                .unwrap()
                .back_seq,
            1
        );
    }
}

struct ImportFixture {
    root: tempfile::TempDir,
    mirror: PathBuf,
    external: PathBuf,
    usb: PathBuf,
    second: PathBuf,
}

impl ImportFixture {
    fn new(g: &Git) -> Self {
        let (root, seed) = setup();
        git(&seed, &["branch", "retired"]);
        git(&seed, &["tag", "retired"]);
        let mirror = root.path().join("internal");
        let external = root.path().join("external");
        let usb = root.path().join("usb");
        git(
            root.path(),
            &[
                "clone",
                "--mirror",
                seed.to_str().unwrap(),
                mirror.to_str().unwrap(),
            ],
        );
        let first =
            payload(sync::export_out(g, &mirror, &usb, "test", "main", false, true).unwrap());
        support::import_confirmed(g, &first, &external, false).unwrap();
        let second =
            payload(sync::export_out(g, &mirror, &usb, "test", "main", false, true).unwrap());
        Self {
            root,
            mirror,
            external,
            usb,
            second,
        }
    }

    fn third(&self, g: &Git) -> PathBuf {
        git(&self.mirror, &["update-ref", "-d", "refs/heads/retired"]);
        git(&self.mirror, &["update-ref", "-d", "refs/tags/retired"]);
        payload(sync::export_out(g, &self.mirror, &self.usb, "test", "main", false, true).unwrap())
    }

    fn unchanged(&self, g: &Git, old_refs: &BTreeMap<String, String>, old_state: &[u8]) {
        assert_eq!(refs(g, &self.external), *old_refs);
        assert_eq!(
            fs::read(self.external.join("offline-sync/state.json")).unwrap(),
            old_state
        );
    }
}

#[test]
fn confirmation_is_required_and_missing_or_replaced_manifest_and_payload_are_rejected() {
    for replacement in ["none", "missing", "manifest", "payload", "both"] {
        let log = |_: LogEvent| {};
        let g = Git::new(None, &log);
        let fixture = ImportFixture::new(&g);
        let expected =
            support::confirmation(&g, &fixture.second, &fixture.external, false).unwrap();
        let old_refs = refs(&g, &fixture.external);
        let old_state = fs::read(fixture.external.join("offline-sync/state.json")).unwrap();
        if replacement == "missing" {
            fs::remove_file(manifest_path_for(&fixture.second)).unwrap();
        } else if replacement != "none" {
            let third = fixture.third(&g);
            if replacement != "manifest" {
                fs::copy(&third, &fixture.second).unwrap();
            }
            if replacement != "payload" {
                let mut changed = Manifest::read_for(&third).unwrap().unwrap();
                changed.payload = expected.manifest.payload.clone();
                changed.write_for(&fixture.second).unwrap();
            }
        }
        let confirmation = (replacement != "none").then_some(&expected);
        assert!(
            sync::sync_updates(
                &g,
                &fixture.external,
                Some(&fixture.second),
                confirmation,
                &[],
                "",
                ""
            )
            .is_err(),
            "{replacement}"
        );
        fixture.unchanged(&g, &old_refs, &old_state);
    }
}

#[test]
fn full_gap_requires_explicit_approval_and_manifest_comparison_is_semantic() {
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let fixture = ImportFixture::new(&g);
    let third = fixture.third(&g);
    let mut expected = support::confirmation(&g, &third, &fixture.external, false).unwrap();
    let old_refs = refs(&g, &fixture.external);
    let old_state = fs::read(fixture.external.join("offline-sync/state.json")).unwrap();
    assert!(sync::import_in(&g, &third, &fixture.external, Some(&expected)).is_err());
    fixture.unchanged(&g, &old_refs, &old_state);
    expected.allow_full_gap = true;
    sync::import_in(&g, &third, &fixture.external, Some(&expected)).unwrap();
    assert_eq!(refs(&g, &fixture.external), refs(&g, &fixture.mirror));
    assert_eq!(
        repo::load_state::<repo::MirrorState>(&fixture.external)
            .unwrap()
            .last_in_seq,
        3
    );

    // A first full package may start at any sequence; refs are an unordered set.
    let first_target = fixture.root.path().join("fresh");
    let mut first = support::confirmation(&g, &fixture.second, &first_target, false).unwrap();
    first.manifest.refs.reverse();
    sync::import_in(&g, &fixture.second, &first_target, Some(&first)).unwrap();
    assert_eq!(
        repo::load_state::<repo::MirrorState>(&first_target)
            .unwrap()
            .last_in_seq,
        2
    );
    assert_eq!(refs(&g, &first_target), old_refs);
}

#[test]
fn stale_sequence_and_head_or_tag_confirmations_cannot_overwrite_mirror_changes() {
    for change in ["seq", "head", "tag"] {
        let log = |_: LogEvent| {};
        let g = Git::new(None, &log);
        let fixture = ImportFixture::new(&g);
        let expected =
            support::confirmation(&g, &fixture.second, &fixture.external, false).unwrap();
        if change == "seq" {
            let mut state: repo::MirrorState = repo::load_state(&fixture.external).unwrap();
            state.last_in_seq = 7;
            repo::save_state(&fixture.external, &state).unwrap();
        } else {
            let name = if change == "head" {
                "refs/heads/retired"
            } else {
                "refs/tags/retired"
            };
            git(&fixture.external, &["update-ref", "-d", name]);
        }
        let old_refs = refs(&g, &fixture.external);
        let old_state = fs::read(fixture.external.join("offline-sync/state.json")).unwrap();
        assert!(sync::import_in(&g, &fixture.second, &fixture.external, Some(&expected)).is_err());
        fixture.unchanged(&g, &old_refs, &old_state);
    }
}

#[test]
fn mirror_state_is_rechecked_after_unbundle_before_ref_transaction() {
    for change in ["seq", "refs"] {
        let quiet = |_: LogEvent| {};
        let setup = Git::new(None, &quiet);
        let fixture = ImportFixture::new(&setup);
        let expected =
            support::confirmation(&setup, &fixture.second, &fixture.external, false).unwrap();
        let external = fixture.external.clone();
        let changed = AtomicBool::new(false);
        let log = move |event: LogEvent| {
            if event.kind == LogKind::Cmd
                && event.text.starts_with("git bundle unbundle")
                && !changed.swap(true, Ordering::SeqCst)
            {
                if change == "seq" {
                    let mut state: repo::MirrorState = repo::load_state(&external).unwrap();
                    state.last_in_seq = 8;
                    repo::save_state(&external, &state).unwrap();
                } else {
                    git(&external, &["update-ref", "-d", "refs/tags/retired"]);
                }
            }
        };
        let g = Git::new(None, &log);
        assert!(sync::import_in(&g, &fixture.second, &fixture.external, Some(&expected)).is_err());
        assert_eq!(
            repo::load_state::<repo::MirrorState>(&fixture.external)
                .unwrap()
                .last_in_seq,
            if change == "seq" { 8 } else { 1 }
        );
        let mut expected_refs = expected.mirror_refs;
        if change == "refs" {
            expected_refs.remove("refs/tags/retired");
        }
        assert_eq!(refs(&setup, &fixture.external), expected_refs);
    }
}

#[test]
fn import_uses_frozen_bundle_and_manifest_after_transfer_path_replacement() {
    let quiet = |_: LogEvent| {};
    let setup = Git::new(None, &quiet);
    let fixture = ImportFixture::new(&setup);
    let expected =
        support::confirmation(&setup, &fixture.second, &fixture.external, false).unwrap();
    let third = fixture.third(&setup);
    let scanned = fixture.second.clone();
    let replaced = AtomicBool::new(false);
    let log = move |event: LogEvent| {
        if event.kind == LogKind::Cmd
            && event.text.starts_with("git bundle verify")
            && !replaced.swap(true, Ordering::SeqCst)
        {
            fs::copy(&third, &scanned).unwrap();
            fs::remove_file(manifest_path_for(&scanned)).unwrap();
        }
    };
    let g = Git::new(None, &log);
    sync::import_in(&g, &fixture.second, &fixture.external, Some(&expected)).unwrap();
    assert_eq!(refs(&setup, &fixture.external), expected.mirror_refs);
    assert_eq!(
        repo::load_state::<repo::MirrorState>(&fixture.external)
            .unwrap()
            .last_in_seq,
        2
    );
    assert!(Manifest::read_for(&fixture.second).unwrap().is_none());
}

#[test]
fn external_import_requires_manifest_and_confirmation() {
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let fixture = ImportFixture::new(&g);
    let mirror = fixture.root.path().join("fresh");
    let expected = support::confirmation(&g, &fixture.second, &mirror, false).unwrap();
    assert!(sync::sync_updates(&g, &mirror, Some(&fixture.second), None, &[], "", "").is_err());
    assert!(sync::import_in(&g, &fixture.second, &mirror, None).is_err());
    assert!(!mirror.exists());
    fs::remove_file(manifest_path_for(&fixture.second)).unwrap();
    assert!(sync::import_in(&g, &fixture.second, &mirror, Some(&expected)).is_err());
    assert!(!mirror.exists());
}
