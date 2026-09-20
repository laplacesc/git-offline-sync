//! 端到端：本地裸仓库扮演 GitLab，两个目录分别扮演内网端和外网端，U 盘是一个目录。
//!
//! 全量 → 外网开发 → bundle 回传 → 内网 rebase + push → 增量（含指向旧提交的新分支）
//! → patch 回传 → 冲突与中止 → 各种保护性检查。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

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

/// 两个路径是否指向同一位置。
///
/// 不能直接比字符串：`git worktree list` 在 Windows 上返回长路径 + 正斜杠
/// （`C:/Users/runneradmin/…`），而测试里的临时目录是 8.3 短名 + 反斜杠
/// （`C:\Users\RUNNER~1\…`）。产品代码里的 `same_dir` 也是这样比的。
fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// `same_path` 的断言版，失败时打印两边的原始值。
fn assert_same_path(actual: Option<&str>, expected: &Path) {
    let got = actual.unwrap_or_else(|| panic!("期望路径 {}，实际是 None", expected.display()));
    assert!(
        same_path(Path::new(got), expected),
        "路径不一致：\n  实际 {got}\n  期望 {}",
        expected.display()
    );
}

fn exported(o: ExportOutcome) -> (BundleKind, u32, PathBuf) {
    match o {
        ExportOutcome::Exported { kind, seq, payload, .. } => (kind, seq, PathBuf::from(payload)),
        ExportOutcome::NothingToSync { message } => panic!("unexpected nothing-to-sync: {message}"),
    }
}

/// 各测试共享 GIT_CONFIG_GLOBAL 等进程级环境变量，必须串行执行。
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn isolate_git_env(root: &Path) {
    let global = root.join("gitconfig");
    fs::write(
        &global,
        "[init]\n\tdefaultBranch = main\n[user]\n\tname = Tester\n\temail = tester@example.com\n",
    )
    .unwrap();
    // 调用方持有 ENV_LOCK，保证这些环境变量不被并发修改
    std::env::set_var("GIT_CONFIG_GLOBAL", &global);
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
}

#[test]
fn full_round_trip() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    // macOS 的临时目录是 /var → /private/var 软链接，需规范化；
    // Windows 上 canonicalize 会返回 \\?\C:\... 形式，git 无法读取该路径下的配置，保持原样。
    let root = if cfg!(windows) {
        tmp.path().to_path_buf()
    } else {
        tmp.path().canonicalize().unwrap()
    };
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

    // ---------- 外网端：首次导入到镜像 ----------
    let extm = root.join("external/mirror.git");
    let ext = root.join("external/proj");
    let r = sync::import_in(&g, &full, &extm, false).unwrap();
    assert!(r.created);
    assert!(repo::is_ext_mirror(&g, &extm));
    assert!(repo::is_bare(&g, &extm).unwrap());
    // 内网分支落在镜像的 refs/heads，state.json 在镜像目录里
    assert!(!sh(&extm, &["rev-parse", "refs/heads/main"]).is_empty());
    assert!(extm.join("offline-sync/state.json").exists());

    // 目录已存在但不是镜像（例如旧版本的开发仓库）→ 明确报错，不尝试兼容
    let stale = root.join("external/stale");
    fs::create_dir_all(&stale).unwrap();
    fs::write(stale.join("x"), "x").unwrap();
    let err = sync::import_in(&g, &full, &stale, false).unwrap_err().to_string();
    assert!(err.contains("不是外网镜像"), "{err}");

    // 空镜像（首次 fetch 失败留下的）不能用增量包填
    let empty = root.join("external/empty.git");
    fs::create_dir_all(&empty).unwrap();
    sh(&empty, &["init", "-q", "--bare"]);
    sh(&empty, &["config", "offlinesync.role", "mirror"]);
    let fake_incr = usb.join("proj-out-0009-incr.bundle");
    fs::copy(&full, &fake_incr).unwrap();
    let mut fm: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(usb.join("proj-out-0001-full.manifest.json")).unwrap(),
    )
    .unwrap();
    fm["kind"] = "incr".into();
    fm["seq"] = 9.into();
    fm["payload"] = "proj-out-0009-incr.bundle".into();
    fs::write(usb.join("proj-out-0009-incr.manifest.json"), fm.to_string()).unwrap();
    let err = sync::import_in(&g, &fake_incr, &empty, false).unwrap_err().to_string();
    assert!(err.contains("必须使用全量包"), "{err}");

    // 回归：没有 manifest 的裸 bundle 也能导入，镜像 HEAD 不能悬空。
    // 悬空时从镜像克隆出的开发仓库不会检出任何分支（旧实现只在有 manifest 时设 HEAD）。
    let bare_bundle = root.join("nomanifest.bundle");
    fs::copy(&full, &bare_bundle).unwrap();
    let m2 = root.join("external/nomanifest.git");
    fs::create_dir_all(&m2).unwrap();
    // 故意让初始 HEAD 指向一个包里没有的分支
    sh(&m2, &["init", "-q", "--bare", "-b", "not-a-real-branch"]);
    sh(&m2, &["config", "offlinesync.role", "mirror"]);
    sync::import_in(&g, &bare_bundle, &m2, false).unwrap();
    let head = sh(&m2, &["symbolic-ref", "HEAD"]);
    assert!(
        repo::rev_exists(&g, &m2, &head),
        "镜像 HEAD 必须指向真实存在的分支，实际是 {head}"
    );
    let d2 = root.join("external/nomanifest-dev");
    sync::create_dev_repo(&g, &m2, &d2, "T", "t@example.com").unwrap();
    assert!(d2.join("a.txt").exists(), "开发仓库应该检出了工作树");

    // ---------- 外网端：从镜像克隆开发仓库 ----------
    sync::create_dev_repo(&g, &extm, &ext, "Dev Mac", "dev@corp.example").unwrap();
    assert_eq!(sh(&ext, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert_eq!(sh(&ext, &["tag"]), "v1");
    // origin 是本地镜像目录，不是 U 盘上的 bundle 文件
    assert_same_path(Some(&sh(&ext, &["remote", "get-url", "origin"])), &extm);
    assert!(sh(&ext, &["remote", "get-url", "--push", "origin"]).contains("DISABLED"));
    // 推送到镜像被挡住
    assert!(!Command::new("git")
        .args(["push", "origin", "main"])
        .current_dir(&ext)
        .output()
        .unwrap()
        .status
        .success());

    // 重复导入全量包到已存在的镜像：允许（当作重新同步），不报错
    let r = sync::import_in(&g, &full, &extm, false).unwrap();
    assert!(!r.created);

    // ---------- 外网端：开发并回传 ----------
    sync::create_branch(&g, &ext, "feature/ai", "main", None).unwrap();
    commit(&ext, "b.txt", "from mac\n", "feat: b");
    let back = exported(
        sync::export_back(&g, &ext, &extm, &["feature/ai".into()], &usb, "proj", "main", &[])
            .unwrap(),
    );
    assert_eq!(back.0, BundleKind::Back);

    // 没有新提交时不生成空包
    sync::create_branch(&g, &ext, "empty", "main", None).unwrap();
    assert!(matches!(
        sync::export_back(&g, &ext, &extm, &["empty".into()], &usb, "proj", "main", &[]).unwrap(),
        ExportOutcome::NothingToSync { .. }
    ));
    sh(&ext, &["switch", "-q", "feature/ai"]);

    // ---------- 内网端：导入回传、rebase、推送 ----------
    // 期间内网 main 前进了一个提交
    commit(&seed, "c.txt", "upstream\n", "upstream change");
    sh(&seed, &["push", "-q", "origin", "main"]);

    // 回传包不能在外网端导入
    assert!(sync::import_in(&g, &back.2, &extm, false).is_err());

    let ib = sync::import_back(&g, &work, &back.2, "main", &[]).unwrap();
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

    let r = sync::import_in(&g, &incr, &extm, false).unwrap();
    assert!(!r.created);
    assert!(r.changes.iter().any(|c| c.name == "refs/heads/release"));
    sync::sync_dev_repo(&g, &ext, &extm).unwrap();
    assert_eq!(
        sh(&ext, &["rev-parse", "origin/main"]),
        sh(&upstream, &["rev-parse", "main"])
    );
    assert_eq!(sh(&ext, &["rev-parse", "origin/release"]), first);

    // 回归：origin 是活的本地镜像，可以按 ref 名 fetch 首次导入之后才出现的分支。
    // 旧实现里 origin 指向 U 盘上首个全量包，这里会报 couldn't find remote ref。
    sh(&ext, &["fetch", "origin", "release"]);

    // 重复导入同一增量包被拒绝
    let err = sync::import_in(&g, &incr, &extm, false).unwrap_err().to_string();
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
    let err = sync::import_in(&g, &fake, &extm, false).unwrap_err().to_string();
    assert!(err.contains("序号不连续"), "{err}");

    // 分支删除：镜像靠 manifest 校正，开发仓库靠 fetch --prune 跟上
    sync::import_in(&g, &incr3, &extm, false).unwrap();
    assert!(!repo::rev_exists(&g, &extm, "refs/heads/release"));
    sync::sync_dev_repo(&g, &ext, &extm).unwrap();
    assert!(!repo::rev_exists(&g, &ext, "refs/remotes/origin/release"));

    // ---------- worktree：并行开发分支 ----------
    let wt = root.join("external/wt/feature-wt");
    sync::create_branch(&g, &ext, "feature/wt", "main", Some(&wt)).unwrap();
    assert_eq!(
        repo::list_worktrees(&g, &ext).unwrap().len(),
        2,
        "主工作树 + 一个 linked worktree"
    );
    commit(&wt, "w.txt", "from worktree\n", "feat: w");
    // syncBase 写在共享 config 里，主仓库读得到
    assert_eq!(
        repo::get_sync_base(&g, &ext, "feature/wt").as_deref(),
        Some("main")
    );
    // 分支表标出它在哪个 worktree
    let st = repo::status(&g, &ext, "main", &[]).unwrap();
    let wb = st.branches.iter().find(|b| b.name == "feature/wt").unwrap();
    assert_same_path(wb.worktree.as_deref(), &wt);
    // 回归：分支被 linked worktree 占用时也能 rebase。
    // 旧实现在这里 git switch 会报 already used by worktree。
    let rb = sync::rebase_onto(&g, &ext, "feature/wt", "main", false).unwrap();
    assert!(rb.ok, "{:?}", rb);
    assert_same_path(rb.worktree.as_deref(), &wt);

    // 同步开发仓库要校验 origin 指向镜像：指错仓库会 prune 掉别人的 tag
    sync::sync_dev_repo(&g, &ext, &extm).unwrap();
    let err = sync::sync_dev_repo(&g, &ext, &usb).unwrap_err().to_string();
    assert!(err.contains("不是外网镜像"), "{err}");
    // 从 worktree 导出回传包，序号由镜像统一分配，不和主工作树撞号
    let w_back = exported(
        sync::export_back(&g, &ext, &extm, &["feature/wt".into()], &usb, "proj", "main", &[])
            .unwrap(),
    );
    assert!(w_back.1 > back.1, "回传序号应递增：{} > {}", w_back.1, back.1);

    // 回归：linked worktree 里卡住的 rebase 必须能被 status 发现。
    // 它的标记文件在 .git/worktrees/<name>/，只看主工作树会漏掉，
    // 界面就给不出「继续 / 中止」，用户只能去终端解决。
    commit(&wt, "a.txt", "line1\nWORKTREE\n", "conflict from worktree");
    sh(&ext, &["switch", "-q", "main"]);
    commit(&ext, "a.txt", "line1\nMAINTREE\n", "conflict from main tree");
    sh(&ext, &["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
    let rb = sync::rebase_onto(&g, &ext, "feature/wt", "main", false).unwrap();
    assert!(!rb.ok && rb.conflict, "{:?}", rb);
    let st = repo::status(&g, &ext, "main", &[]).unwrap();
    assert_eq!(st.in_progress, None, "主工作树自己没有未完成操作");
    let stuck = st
        .in_progress_trees
        .iter()
        .find(|t| same_path(Path::new(&t.path), &wt))
        .expect("卡在 linked worktree 里的 rebase 必须被 status 发现");
    assert_eq!((stuck.op.as_str(), stuck.main), ("rebase", false));
    assert_eq!(stuck.branch.as_deref(), Some("feature/wt"));
    // 中止要发到那个 worktree，发给主仓库不起作用
    assert!(sync::abort(&g, &ext).unwrap().message.contains("没有需要中止"));
    assert!(sync::abort(&g, &wt).unwrap().ok);
    assert!(repo::status(&g, &ext, "main", &[]).unwrap().in_progress_trees.is_empty());
    sh(&ext, &["update-ref", "refs/remotes/origin/main", "refs/heads/main~1"]);
    sh(&ext, &["reset", "-q", "--hard", "HEAD~1"]);

    // ---------- patch 回传 ----------
    sync::create_branch(&g, &ext, "feature/patch", "main", None).unwrap();
    commit(&ext, "e.txt", "patch me\n", "feat: e");
    commit(&ext, "f.txt", "and me\n", "feat: f");
    let (kind, _, pdir) = exported(
        sync::export_patches(&g, &ext, &extm, "feature/patch", &usb, "proj", "main", &[]).unwrap(),
    );
    assert_eq!(kind, BundleKind::Patch);
    assert_eq!(fs::read_dir(&pdir).unwrap().count(), 2);

    sh(&work, &["switch", "-q", "main"]);
    let ip = sync::import_patches(&g, &work, &pdir, "feature/patch", "main", true, None).unwrap();
    assert!(ip.ok, "{:?}", ip);
    assert_eq!(
        sync::list_commits(&g, &work, "origin/main", "feature/patch").unwrap().len(),
        2
    );

    // 补丁也能应用到独立 worktree：主工作树的当前分支不被抢走，
    // 而且主工作树脏着也不该挡住（改动落在别的目录里）
    let before_head = sh(&work, &["rev-parse", "--abbrev-ref", "HEAD"]);
    fs::write(work.join("dirty.txt"), "uncommitted\n").unwrap();
    sh(&work, &["add", "dirty.txt"]);
    let pwt = root.join("internal/wt-patch");
    let ip = sync::import_patches(
        &g,
        &work,
        &pdir,
        "feature/patch-wt",
        "main",
        false,
        Some(&pwt),
    )
    .unwrap();
    assert!(ip.ok, "{:?}", ip);
    assert_same_path(ip.worktree.as_deref(), &pwt);
    assert_eq!(
        sh(&work, &["rev-parse", "--abbrev-ref", "HEAD"]),
        before_head,
        "主工作树的当前分支不该被换掉"
    );
    assert!(pwt.join("e.txt").exists(), "补丁应落在 worktree 目录里");
    assert_eq!(
        repo::get_sync_base(&g, &work, "feature/patch-wt").as_deref(),
        Some("main")
    );
    // 脏工作树要被 status 报出来（只看主工作树以外的也一样）
    let st = repo::status(&g, &work, "main", &[]).unwrap();
    assert!(
        st.dirty_trees.iter().any(|w| same_path(Path::new(&w.path), &work)),
        "主工作树的未提交改动应出现在 dirty_trees"
    );
    sh(&work, &["worktree", "remove", "--force", pwt.to_str().unwrap()]);
    sh(&work, &["reset", "-q", "--hard"]);
    fs::remove_file(work.join("dirty.txt")).ok();

    // ---------- 冲突与中止 ----------
    sync::create_branch(&g, &ext, "feature/conflict", "main", None).unwrap();
    commit(&ext, "a.txt", "line1\nMAC\n", "mac edit");
    let (_, _, cb) = exported(
        sync::export_back(
            &g,
            &ext,
            &extm,
            &["feature/conflict".into()],
            &usb,
            "proj",
            "main",
            &[],
        )
        .unwrap(),
    );
    commit(&seed, "a.txt", "line1\nINTRANET\n", "intranet edit");
    sh(&seed, &["push", "-q", "origin", "main"]);

    sh(&work, &["switch", "-q", "main"]);
    sync::import_back(&g, &work, &cb, "main", &[]).unwrap();
    let rb = sync::rebase_onto(&g, &work, "feature/conflict", "main", true).unwrap();
    assert!(!rb.ok && rb.conflict);
    assert_eq!(rb.files, vec!["a.txt".to_string()]);
    let st = repo::status(&g, &work, "main", &[]).unwrap();
    assert_eq!(st.in_progress.as_deref(), Some("rebase"));
    // 冲突中禁止其它操作
    assert!(sync::rebase_onto(&g, &work, "feature/ai", "main", false).is_err());
    assert!(sync::abort(&g, &work).unwrap().ok);
    assert_eq!(repo::status(&g, &work, "main", &[]).unwrap().in_progress, None);

    // 已检出分支不能直接导入（主工作树）
    let err = sync::import_back(&g, &work, &cb, "main", &[]).unwrap_err().to_string();
    assert!(err.contains("已被检出"), "{err}");

    // 回归：被 linked worktree 占用的分支同样要在动手前就拦住。
    // 漏掉时 git 报 "refusing to fetch into branch ... checked out at ..."，
    // 那条消息不含 non-fast-forward/rejected，会被当成未知错误抛出，
    // 而循环里排在前面的分支已经导入了。
    sh(&work, &["switch", "-q", "main"]);
    sh(&work, &["branch", "-f", "feature/conflict", "origin/main"]);
    let iwt = root.join("internal/wt-conflict");
    sh(&work, &["worktree", "add", iwt.to_str().unwrap(), "feature/conflict"]);
    let err = sync::import_back(&g, &work, &cb, "main", &[]).unwrap_err().to_string();
    assert!(err.contains("已被检出"), "{err}");
    assert!(err.contains("wt-conflict"), "错误里要指出分支在哪个工作树：{err}");
    sh(&work, &["worktree", "remove", iwt.to_str().unwrap()]);

    // 分叉的分支导入为新名字，不覆盖本地
    sh(&work, &["switch", "-q", "main"]);
    sh(&work, &["branch", "-f", "feature/conflict", "origin/main"]);
    let ib = sync::import_back(&g, &work, &cb, "main", &[]).unwrap();
    assert!(ib.branches[0].local.starts_with("feature/conflict-import-"));
    assert!(!ib.warnings.is_empty());

    // 更高 format 版本的包被明确拒绝，而不是按旧语义静默解读
    let future = usb.join("proj-out-0099-full.bundle");
    fs::copy(&full, &future).unwrap();
    let mut fut: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(usb.join("proj-out-0001-full.manifest.json")).unwrap(),
    )
    .unwrap();
    fut["format"] = 99.into();
    fut["seq"] = 99.into();
    fut["payload"] = "proj-out-0099-full.bundle".into();
    fut["toolVersion"] = "99.0.0".into();
    fs::write(usb.join("proj-out-0099-full.manifest.json"), fut.to_string()).unwrap();
    let err = sync::import_in(&g, &future, &extm, true).unwrap_err().to_string();
    assert!(err.contains("格式版本"), "{err}");
    assert!(err.contains("99.0.0"), "错误里要指出是哪个版本生成的：{err}");
    fs::remove_file(usb.join("proj-out-0099-full.manifest.json")).unwrap();
    fs::remove_file(&future).unwrap();

    // 包列表
    let pkgs = sync::list_packages(&usb).unwrap();
    assert!(pkgs.len() >= 7);
    assert!(pkgs.iter().all(|p| p.manifest.is_some()));
}

/// 发布分支：从 release/1.0 拉 hotfix，基准随回传包传到内网，按发布分支 rebase；
/// 没有记录时按前缀推断；改基准时只搬运分支自己的提交。
#[test]
fn release_hotfix_round_trip() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    let root = if cfg!(windows) {
        tmp.path().to_path_buf()
    } else {
        tmp.path().canonicalize().unwrap()
    };
    isolate_git_env(&root);

    let log = |e: LogEvent| eprintln!("[{:?}] {}", e.kind, e.text);
    let g = Git::new(None, &log);
    let releases: Vec<String> = vec!["release/1.0".into(), "release/2.0".into()];

    // ---------- GitLab：main 与两个发布分支已分叉 ----------
    let upstream = root.join("gitlab/project.git");
    fs::create_dir_all(&upstream).unwrap();
    sh(&upstream, &["init", "-q", "--bare", "-b", "main"]);
    let seed = root.join("seed");
    sh(&root, &["clone", "-q", upstream.to_str().unwrap(), "seed"]);
    commit(&seed, "a.txt", "v1\n", "init");
    sh(&seed, &["switch", "-q", "-c", "release/1.0"]);
    commit(&seed, "r1.txt", "r1\n", "release 1.0 fix");
    sh(&seed, &["switch", "-q", "main"]);
    commit(&seed, "m.txt", "m1\n", "main work");
    sh(&seed, &["switch", "-q", "-c", "release/2.0"]);
    commit(&seed, "r2.txt", "r2\n", "release 2.0 fix");
    sh(&seed, &["switch", "-q", "main"]);
    commit(&seed, "m.txt", "m1\nm2\n", "more main work");
    sh(&seed, &["push", "-q", "origin", "main", "release/1.0", "release/2.0"]);

    let mirror = root.join("internal/project.git");
    let work = root.join("internal/work");
    let usb = root.join("usb");
    sync::init_mirror(&g, upstream.to_str().unwrap(), &mirror).unwrap();
    sh(&root, &["clone", "-q", upstream.to_str().unwrap(), "internal/work"]);
    let (_, _, full) =
        exported(sync::export_out(&g, &mirror, &usb, "proj", "main", true, false).unwrap());

    let extm = root.join("external/mirror.git");
    let ext = root.join("external/proj");
    sync::import_in(&g, &full, &extm, false).unwrap();
    sync::create_dev_repo(&g, &extm, &ext, "Dev Mac", "dev@corp.example").unwrap();

    // ---------- 外网：从 release/1.0 拉 hotfix，基准被记录 ----------
    sync::create_branch(&g, &ext, "hotfix/login", "release/1.0", None).unwrap();
    assert_eq!(
        repo::get_sync_base(&g, &ext, "hotfix/login").as_deref(),
        Some("release/1.0")
    );
    commit(&ext, "h.txt", "hotfix\n", "fix: login");

    let st = repo::status(&g, &ext, "main", &releases).unwrap();
    let hb = st.branches.iter().find(|b| b.name == "hotfix/login").unwrap();
    assert_eq!((hb.base.as_str(), hb.base_inferred), ("release/1.0", false));
    assert_eq!((hb.ahead, hb.behind), (1, 0));

    let (_, _, back) = exported(
        sync::export_back(
            &g,
            &ext,
            &extm,
            &["hotfix/login".into()],
            &usb,
            "proj",
            "main",
            &releases,
        )
        .unwrap(),
    );
    let m: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(back.with_extension("manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(m["refs"][0]["base"], "release/1.0");

    // ---------- 内网：导入后基准写入工作仓库，只列出 hotfix 自己的提交 ----------
    sh(&seed, &["switch", "-q", "release/1.0"]);
    commit(&seed, "r1.txt", "r1\nr1b\n", "release 1.0 another fix");
    sh(&seed, &["push", "-q", "origin", "release/1.0"]);

    sh(&work, &["fetch", "-q", "origin"]);
    let ib = sync::import_back(&g, &work, &back, "main", &releases).unwrap();
    assert_eq!(ib.branches[0].base, "release/1.0");
    assert_eq!(ib.branches[0].commits.len(), 1, "{:?}", ib.branches[0].commits);
    assert_eq!(
        repo::get_sync_base(&g, &work, "hotfix/login").as_deref(),
        Some("release/1.0")
    );

    let rb = sync::rebase_onto(&g, &work, "hotfix/login", "release/1.0", true).unwrap();
    assert!(rb.ok, "{:?}", rb);
    let st = repo::status(&g, &work, "main", &releases).unwrap();
    let hb = st.branches.iter().find(|b| b.name == "hotfix/login").unwrap();
    assert_eq!((hb.ahead, hb.behind), (1, 0));
    // 没有带上 main 的提交
    assert!(!work.join("m.txt").exists());
    sync::push_branch(&g, &work, "hotfix/login", false).unwrap();
    assert!(!sh(&upstream, &["rev-parse", "refs/heads/hotfix/login"]).is_empty());

    // ---------- 没有记录时按前缀推断 ----------
    sh(&ext, &["switch", "-q", "-c", "hotfix/infer", "origin/release/2.0"]);
    commit(&ext, "i.txt", "i\n", "fix: infer");
    sh(&ext, &["switch", "-q", "-c", "feature/infer", "origin/main"]);
    let st = repo::status(&g, &ext, "main", &releases).unwrap();
    let find = |n: &str| st.branches.iter().find(|b| b.name == n).unwrap().clone();
    let hi = find("hotfix/infer");
    assert_eq!((hi.base.as_str(), hi.base_inferred), ("release/2.0", true));
    assert_eq!(find("feature/infer").base, "main");

    // 前缀不匹配只提示，不阻止：从 main 拉 hotfix 也能创建
    sync::create_branch(&g, &ext, "hotfix/from-main", "main", None).unwrap();

    // ---------- 改基准：release/1.0 → main，只搬运分支自己的提交 ----------
    sh(&work, &["switch", "-q", "main"]);
    let rb = sync::rebase_onto(&g, &work, "hotfix/login", "main", false).unwrap();
    assert!(rb.ok, "{:?}", rb);
    assert_eq!(
        sync::list_commits(&g, &work, "origin/main", "hotfix/login").unwrap().len(),
        1
    );
    assert!(!work.join("r1.txt").exists());
    assert_eq!(
        repo::get_sync_base(&g, &work, "hotfix/login").as_deref(),
        Some("main")
    );
}
