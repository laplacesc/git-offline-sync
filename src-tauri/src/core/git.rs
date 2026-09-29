//! 统一的 git 命令执行器。
//!
//! 所有 git 调用都经过这里：参数以数组形式传递（不经过 shell，路径含空格/中文安全），
//! 每条命令和输出都会通过 logger 回调推送给界面。

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, LazyLock, Mutex,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::error::{Result, SyncError};

/// 以 `OsString` 数组构造 git 参数，可混用 `&str`、`String`、`Path`、`PathBuf`。
#[macro_export]
macro_rules! args {
    ($($x:expr),* $(,)?) => {
        vec![$(::std::ffi::OsString::from(&$x)),*]
    };
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogKind {
    Cmd,
    Stdout,
    Stderr,
    Info,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEvent {
    pub kind: LogKind,
    pub text: String,
    pub ts: u64,
}

pub type Logger = dyn Fn(LogEvent) + Send + Sync;

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl GitOutput {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
}

pub struct Git<'a> {
    bin: OsString,
    log: &'a Logger,
    control: Option<Arc<OperationControl>>,
    timeout: Duration,
}

/// 一个逻辑操作共享同一取消标记；后续 Git 子命令不会在取消后重新开始。
#[derive(Default)]
pub struct OperationControl {
    id: u64,
    cancelled: AtomicBool,
}

impl OperationControl {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// 应用内只允许一个变更操作，查询不占用这个槽位。
#[derive(Default, Clone)]
pub struct OperationRegistry {
    active: Arc<Mutex<Option<Arc<OperationControl>>>>,
}

pub struct OperationGuard {
    registry: OperationRegistry,
    pub control: Arc<OperationControl>,
}

impl OperationRegistry {
    pub fn start(&self) -> Result<OperationGuard> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| SyncError::Invalid("操作状态不可用".into()))?;
        if active.is_some() {
            return Err(SyncError::Invalid("另一个操作尚未结束，请稍后重试".into()));
        }
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        let control = Arc::new(OperationControl {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            cancelled: AtomicBool::new(false),
        });
        *active = Some(control.clone());
        Ok(OperationGuard {
            registry: self.clone(),
            control,
        })
    }

    pub fn active_id(&self) -> Option<u64> {
        self.active
            .lock()
            .ok()
            .and_then(|a| a.as_ref().map(|c| c.id))
    }

    pub fn cancel(&self, id: u64) -> bool {
        if let Ok(active) = self.active.lock() {
            if let Some(control) = active.as_ref().filter(|c| c.id == id) {
                control.cancel();
                return true;
            }
        }
        false
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.registry.active.lock() {
            if active
                .as_ref()
                .is_some_and(|c| Arc::ptr_eq(c, &self.control))
            {
                *active = None;
            }
        }
    }
}

/// 仅用于日志和展示；不要用脱敏后的 URL 执行 Git 或比较 origin。
pub fn redact(text: &str) -> String {
    static USERINFO: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)([a-z][a-z0-9+.-]*://)[^/\s?#'"]+@"#)
            .expect("valid userinfo regex")
    });
    static QUERY: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)([?&](?:access_token|private_token|token|password|passwd|api_key|apikey|key|auth|authorization|signature|x-amz-signature|x-amz-credential)=)[^&\s#'"]+"#).expect("valid credential regex")
    });
    let clean = USERINFO.replace_all(text, "${1}[REDACTED]@");
    QUERY.replace_all(&clean, "${1}[REDACTED]").into_owned()
}

/// Git 的凭据助手和网络传输也可能持有管道，取消时必须停止整个进程组。
fn terminate_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // SAFETY: 该 child 由本模块以独立 process_group(0) 启动，PID 为正。
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

/// Windows 的父 PID 退出后不能再靠 taskkill /T 找到后代。
/// Job 始终持有整棵进程树；先挂起创建再分配 Job，避免子进程先逃逸的竞态。
#[cfg(windows)]
mod windows_job {
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::process::Child;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    pub(super) struct Job(OwnedHandle);

    impl Job {
        pub(super) fn new() -> io::Result<Self> {
            // SAFETY: null attributes/name create an unnamed, non-inheritable Job.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: CreateJobObjectW returned a new valid owned handle.
            let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
            // SAFETY: this C struct consists entirely of integers and pointers.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: the pointer and size describe limits for the selected class.
            if unsafe {
                SetInformationJobObject(
                    job.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        pub(super) fn assign_and_resume(&self, child: &Child) -> io::Result<()> {
            // SAFETY: both handles stay owned and valid throughout the call.
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            // std::process::Child does not expose the initial thread handle.
            // CREATE_SUSPENDED ensures it cannot create other threads/processes
            // before we find its initial thread through the documented Toolhelp API.
            // SAFETY: a thread snapshot ignores the process-id argument.
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: the snapshot is a newly returned valid owned handle.
            let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
            // SAFETY: THREADENTRY32 contains only integer fields.
            let mut entry: THREADENTRY32 = unsafe { zeroed() };
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            // SAFETY: entry is initialized with the required structure size.
            if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
                return Err(io::Error::last_os_error());
            }
            loop {
                if entry.th32OwnerProcessID == child.id() {
                    // SAFETY: request only the permission needed to resume this thread.
                    let thread =
                        unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                    if thread.is_null() {
                        return Err(io::Error::last_os_error());
                    }
                    // SAFETY: OpenThread returned a new valid owned handle.
                    let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
                    // SAFETY: this is the initial thread of our suspended process.
                    let previous_count = unsafe { ResumeThread(thread.as_raw_handle()) };
                    if previous_count == u32::MAX {
                        return Err(io::Error::last_os_error());
                    }
                    if previous_count != 1 {
                        return Err(io::Error::other(
                            "Git initial thread had an unexpected suspend count",
                        ));
                    }
                    return Ok(());
                }
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                // SAFETY: snapshot and initialized output entry remain valid.
                if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
                    return Err(io::Error::other(
                        "Cannot find the suspended Git process thread",
                    ));
                }
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl<'a> Git<'a> {
    pub fn new(bin: Option<&str>, log: &'a Logger) -> Self {
        let bin = match bin {
            Some(b) if !b.trim().is_empty() => OsString::from(b.trim()),
            _ => OsString::from("git"),
        };
        Git {
            bin,
            log,
            control: None,
            timeout: Duration::from_secs(30 * 60),
        }
    }

    pub fn with_control(mut self, control: Arc<OperationControl>) -> Self {
        self.control = Some(control);
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn emit(&self, kind: LogKind, text: impl Into<String>) {
        (self.log)(LogEvent {
            kind,
            text: redact(&text.into()),
            ts: now_ms(),
        });
    }

    pub fn info(&self, text: impl Into<String>) {
        self.emit(LogKind::Info, text);
    }

    fn build(&self, cwd: Option<&Path>, args: &[OsString]) -> Command {
        let mut cmd = Command::new(&self.bin);
        // 统一输出格式：中文路径不转义、不输出颜色
        cmd.args(["-c", "core.quotepath=false", "-c", "color.ui=never"]);
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        // 没有终端可供交互：凭据提示直接失败而不是挂起（GUI 凭据管理器仍可用）
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd
    }

    fn display(args: &[OsString]) -> String {
        let parts: Vec<String> = args
            .iter()
            .map(|a| {
                let s = a.to_string_lossy();
                if s.is_empty() || s.contains(char::is_whitespace) {
                    format!("\"{s}\"")
                } else {
                    s.into_owned()
                }
            })
            .collect();
        redact(&format!("git {}", parts.join(" ")))
    }

    /// 执行命令，不因非零退出码报错。`echo_stdout` 控制命令和 stdout 是否推送到日志。
    pub fn exec(
        &self,
        cwd: Option<&Path>,
        args: &[OsString],
        stdin: Option<&str>,
        echo_stdout: bool,
    ) -> Result<GitOutput> {
        if self.control.as_ref().is_some_and(|c| c.is_cancelled()) {
            return Err(SyncError::Cancelled);
        }
        if echo_stdout {
            self.emit(LogKind::Cmd, Self::display(args));
        }
        self.exec_command(self.build(cwd, args), stdin, echo_stdout)
    }

    fn exec_command(
        &self,
        mut cmd: Command,
        stdin: Option<&str>,
        echo_stdout: bool,
    ) -> Result<GitOutput> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        }
        #[cfg(windows)]
        let mut job = Some(windows_job::Job::new()?);
        cmd.stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| SyncError::GitNotFound(redact(&e.to_string())))?;
        #[cfg(windows)]
        if let Err(error) = job.as_ref().expect("job created").assign_and_resume(&child) {
            // Never return with a suspended child alive, even if Job assignment failed.
            drop(job.take());
            let _ = child.kill();
            let _ = child.wait();
            return Err(SyncError::Io(error));
        }
        let input_pipe = child.stdin.take();
        let out = child.stdout.take().expect("stdout piped");
        let err = child.stderr.take().expect("stderr piped");
        let started = Instant::now();

        thread::scope(|scope| {
            let input = match (input_pipe, stdin) {
                (Some(mut pipe), Some(bytes)) => {
                    Some(scope.spawn(move || pipe.write_all(bytes.as_bytes())))
                }
                _ => None,
            };
            let stdout = scope.spawn(|| -> std::io::Result<String> {
                let mut acc = String::new();
                for line in BufReader::new(out).lines() {
                    let line = line?;
                    if echo_stdout {
                        self.emit(LogKind::Stdout, &line);
                    }
                    acc.push_str(&line);
                    acc.push('\n');
                }
                Ok(acc)
            });
            let stderr = scope.spawn(|| -> std::io::Result<String> {
                let mut acc = String::new();
                for line in BufReader::new(err).lines() {
                    let line = line?;
                    self.emit(LogKind::Stderr, &line);
                    acc.push_str(&redact(&line));
                    acc.push('\n');
                }
                Ok(acc)
            });
            let mut status = None;
            let mut interrupted = None;
            loop {
                if status.is_none() {
                    match child.try_wait() {
                        Ok(s) => status = s,
                        Err(e) => {
                            interrupted = Some(SyncError::Io(e));
                            break;
                        }
                    }
                }
                if status.is_some()
                    && stdout.is_finished()
                    && stderr.is_finished()
                    && input.as_ref().is_none_or(|h| h.is_finished())
                {
                    break;
                }
                if self.control.as_ref().is_some_and(|c| c.is_cancelled()) {
                    interrupted = Some(SyncError::Cancelled);
                    break;
                }
                let elapsed = started.elapsed();
                if elapsed >= self.timeout {
                    interrupted = Some(SyncError::TimedOut(self.timeout.as_secs()));
                    break;
                }
                // Short status/ref queries should not each pay a 10 ms floor.
                let poll_ms = if elapsed < Duration::from_millis(100) {
                    1
                } else {
                    10
                };
                thread::sleep(Duration::from_millis(poll_ms));
            }
            if interrupted.is_some() {
                // Closing the last Job handle kills descendants even if Git itself
                // already exited; do this before joining any inherited pipe reader.
                #[cfg(windows)]
                drop(job.take());
                terminate_tree(&mut child);
                let _ = child.wait();
            }
            let out_result = stdout.join();
            let err_result = stderr.join();
            let input_result = input.map(|h| h.join());
            if let Some(error) = interrupted {
                return Err(error);
            }
            let join_error = || SyncError::Invalid("读取 Git 输出的线程异常退出".into());
            let stdout = out_result.map_err(|_| join_error())??;
            let stderr = err_result.map_err(|_| join_error())??;
            let status = status.ok_or_else(|| SyncError::Invalid("Git 未返回退出状态".into()))?;
            // Git 自身失败时保留原 stderr；成功时不能忽略提交脚本未完整写入。
            if status.success() {
                if let Some(result) = input_result {
                    result.map_err(|_| join_error())??;
                }
            }
            Ok(GitOutput {
                code: status.code().unwrap_or(-1),
                stdout,
                stderr,
            })
        })
    }

    /// 执行命令，非零退出码视为错误；stdout 推送到日志。
    pub fn run(&self, cwd: &Path, args: Vec<OsString>) -> Result<String> {
        let out = self.exec(Some(cwd), &args, None, true)?;
        self.check(&args, out)
    }

    /// 查询类命令：stdout 不推送到日志（避免刷屏），非零即错误。
    pub fn query(&self, cwd: &Path, args: Vec<OsString>) -> Result<String> {
        let out = self.exec(Some(cwd), &args, None, false)?;
        self.check(&args, out)
    }

    pub fn query_stdin(&self, cwd: &Path, args: Vec<OsString>, input: &str) -> Result<String> {
        let out = self.exec(Some(cwd), &args, Some(input), false)?;
        self.check(&args, out)
    }

    /// 在无工作目录（比如 clone）时执行。
    pub fn run_nocwd(&self, args: Vec<OsString>) -> Result<String> {
        let out = self.exec(None, &args, None, true)?;
        self.check(&args, out)
    }

    fn check(&self, args: &[OsString], out: GitOutput) -> Result<String> {
        if out.ok() {
            Ok(out.stdout)
        } else {
            self.emit(
                LogKind::Error,
                format!("退出码 {}：{}", out.code, Self::display(args)),
            );
            Err(SyncError::Git {
                cmd: Self::display(args),
                code: out.code,
                stderr: redact(out.stderr.trim()),
            })
        }
    }

    /// 返回 (major, minor, 原始字符串)。
    pub fn version(&self) -> Result<(u32, u32, String)> {
        let out = self.exec(None, &args!["--version"], None, false)?;
        let raw = out.stdout.trim().to_string();
        if !out.ok() {
            return Err(SyncError::GitNotFound(format!(
                "{} {}",
                raw,
                out.stderr.trim()
            )));
        }
        parse_version(&raw)
            .map(|(a, b)| (a, b, raw.clone()))
            .ok_or_else(|| SyncError::GitNotFound(format!("无法解析版本: {raw}")))
    }
}

pub fn parse_version(raw: &str) -> Option<(u32, u32)> {
    // "git version 2.43.0.windows.1" / "git version 2.54.0 (Apple Git-157)"
    let v = raw.split_whitespace().nth(2)?;
    let mut it = v.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("git version 2.43.0.windows.1"), Some((2, 43)));
        assert_eq!(
            parse_version("git version 2.54.0 (Apple Git-157)"),
            Some((2, 54))
        );
        assert_eq!(parse_version("garbage"), None);
    }

    #[test]
    fn redacts_credentials_but_retains_diagnostic_context() {
        let text = "clone 'https://user:my-secret@example.test/team/repo?access_token=other-secret&branch=main' ssh://name:pass@example.test/repo";
        let clean = redact(text);
        for secret in ["user:", "my-secret", "other-secret", "name:pass"] {
            assert!(!clean.contains(secret), "{clean}");
        }
        assert!(clean.contains("example.test/team/repo"));
        assert!(clean.contains("branch=main"));
        assert_eq!(redact("git@host:group/repo.git"), "git@host:group/repo.git");
        assert_eq!(
            redact("https://host/repo?X-Amz-Signature=secret#end"),
            "https://host/repo?X-Amz-Signature=[REDACTED]#end"
        );
    }

    #[test]
    fn cancellation_is_bound_to_an_operation_and_slot_lives_until_drop() {
        let registry = OperationRegistry::default();
        let first = registry.start().unwrap();
        let old_id = registry.active_id().unwrap();
        assert!(registry.cancel(old_id));
        assert!(first.control.is_cancelled());
        assert!(registry.start().is_err());
        drop(first);
        let second = registry.start().unwrap();
        assert!(!registry.cancel(old_id));
        assert!(!second.control.is_cancelled());
    }

    #[cfg(unix)]
    fn fake_git(script: &str) -> (tempfile::TempDir, String) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("git-fixture");
        std::fs::write(&bin, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = bin.to_string_lossy().into_owned();
        (dir, path)
    }

    #[cfg(unix)]
    #[test]
    fn every_log_and_error_redacts_echoed_credentials() {
        let (_dir, bin) = fake_git("echo \"$@\" >&2; exit 1");
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let logger = move |e: LogEvent| captured.lock().unwrap().push(e.text);
        let git = Git::new(Some(&bin), &logger);
        let error = git
            .run_nocwd(args![
                "clone",
                "https://user:secret123@example.test/repo?token=secret456"
            ])
            .unwrap_err();
        let text = format!("{}\n{}", error, events.lock().unwrap().join("\n"));
        assert!(!text.contains("secret123"));
        assert!(!text.contains("secret456"));
        assert!(text.contains("example.test/repo"));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_stops_process_tree_holding_pipes_open() {
        let (_dir, bin) = fake_git("sleep 30 & wait");
        let logger = |_: LogEvent| {};
        let git = Git::new(Some(&bin), &logger).with_timeout(Duration::from_millis(100));
        let start = Instant::now();
        assert!(matches!(
            git.exec(None, &[], None, false),
            Err(SyncError::TimedOut(_))
        ));
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_stops_descendant_after_parent_exits() {
        let (_dir, bin) = fake_git("sleep 30 &\nexit 0");
        let logger = |_: LogEvent| {};
        let git = Git::new(Some(&bin), &logger).with_timeout(Duration::from_millis(100));
        let start = Instant::now();
        assert!(matches!(
            git.exec(None, &[], None, false),
            Err(SyncError::TimedOut(_))
        ));
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    // The unit-test executable doubles as a portable Windows process fixture.
    // The parent exits immediately; its descendant keeps the inherited pipes open.
    #[cfg(windows)]
    fn windows_fixture_command(directory: &Path, mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "core::git::tests::windows_pipe_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("OFFLINE_SYNC_PIPE_FIXTURE", mode)
            .env("OFFLINE_SYNC_PIPE_DIRECTORY", directory);
        command
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess fixture, launched by Windows process-tree tests"]
    fn windows_pipe_fixture() {
        let directory = std::path::PathBuf::from(
            std::env::var_os("OFFLINE_SYNC_PIPE_DIRECTORY").expect("fixture directory"),
        );
        let marker = directory.join("descendant-pid");
        match std::env::var("OFFLINE_SYNC_PIPE_FIXTURE").as_deref() {
            Ok("descendant") => {
                std::fs::write(marker, std::process::id().to_string()).unwrap();
                thread::sleep(Duration::from_secs(30));
            }
            Ok("parent") => {
                let mut child = windows_fixture_command(&directory, "descendant")
                    .stdin(Stdio::inherit())
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap();
                let start = Instant::now();
                while !marker.exists() {
                    if start.elapsed() > Duration::from_secs(10) {
                        let _ = child.kill();
                        let _ = child.wait();
                        panic!("descendant did not start");
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                std::fs::write(directory.join("parent-pid"), std::process::id().to_string())
                    .unwrap();
                // Intentionally orphan the pipe-holding descendant. The surrounding
                // Job, not this Child handle, must reap it when the deadline expires.
                std::process::exit(0);
            }
            _ => panic!("fixture must be run in a subprocess"),
        }
    }

    #[cfg(windows)]
    fn windows_process_running(id: u32) -> bool {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY: query a fixture process we created, without modifying it.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, id) };
        if handle.is_null() {
            // A vanished PID is expected; access failures must not pass as cleanup.
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(ERROR_INVALID_PARAMETER as i32)
            );
            return false;
        }
        // SAFETY: OpenProcess returned a valid owned handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut code = 0;
        // SAFETY: handle and output pointer are valid for this call.
        assert_ne!(
            unsafe { GetExitCodeProcess(handle.as_raw_handle(), &mut code) },
            0
        );
        code == STILL_ACTIVE as u32
    }

    #[cfg(windows)]
    #[test]
    fn windows_timeout_kills_orphaned_pipe_holder() {
        let directory = tempfile::tempdir().unwrap();
        let logger = |_: LogEvent| {};
        let git = Git::new(None, &logger).with_timeout(Duration::from_secs(5));
        let start = Instant::now();
        assert!(matches!(
            git.exec_command(
                windows_fixture_command(directory.path(), "parent"),
                None,
                false
            ),
            Err(SyncError::TimedOut(_))
        ));
        assert!(start.elapsed() < Duration::from_secs(15));
        let id: u32 = std::fs::read_to_string(directory.path().join("descendant-pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            !windows_process_running(id),
            "Job left its descendant running"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_cancellation_kills_orphaned_pipe_holder() {
        let directory = tempfile::tempdir().unwrap();
        let registry = OperationRegistry::default();
        let guard = registry.start().unwrap();
        let control = guard.control.clone();
        let logger = |_: LogEvent| {};
        let git = Git::new(None, &logger)
            .with_control(control.clone())
            .with_timeout(Duration::from_secs(15));
        thread::scope(|scope| {
            scope.spawn(|| {
                let start = Instant::now();
                loop {
                    if let Ok(pid) = std::fs::read_to_string(directory.path().join("parent-pid")) {
                        if let Ok(pid) = pid.parse() {
                            if !windows_process_running(pid) {
                                break;
                            }
                        }
                    }
                    assert!(
                        start.elapsed() < Duration::from_secs(10),
                        "fixture parent did not exit"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                control.cancel();
            });
            assert!(matches!(
                git.exec_command(
                    windows_fixture_command(directory.path(), "parent"),
                    None,
                    false
                ),
                Err(SyncError::Cancelled)
            ));
        });
        let id: u32 = std::fs::read_to_string(directory.path().join("descendant-pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(!windows_process_running(id));
        assert!(registry.start().is_err());
        drop(guard);
        assert!(registry.start().is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_stops_current_and_subsequent_commands() {
        let (_dir, bin) = fake_git("sleep 30 & wait");
        let logger = |_: LogEvent| {};
        let control = Arc::new(OperationControl::default());
        let git = Git::new(Some(&bin), &logger).with_control(control.clone());
        thread::scope(|s| {
            s.spawn(|| {
                thread::sleep(Duration::from_millis(100));
                control.cancel();
            });
            assert!(matches!(
                git.exec(None, &[], None, false),
                Err(SyncError::Cancelled)
            ));
        });
        let start = Instant::now();
        assert!(matches!(
            git.exec(None, &[], None, false),
            Err(SyncError::Cancelled)
        ));
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
