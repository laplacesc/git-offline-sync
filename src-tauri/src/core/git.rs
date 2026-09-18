//! 统一的 git 命令执行器。
//!
//! 所有 git 调用都经过这里：参数以数组形式传递（不经过 shell，路径含空格/中文安全），
//! 每条命令和输出都会通过 logger 回调推送给界面。

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

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
        Git { bin, log }
    }

    pub fn emit(&self, kind: LogKind, text: impl Into<String>) {
        (self.log)(LogEvent {
            kind,
            text: text.into(),
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
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
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
        format!("git {}", parts.join(" "))
    }

    /// 执行命令，不因非零退出码报错。`echo_stdout` 控制命令和 stdout 是否推送到日志。
    pub fn exec(
        &self,
        cwd: Option<&Path>,
        args: &[OsString],
        stdin: Option<&str>,
        echo_stdout: bool,
    ) -> Result<GitOutput> {
        // 查询类命令（不回显 stdout）也不记录命令本身，避免状态刷新刷满日志；
        // 失败时由 check() 记录完整命令。
        if echo_stdout {
            self.emit(LogKind::Cmd, Self::display(args));
        }

        let mut cmd = self.build(cwd, args);
        cmd.stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| SyncError::GitNotFound(e.to_string()))?;

        let input_pipe = child.stdin.take();
        let out = child.stdout.take().expect("stdout piped");
        let err = child.stderr.take().expect("stderr piped");

        // stdin 写入与 stderr 读取都放在独立线程，避免任一管道写满导致死锁
        let stderr_lines = thread::scope(|s| {
            if let (Some(mut w), Some(input)) = (input_pipe, stdin) {
                s.spawn(move || {
                    let _ = w.write_all(input.as_bytes());
                    // w 在此处 drop，关闭 stdin
                });
            }
            let err_handle = s.spawn(|| {
                let mut acc = String::new();
                for line in BufReader::new(err).lines().map_while(|l| l.ok()) {
                    self.emit(LogKind::Stderr, &line);
                    acc.push_str(&line);
                    acc.push('\n');
                }
                acc
            });
            let mut acc = String::new();
            for line in BufReader::new(out).lines().map_while(|l| l.ok()) {
                if echo_stdout {
                    self.emit(LogKind::Stdout, &line);
                }
                acc.push_str(&line);
                acc.push('\n');
            }
            (acc, err_handle.join().unwrap_or_default())
        });

        let status = child.wait()?;
        let code = status.code().unwrap_or(-1);
        let (stdout, stderr) = stderr_lines;
        Ok(GitOutput {
            code,
            stdout,
            stderr,
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
            self.emit(LogKind::Error, format!("退出码 {}：{}", out.code, Self::display(args)));
            Err(SyncError::Git {
                cmd: Self::display(args),
                code: out.code,
                stderr: out.stderr.trim().to_string(),
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
}
