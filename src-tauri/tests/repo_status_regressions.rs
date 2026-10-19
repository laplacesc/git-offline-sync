//! 仓库状态查询的真实 Git 回归，独立于同步和审查流程。
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use git_offline_sync_lib::args;
use git_offline_sync_lib::core::git::{Git, LogEvent};
use git_offline_sync_lib::core::repo;

fn git_output(dir: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args(["-c", "commit.gpgsign=false", "-c", "core.hooksPath="])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .expect("run real git")
}

fn git(dir: &Path, args: &[&str]) {
    let out = git_output(dir, args);
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    main: PathBuf,
}

impl Fixture {
    fn new(main_name: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = if cfg!(windows) {
            temp.path().to_path_buf()
        } else {
            temp.path().canonicalize().unwrap()
        };
        let main = root.join(main_name);
        fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["config", "user.name", "Tester"]);
        git(&main, &["config", "user.email", "tester@example.com"]);
        git(&main, &["config", "core.excludesFile", ""]);
        fs::write(main.join("tracked.txt"), "base\n").unwrap();
        fs::write(main.join(".gitignore"), "ignored.txt\nignored-dir/\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-qm", "initial"]);
        Self {
            _temp: temp,
            root,
            main,
        }
    }

    fn linked(&self, name: &str, branch: &str) -> PathBuf {
        let linked = self.root.join(name);
        git(
            &self.main,
            &["worktree", "add", "-b", branch, linked.to_str().unwrap()],
        );
        linked
    }
}

fn assert_path(actual: &str, expected: &Path) {
    #[cfg(unix)]
    assert_eq!(
        actual,
        expected.to_str().unwrap(),
        "path must remain byte-for-byte intact"
    );
    #[cfg(not(unix))]
    assert_eq!(
        Path::new(actual).canonicalize().unwrap(),
        expected.canonicalize().unwrap()
    );
}

fn check_list(main_name: &str, names: &[&str]) {
    let f = Fixture::new(main_name);
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let paths: Vec<_> = names
        .iter()
        .enumerate()
        .map(|(i, name)| f.linked(name, &format!("topic-{i}")))
        .collect();
    for query_dir in std::iter::once(&f.main).chain(paths.iter()) {
        let trees = repo::list_worktrees(&g, query_dir).unwrap();
        assert_eq!(trees.len(), paths.len() + 1);
        assert_path(&trees[0].path, &f.main);
        assert!(trees[0].main);
        assert!(!trees[0].bare);
        assert_eq!(trees[0].branch.as_deref(), Some("main"));
        assert!(repo::linked_worktree_for(&g, query_dir, "main").is_none());
        for (i, path) in paths.iter().enumerate() {
            let branch = format!("topic-{i}");
            let tree = trees
                .iter()
                .find(|w| w.branch.as_deref() == Some(branch.as_str()))
                .unwrap();
            assert_path(&tree.path, path);
            assert!(!tree.main);
            assert!(!tree.bare);
            let found = repo::linked_worktree_for(&g, query_dir, &branch).unwrap();
            assert_path(&found.path, path);
        }
    }
}

#[test]
fn lists_spaces_and_chinese_paths_from_main_and_linked_worktrees() {
    check_list("主 仓库", &["普通 中文工作树", "another linked tree"]);
}

#[cfg(unix)]
#[test]
fn preserves_trailing_spaces_newlines_tabs_and_crlf_in_paths() {
    check_list(
        "主 仓库  ",
        &[
            "尾空格  ",
            "换行\n工作树\n",
            "制表\t工作树\t",
            "CRLF\r\n工作树",
        ],
    );
}

#[cfg(unix)]
#[test]
fn nul_query_preserves_git_stdout_exactly() {
    let f = Fixture::new("main");
    f.linked("原样\r\n制表\t尾空格  ", "topic");
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let expected = git_output(&f.main, &["worktree", "list", "--porcelain", "-z"]);
    assert!(expected.status.success());
    let actual = g
        .query(&f.main, args!["worktree", "list", "--porcelain", "-z"])
        .unwrap();
    assert_eq!(actual.as_bytes(), expected.stdout);
}

#[test]
fn detects_untracked_files_in_main_and_linked_but_not_ignored_files() {
    let f = Fixture::new("主 仓库");
    let linked = f.linked("linked 中文 工作树", "topic");
    // Explicit status flags must override a user/repository preference to hide untracked files.
    git(&f.main, &["config", "status.showUntrackedFiles", "no"]);
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    for path in [&f.main, &linked] {
        fs::write(path.join("ignored.txt"), "ignored\n").unwrap();
        fs::create_dir(path.join("ignored-dir")).unwrap();
        fs::write(path.join("ignored-dir/nested.txt"), "ignored\n").unwrap();
    }
    assert!(repo::dirty_worktrees(&g, &f.main).is_empty());
    for (path, main) in [(&f.main, true), (&linked, false)] {
        let untracked = path.join("未跟踪 文件.txt");
        fs::write(&untracked, "untracked\n").unwrap();
        for query_dir in [&f.main, &linked] {
            let dirty = repo::dirty_worktrees(&g, query_dir);
            assert_eq!(dirty.len(), 1);
            assert_path(&dirty[0].path, path);
            assert_eq!(dirty[0].main, main);
        }
        fs::remove_file(untracked).unwrap();
    }
    for path in [&f.main, &linked] {
        fs::write(path.join("untracked.txt"), "untracked\n").unwrap();
    }
    assert_eq!(repo::dirty_worktrees(&g, &f.main).len(), 2);
}

fn check_linked_conflict(name: &str) {
    let f = Fixture::new("主 仓库");
    let linked = f.linked(name, "topic");
    for (path, text) in [(&f.main, "main\n"), (&linked, "topic\n")] {
        fs::write(path.join("tracked.txt"), text).unwrap();
        git(path, &["add", "tracked.txt"]);
        git(path, &["commit", "-qm", "change"]);
    }
    let merge = git_output(&linked, &["merge", "--no-edit", "main"]);
    assert_eq!(
        merge.status.code(),
        Some(1),
        "expected a real merge conflict"
    );
    let log = |_: LogEvent| {};
    let g = Git::new(None, &log);
    let found = repo::linked_worktree_for(&g, &f.main, "topic").unwrap();
    assert_path(&found.path, &linked);
    let gd = repo::git_dir(&g, Path::new(&found.path)).unwrap();
    assert!(gd.join("MERGE_HEAD").is_file());
    assert_ne!(gd, repo::git_dir(&g, &f.main).unwrap());
    assert!(repo::in_progress(&repo::git_dir(&g, &f.main).unwrap()).is_none());
    let operations = repo::in_progress_all(&g, &f.main);
    assert_eq!(operations.len(), 1);
    assert_path(&operations[0].path, &linked);
    assert_eq!(operations[0].op, "merge");
    assert_eq!(operations[0].branch.as_deref(), Some("topic"));
    assert!(!operations[0].main);
    let dirty = repo::dirty_worktrees(&g, &f.main);
    assert_eq!(dirty.len(), 1);
    assert_path(&dirty[0].path, &linked);
    // The returned lookup directory must also be the correct merge-abort target.
    git(Path::new(&found.path), &["merge", "--abort"]);
    assert!(repo::in_progress_all(&g, &f.main).is_empty());
    assert!(repo::dirty_worktrees(&g, &f.main).is_empty());
}

#[test]
fn conflict_and_linked_lookup_target_the_correct_directory() {
    check_linked_conflict("中文 linked 工作树");
}

#[cfg(unix)]
#[test]
fn conflict_and_linked_lookup_preserve_unix_path_whitespace() {
    check_linked_conflict("冲突\n制表\t工作树  ");
}
