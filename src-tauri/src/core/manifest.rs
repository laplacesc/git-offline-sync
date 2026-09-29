//! 每个 bundle 旁边的描述文件 `<name>.manifest.json`。
//!
//! 作用：
//! - 导入前确认是同一个仓库（repo_id = 基准分支的根提交）
//! - 检查增量包序号是否连续，防止漏包/错包
//! - 记录导出时的全部分支指向，让外网端能同步"指向旧提交的新分支"和"已删除分支"

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::{invalid, Result};

pub const FORMAT: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BundleKind {
    /// 内网 → 外网，全量
    Full,
    /// 内网 → 外网，增量
    Incr,
    /// 外网 → 内网，回传 bundle
    Back,
    /// 外网 → 内网，回传 patch 目录
    Patch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RefEntry {
    pub name: String,
    pub sha: String,
    /// Back/Patch：该分支的基准分支（主线或发布分支）。旧版本的包没有这个字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub kind: BundleKind,
    pub repo_name: String,
    pub repo_id: String,
    pub seq: u32,
    pub created_at: u64,
    /// bundle 文件名或 patch 目录名（相对 manifest 所在目录）
    pub payload: String,
    pub base_branch: String,
    /// Full/Incr：导出时内网全部分支与 tag；Back/Patch：回传的分支
    pub refs: Vec<RefEntry>,
    pub tool_version: String,
}

/// `foo.bundle` → `foo.manifest.json`；目录 `foo/` → `foo.manifest.json`
pub fn manifest_path_for(payload: &Path) -> PathBuf {
    let stem = if payload.extension().is_some_and(|e| e == "bundle") {
        payload.file_stem().unwrap_or_default().to_os_string()
    } else {
        payload.file_name().unwrap_or_default().to_os_string()
    };
    let mut name = stem;
    name.push(".manifest.json");
    payload.with_file_name(name)
}

impl Manifest {
    pub fn write_for(&self, payload: &Path) -> Result<PathBuf> {
        let path = manifest_path_for(payload);
        self.validate(payload)?;
        super::storage::atomic_write(&path, &serde_json::to_vec_pretty(self)?)?;
        Ok(path)
    }

    /// manifest 不存在时返回 None（允许导入手工打的 bundle）。
    ///
    /// `format` 比本版本新时直接拒绝：字段含义可能已经变了，
    /// 按旧语义解读会静默出错，不如明确要求对端升级工具。
    pub fn read_for(payload: &Path) -> Result<Option<Manifest>> {
        let mut marker = payload.as_os_str().to_owned();
        marker.push(".pending");
        if Path::new(&marker).exists() {
            return invalid("导出尚未完成，请在导出端重试后再导入");
        }
        let path = manifest_path_for(payload);
        if !path.exists() {
            return Ok(None);
        }
        let text = fs::read_to_string(&path)?;
        let m: Manifest = serde_json::from_str(&text)?;
        if m.format > FORMAT {
            return invalid(format!(
                "这个包的格式版本是 {}，本工具只支持到 {FORMAT}。\
                 它由更新版本的工具（{}）生成，请先升级本机的 git-offline-sync",
                m.format, m.tool_version
            ));
        }
        m.validate(payload)?;
        Ok(Some(m))
    }

    /// Validate before trusting snapshot deletion instructions or constructing Git input.
    pub fn validate(&self, payload: &Path) -> Result<()> {
        if self.format != FORMAT || self.seq == 0 {
            return invalid("manifest 格式或序号无效");
        }
        if !valid_oid(&self.repo_id) {
            return invalid("manifest repoId 必须是完整 SHA");
        }
        if self.payload.is_empty()
            || self.payload == "."
            || self.payload == ".."
            || self.payload.contains(['/', '\\'])
            || self.payload.chars().any(char::is_control)
            || payload.file_name().and_then(|n| n.to_str()) != Some(self.payload.as_str())
        {
            return invalid("manifest payload 必须是当前包的文件名，不能包含路径");
        }
        if !valid_branch(&self.base_branch) || self.refs.is_empty() {
            return invalid("manifest 基准分支或引用快照无效");
        }
        let mut names = HashSet::new();
        for entry in &self.refs {
            if !valid_ref(&entry.name)
                || !valid_oid(&entry.sha)
                || entry.sha.len() != self.repo_id.len()
                || !names.insert(&entry.name)
                || entry.base.as_ref().is_some_and(|b| !valid_branch(b))
            {
                return invalid(format!("manifest 引用无效或重复：{}", entry.name));
            }
            if matches!(self.kind, BundleKind::Back | BundleKind::Patch)
                && !entry.name.starts_with("refs/heads/")
            {
                return invalid("回传 manifest 只能包含分支引用");
            }
        }
        if matches!(self.kind, BundleKind::Full | BundleKind::Incr)
            && !names.contains(&format!("refs/heads/{}", self.base_branch))
        {
            return invalid("manifest 引用快照缺少基准分支");
        }
        Ok(())
    }

    pub fn branches(&self) -> impl Iterator<Item = (&str, &str)> {
        self.refs.iter().filter_map(|r| {
            r.name
                .strip_prefix("refs/heads/")
                .map(|b| (b, r.sha.as_str()))
        })
    }

    pub fn tags(&self) -> impl Iterator<Item = (&str, &str)> {
        self.refs.iter().filter_map(|r| {
            r.name
                .strip_prefix("refs/tags/")
                .map(|t| (t, r.sha.as_str()))
        })
    }
}

pub(crate) fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value.bytes().all(|b| b.is_ascii_hexdigit())
        && value.bytes().any(|b| b != b'0')
}

pub(crate) fn valid_ref(name: &str) -> bool {
    (name.starts_with("refs/heads/") || name.starts_with("refs/tags/"))
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.contains("@{")
        && !name
            .chars()
            .any(|c| c.is_control() || c == ' ' || "~^:?*[\\".contains(c))
        && name
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

fn valid_branch(name: &str) -> bool {
    !name.starts_with('-') && name != "HEAD" && valid_ref(&format!("refs/heads/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_names() {
        assert_eq!(
            manifest_path_for(Path::new("/u/p-out-0001.bundle")),
            PathBuf::from("/u/p-out-0001.manifest.json")
        );
        assert_eq!(
            manifest_path_for(Path::new("/u/p-patch-0002-feat")),
            PathBuf::from("/u/p-patch-0002-feat.manifest.json")
        );
    }
}
