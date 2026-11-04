# Git 离线同步（git-offline-sync）

在只能访问内网 GitLab 的机器与外网开发机之间，通过 U 盘传递 Git Bundle 或 Patch。支持 Windows 和 macOS，使用 Rust + Tauri v2 + React + shadcn/ui。

当前版本：**2.1.13**。安装包见 [Releases](https://github.com/laplacesc/git-offline-sync/releases)，开发约定见 [AGENTS.md](AGENTS.md)。

## 安装

两端均需安装 Git ≥ 2.36；若不在 PATH 中，可在应用“设置”中指定 Git 可执行文件。

- **Windows**：离线机器选择 `*-with-webview2.exe`，内含 WebView2 离线安装包；已有 WebView2 可选择体积较小的 `*-no-webview2.exe`。
- **macOS**：使用 Universal `.dmg`。未签名安装包首次打开时，需右键选择“打开”。
- 应用支持检查、下载和安装更新；内网机器可在外网下载安装包后拷贝安装。

## 使用流程

新建同步配置，两端使用一致的项目标识、主线和发布分支，并分别填写本机的传输目录。内网配置 GitLab 地址、镜像目录和已克隆的工作仓库；外网配置镜像目录和开发仓库目录。镜像与工作／开发仓库使用不同目录。

| 步骤 | 操作 |
|---|---|
| 内网导出 | 首次“建立镜像”，再“导出更新”；首次生成全量包，后续按变化生成增量包或全量包 |
| 外网导入 | 将包及其 `*.manifest.json` 一起拷入传输目录，点击“导入更新”，只更新外网镜像 |
| 外网开发 | 单独点击“同步开发仓库”，从镜像克隆或获取引用，再在本地分支上开发并提交 |
| 外网回传 | 在“回传提交”选择分支，导出 Bundle（可多分支）或 Patch（单分支） |
| 内网接收 | 在“导入回传”接收包，检查本地分支；按需 Rebase，核对推送确认后推送到 GitLab |

外网镜像是裸仓库，可供多个开发仓库共用。开发仓库以镜像为 `origin`，同步只更新远程跟踪引用和标签，保留本地工作分支、暂存区及未提交内容。导入更新后不会自动同步开发仓库。

包列表默认展示最新 5 个，展开后每页 20 个，搜索覆盖全部包。分支列表提供新建分支、worktree、提交身份、Rebase 和删除；内网还可检查并推送。底部“查看记录”展示 Git 命令及输出。

## 分支与回传规则

- `feature/`、`bugfix/` 默认基于主线，`hotfix/` 基于发布分支。已记录的基准随回传包传递；没有记录时按前缀推断并在列表标记。可通过 Rebase 更改基准。
- Bundle 导入只接收本地分支，不自动 fetch、切换工作区或 Rebase。同名分支可快进时更新，分叉时使用 `<原名>-import-<序号>`；目标被工作树占用或备用名称已有不同内容时拒绝更新。同包重导不会覆盖之后的本地修改。
- Patch 在现有内网工作仓库通过 `git am --3way` 应用，成功后按内容记录，重复导入不会再次应用。导出范围含合并提交时需改用 Bundle。
- 未提交修改会在关联分支行标记；无关联分支或不在列表中的工作树不显示提醒。有未提交修改或未完成的 Rebase/Patch 操作时，禁止 Rebase 和导入 Patch。

## 安全与恢复

- 只导入可信来源的包。当前使用 format 1，导入会核对清单、仓库身份、序号、引用及对象；这些校验不提供数字签名认证。增量序号必须连续，全量跳号需确认引用影响。
- 镜像导入通过带旧值检查的引用事务同步分支和标签，可能包含回退或删除。禁止从镜像推送；外网开发仓库的 push 地址也被禁用，推送在内网工作仓库执行。
- 推送确认绑定源提交、最终远程地址、目标引用和远程旧提交。普通推送也使用显式 lease，非快进更新需另行确认；推送后核验远程结果，无法核实时显示未知结果。
- “请求停止”会等待原操作结束，单条 Git 命令默认最多运行 30 分钟。停止或超时不等于回滚，已完成的导入、写入或推送可能仍然生效；操作结束后界面重新读取实际状态。
- 冲突可在对应工作树解决并 `git add` 后点击“继续”，或点击“中止”。不要删除工作树 Git 目录中的 `offline-sync-rebase.json` 恢复记录来跳过未完成操作。
- 界面配置路径可在“设置”查看；同步状态保存在镜像的 `offline-sync/state.json`。合法 JSON 写入时保留 `.bak`；损坏状态不会自动回退，恢复前需核对已传输包的序号。
- 中断导出会在下一次导出时恢复原包和原序号。不要手动删除 `.offline-sync-export-*` 暂存目录、`offline-sync/export-pending.json` 或包旁的 `.pending` 标记，也不要删除 `.<目录名>.offline-sync.lock` 来绕过运行中的实例。

日志和界面会隐藏 URL 中的凭据及常见令牌参数，但不检测任意秘密；分享前仍需检查提交信息和路径。若遇到仅大小写不同的分支导致引用锁冲突，应先处理上游命名冲突，或备份后使用支持 reftable 的 Git 迁移引用存储。

## 开发与验证

需要 Node ≥ 22.13、pnpm 11.5.0、Rust stable 和对应平台的 Tauri v2 构建环境。

```bash
pnpm install
```

```bash
pnpm tauri dev
```

前端与版本检查：

```bash
pnpm test && pnpm build && pnpm check:version
```

涉及 Rust 的变更还需执行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
```

模拟 IPC 的浏览器验证不能替代 Windows/macOS 原生应用验收。

## 打包与发布

在目标系统构建，Windows 安装包需在 Windows 上生成：

```bash
pnpm tauri build
```

[build 工作流](.github/workflows/build.yml)在 Windows/macOS 上运行检查。手动触发可生成 Artifacts；推送 `v<版本>` 标签会打包并发布，带 `-` 的标签作为预发布。

发布前需准备 `docs/releases/v<版本>.md`，并确保 package、Cargo、Tauri 与标签版本一致。发布脚本核对安装包、更新归档、签名格式和说明，上传草稿并下载核对 SHA-256，全部通过后公开；失败保留草稿供重试，不覆盖已公开的 Release。
