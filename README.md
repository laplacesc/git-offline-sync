# Git 离线同步（git-offline-sync）

在只能访问内网 GitLab 的机器与外网开发机之间，通过 U 盘传递 Git Bundle 或 Patch。支持 Windows 和 macOS，使用 Rust、Tauri v2、React 和 shadcn/ui。

当前版本：**2.1.17**。安装包见 [Releases](https://github.com/laplacesc/git-offline-sync/releases)。

## 安装

两端需要 Git ≥ 2.36。Git 不在 PATH 时，可在应用设置中指定可执行文件。

- Windows 首次离线安装使用 `*-with-webview2.exe`；已安装 WebView2 时使用 `*-no-webview2.exe`。
- macOS 使用 Universal `.dmg`。未签名安装包首次打开时，右键选择“打开”。

## 使用

1. 两端创建一致的项目标识、主线和发布分支，并分别配置传输目录。
2. 内网建立镜像后导出更新；首次为全量包，后续可使用增量包。
3. 外网导入包，只更新外网镜像；需要更新开发仓库时，再点击“同步开发仓库”。
4. 外网开发并提交后，在“回传提交”导出 Bundle 或单分支 Patch。
5. 内网接收回传包，检查分支，按需 Rebase，确认源提交、目标和远端旧值后推送。

镜像与开发仓库必须使用不同目录。同步会保留开发仓库的本地分支、暂存区和未提交修改。Patch 冲突可在对应工作树解决后继续，或中止恢复。重复导入不会覆盖之后的本地修改。

## 安全边界

- 只导入可信来源的包。导入会校验 manifest、仓库身份、序号、引用和 Git 对象；这些校验不等同于数字签名认证。
- 禁止从外网镜像推送；外网开发仓库的 push 地址会被禁用，推送只在内网工作仓库执行。
- 推送确认绑定源提交、目标引用、远程地址和远程旧提交，并使用显式 lease。非快进更新需要额外确认。
- 停止或超时不等于回滚；操作结束后应根据实际 Git 状态确认结果。
- 不要手动删除恢复日志、状态备份、导出暂存目录或锁文件来绕过恢复和并发保护。
- 日志会隐藏常见 URL 凭据和令牌参数，但不会检测所有秘密；分享日志前请自行检查。

## 开发与验证

需要 Node ≥ 22.13、pnpm 11.5.0、Rust stable 和对应平台的 Tauri v2 构建环境。

```bash
pnpm install
pnpm tauri dev
pnpm test
pnpm build
pnpm check:version
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
```

模拟 IPC 的浏览器测试不能替代 Windows/macOS 原生验收。

## 打包与发布

```bash
pnpm tauri build
```

提交 `v<版本>` 标签会触发 Windows/macOS 构建和 GitHub Release 发布；带 `-` 的标签作为预发布。发布前需创建 `docs/releases/v<版本>.md`，并确保 package、Cargo、Tauri 与标签版本一致。发布流程会校验安装包、更新归档、签名、说明和 SHA-256；失败时保留草稿供重试。
