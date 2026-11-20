//! 内网同步记录重建后，序号从 1 重新开始：外网靠序号组 ID 区分新旧序号。
mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use git_offline_sync_lib::core::git::{Git, LogEvent};
use git_offline_sync_lib::core::manifest::{BundleKind, Manifest};
use git_offline_sync_lib::core::repo::{self, MirrorState};
use git_offline_sync_lib::core::sync;

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

fn payload(out: sync::ExportOutcome) -> PathBuf {
    match out {
        sync::ExportOutcome::Exported { payload, .. } => payload.into(),
        other => panic!("{other:?}"),
    }
}

fn manifest(bundle: &Path) -> Manifest {
    Manifest::read_for(bundle).unwrap().unwrap()
}

fn mirror_state(mirror: &Path) -> MirrorState {
    repo::load_state(mirror).unwrap()
}

struct World {
    root: tempfile::TempDir,
    seed: PathBuf,
    remote: PathBuf,
    ext: PathBuf,
    usb: PathBuf,
}

impl World {
    fn new() -> Self {
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
        git(path, &["init", "-q", seed.to_str().unwrap()]);
        fs::write(seed.join("base"), "base\n").unwrap();
        git(&seed, &["add", "base"]);
        git(&seed, &["commit", "-qm", "base"]);
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
        Self {
            ext: path.join("external.git"),
            usb: path.join("usb"),
            root,
            seed,
            remote,
        }
    }

    /// 建立一个内网镜像；重装开发机后重新建立的镜像没有任何同步记录。
    fn internal(&self, g: &Git, name: &str) -> PathBuf {
        let mirror = self.root.path().join(name);
        sync::init_mirror(g, self.remote.to_str().unwrap(), &mirror).unwrap();
        mirror
    }

    fn advance(&self, file: &str) {
        fs::write(self.seed.join(file), "advanced\n").unwrap();
        git(&self.seed, &["add", file]);
        git(&self.seed, &["commit", "-qm", file]);
        git(&self.seed, &["push", "origin", "main"]);
    }
}

fn export(
    g: &Git,
    mirror: &Path,
    usb: &Path,
    continue_after: Option<u32>,
) -> git_offline_sync_lib::core::error::Result<sync::ExportOutcome> {
    sync::export_out(g, mirror, usb, "test", "main", true, false, continue_after)
}

/// 外网已经导入了旧内网镜像的 #1、#2。
fn imported_old_series(g: &Git, w: &World) -> (PathBuf, String) {
    let old = w.internal(g, "old.git");
    let full = payload(export(g, &old, &w.usb, None).unwrap());
    w.advance("one");
    let incr = payload(export(g, &old, &w.usb, None).unwrap());
    support::import_confirmed(g, &full, &w.ext, false).unwrap();
    support::import_confirmed(g, &incr, &w.ext, false).unwrap();
    let state = mirror_state(&w.ext);
    assert_eq!(state.last_in_seq, 2);
    (old, state.series_id.expect("新版本导出的包带序号组"))
}

#[test]
fn rebuilt_internal_record_starts_a_new_series_that_needs_confirmation() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let w = World::new();
    let (_, old_series) = imported_old_series(&g, &w);

    let fresh = w.internal(&g, "fresh.git");
    let usb2 = w.root.path().join("usb2");
    let restart = payload(export(&g, &fresh, &usb2, None).unwrap());
    let m = manifest(&restart);
    assert_eq!((m.seq, m.kind), (1, BundleKind::Full));
    assert_ne!(m.series_id.as_deref(), Some(old_series.as_str()));

    // 序号 #1 不大于外网已导入的 #2，核心层也不能悄悄放行。
    let error = support::import_confirmed(&g, &restart, &w.ext, false)
        .unwrap_err()
        .to_string();
    assert!(error.contains("新的序号组"), "{error}");
    assert_eq!(mirror_state(&w.ext).last_in_seq, 2);

    let mut confirmation = support::confirmation(&g, &restart, &w.ext, false).unwrap();
    confirmation.allow_new_series = true;
    sync::import_in(&g, &restart, &w.ext, Some(&confirmation)).unwrap();
    let state = mirror_state(&w.ext);
    assert_eq!(state.last_in_seq, 1);
    assert_eq!(state.series_id, m.series_id);

    // 之后沿新的序号组正常接续。
    w.advance("two");
    let next = payload(export(&g, &fresh, &usb2, None).unwrap());
    assert_eq!(
        (manifest(&next).seq, manifest(&next).kind),
        (2, BundleKind::Incr)
    );
    support::import_confirmed(&g, &next, &w.ext, false).unwrap();
    assert_eq!(mirror_state(&w.ext).last_in_seq, 2);
}

#[test]
fn incremental_from_another_series_is_never_imported() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let w = World::new();
    imported_old_series(&g, &w);

    let fresh = w.internal(&g, "fresh.git");
    let usb2 = w.root.path().join("usb2");
    payload(export(&g, &fresh, &usb2, None).unwrap());
    w.advance("two");
    let incr = payload(export(&g, &fresh, &usb2, None).unwrap());
    assert_eq!(manifest(&incr).seq, 2);

    let before = fs::read(w.ext.join("offline-sync/state.json")).unwrap();
    let mut confirmation = support::confirmation(&g, &incr, &w.ext, false).unwrap();
    confirmation.allow_new_series = true;
    let error = sync::import_in(&g, &incr, &w.ext, Some(&confirmation))
        .unwrap_err()
        .to_string();
    assert!(error.contains("另一组序号"), "{error}");
    assert_eq!(
        fs::read(w.ext.join("offline-sync/state.json")).unwrap(),
        before
    );
}

#[test]
fn rebuilt_record_can_continue_after_the_packages_already_in_transfer_dir() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let w = World::new();
    let (_, old_series) = imported_old_series(&g, &w);

    // 不接续时仍沿用“包已存在，不会覆盖”的保护。
    let fresh = w.internal(&g, "fresh.git");
    let error = export(&g, &fresh, &w.usb, None).unwrap_err().to_string();
    assert!(error.contains("包已存在"), "{error}");

    let stale = export(&g, &fresh, &w.usb, Some(1)).unwrap_err().to_string();
    assert!(stale.contains("已不是 #1"), "{stale}");

    let next = payload(export(&g, &fresh, &w.usb, Some(2)).unwrap());
    let m = manifest(&next);
    assert_eq!((m.seq, m.kind), (3, BundleKind::Full));
    assert_eq!(m.series_id.as_deref(), Some(old_series.as_str()));
    // 沿用旧序号组，外网无需任何额外确认。
    support::import_confirmed(&g, &next, &w.ext, false).unwrap();
    assert_eq!(mirror_state(&w.ext).last_in_seq, 3);

    // 已经导出过的镜像不能再接续。
    let again = export(&g, &fresh, &w.usb, Some(3)).unwrap_err().to_string();
    assert!(again.contains("不能再接续"), "{again}");
}

#[test]
fn packages_and_states_without_series_keep_the_old_sequence_rules() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let w = World::new();
    let old = w.internal(&g, "old.git");
    let full = payload(export(&g, &old, &w.usb, None).unwrap());
    w.advance("one");
    let incr = payload(export(&g, &old, &w.usb, None).unwrap());
    support::import_confirmed(&g, &full, &w.ext, false).unwrap();

    // 旧版本外网状态没有序号组：序号接得上的新包照常导入，并记下序号组。
    let mut state = mirror_state(&w.ext);
    let series = state.series_id.take().unwrap();
    repo::save_state(&w.ext, &state).unwrap();
    support::import_confirmed(&g, &incr, &w.ext, false).unwrap();
    assert_eq!(
        mirror_state(&w.ext).series_id.as_deref(),
        Some(series.as_str())
    );

    let base = manifest(&incr);
    let with = |series: Option<&str>, seq: u32| Manifest {
        series_id: series.map(Into::into),
        seq,
        ..base.clone()
    };
    let state = |series: Option<&str>| MirrorState {
        series_id: series.map(Into::into),
        last_in_seq: 5,
        ..Default::default()
    };
    // 镜像记录没有序号组：旧包照旧规则；已有序号组后，没有序号组的遗留旧包不再属于它。
    assert!(sync::is_foreign_series(&state(Some("a")), &with(None, 1)));
    assert!(!sync::is_foreign_series(&state(None), &with(None, 1)));
    // 旧外网状态：序号不大于已导入的带序号组的包只可能来自重建后的内网。
    assert!(sync::is_foreign_series(&state(None), &with(Some("b"), 3)));
    assert!(!sync::is_foreign_series(&state(None), &with(Some("b"), 6)));
    assert!(sync::is_foreign_series(
        &state(Some("a")),
        &with(Some("b"), 6)
    ));
    assert!(!sync::is_foreign_series(
        &state(Some("a")),
        &with(Some("a"), 1)
    ));
}

#[test]
fn untagged_package_left_over_from_the_old_series_is_not_imported_after_a_switch() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let w = World::new();
    let old = w.internal(&g, "old.git");
    let full = payload(export(&g, &old, &w.usb, None).unwrap());
    w.advance("one");
    let incr = payload(export(&g, &old, &w.usb, None).unwrap());
    support::import_confirmed(&g, &full, &w.ext, false).unwrap();

    // 切换到重建后的新序号组，外网记录为新序号组的 #1。
    let fresh = w.internal(&g, "fresh.git");
    let usb2 = w.root.path().join("usb2");
    let restart = payload(export(&g, &fresh, &usb2, None).unwrap());
    let mut confirmation = support::confirmation(&g, &restart, &w.ext, false).unwrap();
    confirmation.allow_new_series = true;
    sync::import_in(&g, &restart, &w.ext, Some(&confirmation)).unwrap();

    // 旧序号组遗留的 #2 即使没有序号组标记，也不能当作新序号组的下一包。
    let mut legacy = manifest(&incr);
    legacy.series_id = None;
    legacy.write_for(&incr).unwrap();
    let before = fs::read(w.ext.join("offline-sync/state.json")).unwrap();
    let error = support::import_confirmed(&g, &incr, &w.ext, false)
        .unwrap_err()
        .to_string();
    assert!(error.contains("另一组序号"), "{error}");
    assert_eq!(
        fs::read(w.ext.join("offline-sync/state.json")).unwrap(),
        before
    );
}

#[test]
fn continuation_refuses_ambiguous_or_payloadless_predecessors() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let w = World::new();
    imported_old_series(&g, &w);

    // 另一序号组的 #2（全量）与旧序号组的 #2（增量）并存：无法确定接续哪一组。
    let other = w.internal(&g, "other.git");
    let usb2 = w.root.path().join("usb2");
    payload(export(&g, &other, &usb2, None).unwrap());
    let rival =
        payload(sync::export_out(&g, &other, &usb2, "test", "main", true, true, None).unwrap());
    assert_eq!(manifest(&rival).seq, 2);
    let name = rival.file_name().unwrap();
    fs::copy(&rival, w.usb.join(name)).unwrap();
    fs::copy(
        rival.with_extension("manifest.json"),
        w.usb.join(name).with_extension("manifest.json"),
    )
    .unwrap();
    let fresh = w.internal(&g, "fresh.git");
    let error = export(&g, &fresh, &w.usb, Some(2)).unwrap_err().to_string();
    assert!(error.contains("不同序号组"), "{error}");
    assert!(!fresh.join("offline-sync/state.json").exists());

    // 最新序号的包文件已被删除：候选回退到 #1，不能再按 #2 接续。
    fs::remove_file(w.usb.join(name)).unwrap();
    let old_incr = w.usb.join("test-out-0002-incr.bundle");
    fs::remove_file(&old_incr).unwrap();
    let error = export(&g, &fresh, &w.usb, Some(2)).unwrap_err().to_string();
    assert!(error.contains("已不是 #2"), "{error}");
}
