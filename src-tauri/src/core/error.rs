use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("找不到或无法执行 git：{0}")]
    GitNotFound(String),

    #[error("git 命令失败（退出码 {code}）：{cmd}\n{stderr}")]
    Git {
        cmd: String,
        code: i32,
        stderr: String,
    },

    #[error("{0}")]
    Invalid(String),

    #[error("已停止 Git 操作。仓库可能保留已完成的更改或未完成的 rebase/am；请刷新检查，必要时继续或中止。")]
    Cancelled,

    #[error("Git 操作超过 {0} 秒，已停止。请检查网络和仓库状态后重试。")]
    TimedOut(u64),

    #[error("文件读写失败：{0}")]
    Io(#[from] std::io::Error),

    #[error("JSON 解析失败：{0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, SyncError>;

pub fn invalid<T>(msg: impl Into<String>) -> Result<T> {
    Err(SyncError::Invalid(msg.into()))
}
