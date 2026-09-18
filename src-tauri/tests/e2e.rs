//! 端到端：本地裸仓库扮演 GitLab，两个目录分别扮演内网端和外网端，U 盘是一个目录。
//!
//! 全量 → 外网开发 → bundle 回传 → 内网 rebase + push → 增量（含指向旧提交的新分支）
//! → patch 回传 → 冲突与中止 → 各种保护性检查。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use git_offline_sync_lib::core::git::{Git, LogEvent};
use git_offline_sync_lib::core::manifest::BundleKind;
use git_offline_sync_lib::core::repo;
use git_offline_sync_lib::core::sync::{self, ExportOutcome};

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, content: &str, msg: &str) {
    fs::write(dir.join(file), content).unwrap();
    sh(dir, &["add", file]);
    sh(dir, &["commit", "-q", "-m", msg]);
}

fn exported(o: ExportOutcome) -> (BundleKind, u32, PathBuf) {
    match o {
        ExportOutcome::Exported { kind, seq, payload, .. } => (kind, seq, PathBuf::from(payload)),
        ExportOutcome::NothingToSync { message } => panic!("unexpected nothing-to-sync: {message}"),
    }
}

fn isolate_git_env(root: &Path) {
    let global = root.join("gitconfig");
    fs::write(
        &global,
        "[init]\n\tdefaultBranch = main\n[user]\n\tname = Tester\n\temail = tester@example.com\n",
    )
    .unwrap();
    // 测试进程独占这些环境变量（单个测试函数，无并发）
    std::env::set_var("GIT_CONFIG_GLOBAL", &global);
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
}

#[test]
fn full_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    isolate_git_env(&root);

    let log = |e: LogEvent| eprintln!("[{:?}] {}", e.kind, e.text);
    let g = Git::new(None, &log);
    sync::check_git(&g).expect("git available");

    // ---------- GitLab ----------
    let upstream = root.join("gitlab/project.git");
    fs::create_dir_all(&upstream).unwrap();
    sh(&upstream, &["init", "-q", "--bare", "-b", "main"]);
    let seed = root.join("seed");
    sh(&root, &["clone", "-q", upstream.to_str().unwrap(), "seed"]);
    commit(&seed, "a.txt", "line1\n", "init");
    sh(&seed, &["tag", "v1"]);
    commit(&seed, "a.txt", "line1\nline2\n", "second");
    sh(&seed, &["push", "-q", "origin", "main", "--tags"]);
    let first = sh(&seed, &["rev-parse", "HEAD~1"]);

    // ---------- 内网端 ----------
    let mirror = root.join("internal/project.git");
    let work = root.join("internal/work");
    let usb = root.join("usb");
    sync::init_mirror(&g, upstream.to_str().unwrap(), &mirror).unwrap();
    assert!(repo::is_mirror(&g, &mirror));
    sh(&root, &["clone", "-q", upstream.to_str().unwrap(), "internal/work"]);

    // 镜像目录非空时拒绝重复初始化
    assert!(sync::init_mirror(&g, upstream.to_str().unwrap(), &mirror).is_err());

    let (kind, seq, full) =
        exported(sync::export_out(&g, &mirror, &usb, "proj", "main", true, false).unwrap());
    assert_eq!((kind, seq), (BundleKind::Full, 1));
    assert!(full.exists());

    // ---------- 外网端：首次导入 ----------
    let ext = root.join("external/proj");
    let r = sync::import_in(&g, &full, &ext, false).unwrap();
    assert!(r.cloned);
    assert_eq!(sh(&ext, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert_eq!(sh(&ext, &["tag"]), "v1");
    sync::configure_repo(&g, &ext, "Dev Mac", "dev@corp.example").unwrap();

    // 重复导入全量包到非空目录：允许（当作重新同步），不报错
    sync::import_in(&g, &full, &ext, false).unwrap();

    // ---------- 外网端：开发并回传 ----------
    sync::create_branch(&g, &ext, "feature/ai", "main").unwrap();
    commit(&ext, "b.txt", "from mac\n", "feat: b");
    let back = exported(
        sync::export_back(&g, &ext, &["feature/ai".into()], &usb, "proj", "main").unwrap(),
    );
    assert_eq!(back.0, BundleKind::Back);

    // 没有新提交时不生成空包
    sync::create_branch(&g, &ext, "empty", "main").unwrap();
    assert!(matches!(
        sync::export_back(&g, &ext, &["empty".into()], &usb, "proj", "main").unwrap(),
        ExportOutcome::NothingToSync { .. }
    ));
    sh(&ext, &["switch", "-q", "feature/ai"]);

    // ---------- 内网端：导入回传、rebase、推送 ----------
    // 期间内网 main 前进了一个提交
    commit(&seed, "c.txt", "upstream\n", "upstream change");
    sh(&seed, &["push", "-q", "origin", "main"]);

    // 回传包不能在外网端导入
    assert!(sync::import_in(&g, &back.2, &ext, false).is_err());

    let ib = sync::import_back(&g, &work, &back.2, "main").unwrap();
    assert_eq!(ib.branches.len(), 1);
    assert_eq!(ib.branches[0].local, "feature/ai");
    assert_eq!(ib.branches[0].commits.len(), 1);
    assert_eq!(ib.branches[0].commits[0].email, "dev@corp.example");

    let rb = sync::rebase_onto(&g, &work, "feature/ai", "main", true).unwrap();
    assert!(rb.ok, "{:?}", rb);
    sync::push_branch(&g, &work, "feature/ai", false).unwrap();
    assert!(!sh(&upstream, &["rev-parse", "refs/heads/feature/ai"]).is_empty());

    // 镜像仓库禁止推送
    assert!(sync::push_branch(&g, &mirror, "main", false).is_err());

    // ---------- 增量：含指向旧提交的新分支 ----------
    sh(&seed, &["push", "-q", "origin", &format!("{first}:refs/heads/release")]);
    let (kind, seq, incr) =
        exported(sync::export_out(&g, &mirror, &usb, "proj", "main", true, false).unwrap());
    assert_eq!((kind, seq), (BundleKind::Incr, 2));

    let r = sync::import_in(&g, &incr, &ext, false).unwrap();
    assert!(!r.cloned);
    assert_eq!(
        sh(&ext, &["rev-parse", "origin/main"]),
        sh(&upstream, &["rev-parse", "main"])
    );
    assert_eq!(sh(&ext, &["rev-parse", "origin/release"]), first);
    assert!(r.changes.iter().any(|c| c.name == "refs/remotes/origin/release"));

    // 重复导入同一增量包被拒绝
    let err = sync::import_in(&g, &incr, &ext, false).unwrap_err().to_string();
    assert!(err.contains("已导入过"), "{err}");

    // 内网无变化 → 不生成空包
    assert!(matches!(
        sync::export_out(&g, &mirror, &usb, "proj", "main", true, false).unwrap(),
        ExportOutcome::NothingToSync { .. }
    ));

    // 分支删除通过 manifest 同步
    sh(&seed, &["push", "-q", "origin", ":release"]);
    commit(&seed, "d.txt", "d\n", "more");
    sh(&seed, &["push", "-q", "origin", "main"]);
    let (_, seq, incr3) =
        exported(sync::export_out(&g, &mirror, &usb, "proj", "main", true, false).unwrap());
    assert_eq!(seq, 3);

    // 序号跳号检查：先伪造一个 #5 的包
    let fake = usb.join("proj-out-0005-incr.bundle");
    fs::copy(&incr3, &fake).unwrap();
    let mut m: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(usb.join("proj-out-0003-incr.manifest.json")).unwrap(),
    )
    .unwrap();
    m["seq"] = 5.into();
    m["payload"] = "proj-out-0005-incr.bundle".into();
    fs::write(usb.join("proj-out-0005-incr.manifest.json"), m.to_string()).unwrap();
    let err = sync::import_in(&g, &fake, &ext, false).unwrap_err().to_string();
    assert!(err.contains("序号不连续"), "{err}");

    sync::import_in(&g, &incr3, &ext, false).unwrap();
    assert!(!repo::rev_exists(&g, &ext, "refs/remotes/origin/release"));

    // ---------- patch 回传 ----------
    sync::create_branch(&g, &ext, "feature/patch", "main").unwrap();
    commit(&ext, "e.txt", "patch me\n", "feat: e");
    commit(&ext, "f.txt", "and me\n", "feat: f");
    let (kind, _, pdir) = exported(
        sync::export_patches(&g, &ext, "feature/patch", &usb, "proj", "main").unwrap(),
    );
    assert_eq!(kind, BundleKind::Patch);
    assert_eq!(fs::read_dir(&pdir).unwrap().count(), 2);

    sh(&work, &["switch", "-q", "main"]);
    let ip = sync::import_patches(&g, &work, &pdir, "feature/patch", "main", true).unwrap();
    assert!(ip.ok, "{:?}", ip);
    assert_eq!(
        sync::list_commits(&g, &work, "origin/main", "feature/patch").unwrap().len(),
        2
    );

    // ---------- 冲突与中止 ----------
    sync::create_branch(&g, &ext, "feature/conflict", "main").unwrap();
    commit(&ext, "a.txt", "line1\nMAC\n", "mac edit");
    let (_, _, cb) = exported(
        sync::export_back(&g, &ext, &["feature/conflict".into()], &usb, "proj", "main").unwrap(),
    );
    commit(&seed, "a.txt", "line1\nINTRANET\n", "intranet edit");
    sh(&seed, &["push", "-q", "origin", "main"]);

    sh(&work, &["switch", "-q", "main"]);
    sync::import_back(&g, &work, &cb, "main").unwrap();
    let rb = sync::rebase_onto(&g, &work, "feature/conflict", "main", true).unwrap();
    assert!(!rb.ok && rb.conflict);
    assert_eq!(rb.files, vec!["a.txt".to_string()]);
    let st = repo::status(&g, &work, "main").unwrap();
    assert_eq!(st.in_progress.as_deref(), Some("rebase"));
    // 冲突中禁止其它操作
    assert!(sync::rebase_onto(&g, &work, "feature/ai", "main", false).is_err());
    assert!(sync::abort(&g, &work).unwrap().ok);
    assert_eq!(repo::status(&g, &work, "main").unwrap().in_progress, None);

    // 已检出分支不能直接导入
    let err = sync::import_back(&g, &work, &cb, "main").unwrap_err().to_string();
    assert!(err.contains("当前已检出"), "{err}");

    // 分叉的分支导入为新名字，不覆盖本地
    sh(&work, &["switch", "-q", "main"]);
    sh(&work, &["branch", "-f", "feature/conflict", "origin/main"]);
    let ib = sync::import_back(&g, &work, &cb, "main").unwrap();
    assert!(ib.branches[0].local.starts_with("feature/conflict-import-"));
    assert!(!ib.warnings.is_empty());

    // 包列表
    let pkgs = sync::list_packages(&usb).unwrap();
    assert!(pkgs.len() >= 7);
    assert!(pkgs.iter().all(|p| p.manifest.is_some()));
}
