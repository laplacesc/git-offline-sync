//! 小型状态文件的原子替换、备份和镜像级进程间互斥。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Serialize};

use super::error::{Result, SyncError};

/// 临时文件必须和目标在同一目录，才能跨平台原子替换。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| SyncError::Io(e.error))?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".bak");
    PathBuf::from(name)
}

/// 只备份有效 JSON。损坏文件不得覆盖上一次可恢复备份。
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    match fs::read(path) {
        Ok(previous) => {
            if serde_json::from_slice::<serde_json::Value>(&previous).is_ok() {
                atomic_write(&backup_path(path), &previous)?;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    atomic_write(path, &bytes)
}

/// 不自动回退同步序号：使用旧备份可能使已发布的包重号。
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|e| {
        let backup = backup_path(path);
        let recovery = if backup.exists() {
            format!(
                "；可恢复备份位于 {}，请先核对已传输包的序号再恢复",
                backup.display()
            )
        } else {
            String::new()
        };
        SyncError::Invalid(format!("状态文件损坏：{}：{e}{recovery}", path.display()))
    })
}

/// 锁放在仓库的同级目录，避免首次 clone 时目标被锁文件变成非空。
/// 锁文件保留，锁由操作系统随句柄/进程退出释放，不能删除后重建绕过活跃锁。
pub struct OperationLock {
    _file: File,
}

impl OperationLock {
    pub fn acquire(directory: &Path) -> Result<Self> {
        let directory = if directory.exists() {
            directory.canonicalize()?
        } else {
            let absolute = std::path::absolute(directory)?;
            let parent = absolute
                .parent()
                .ok_or_else(|| SyncError::Invalid("仓库目录无父目录".into()))?;
            fs::create_dir_all(parent)?;
            parent.canonicalize()?.join(
                absolute
                    .file_name()
                    .ok_or_else(|| SyncError::Invalid("仓库目录无名称".into()))?,
            )
        };
        let parent = directory
            .parent()
            .ok_or_else(|| SyncError::Invalid("仓库目录无父目录".into()))?;
        let mut name = std::ffi::OsString::from(".");
        name.push(
            directory
                .file_name()
                .ok_or_else(|| SyncError::Invalid("仓库目录无名称".into()))?,
        );
        name.push(".offline-sync.lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(parent.join(name))?;
        file.try_lock().map_err(|e| {
            SyncError::Invalid(format!(
                "无法锁定仓库 {}，可能有另一个同步实例正在操作：{e}",
                directory.display()
            ))
        })?;
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_atomically_and_retains_previous_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        write_json(&path, &serde_json::json!({"seq": 1})).unwrap();
        write_json(&path, &serde_json::json!({"seq": 2})).unwrap();
        assert_eq!(read_json::<serde_json::Value>(&path).unwrap()["seq"], 2);
        assert_eq!(
            read_json::<serde_json::Value>(&backup_path(&path)).unwrap()["seq"],
            1
        );
        fs::write(&path, b"{").unwrap();
        let err = read_json::<serde_json::Value>(&path)
            .unwrap_err()
            .to_string();
        assert!(err.contains("state.json.bak"));
        write_json(&path, &serde_json::json!({"seq": 3})).unwrap();
        assert_eq!(
            read_json::<serde_json::Value>(&backup_path(&path)).unwrap()["seq"],
            1
        );
    }

    #[test]
    fn lock_excludes_other_handles_and_releases_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let lock = OperationLock::acquire(&repo).unwrap();
        assert!(!repo.exists());
        assert!(OperationLock::acquire(&repo).is_err());
        drop(lock);
        assert!(OperationLock::acquire(&repo).is_ok());
    }

    #[test]
    fn failed_replace_does_not_damage_destination() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("not-a-file");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), "untouched").unwrap();
        assert!(atomic_write(&target, b"new").is_err());
        assert_eq!(
            fs::read_to_string(target.join("keep")).unwrap(),
            "untouched"
        );
    }
}
