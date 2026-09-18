# Git 离线同步（git-offline-sync）

在**只能访问内网 GitLab 的离线机器**与**外网开发机**之间，用 U 盘同步 Git 仓库的桌面工具。
基于 `git clone --mirror` + `git bundle`，Windows 与 macOS 通用（Tauri 2 + React）。

```mermaid
sequenceDiagram
    box rgba(0,82,255,0.08) 内网端（Windows）
        participant GL as GitLab
        participant MR as 镜像仓库
        participant WK as 工作仓库
    end
    box rgba(100,116,139,0.10) U 盘
        participant USB as bundle 文件
    end
    box rgba(15,157,107,0.08) 外网端（Mac，AI 开发）
        participant DEV as 开发仓库
    end

    GL->>MR: clone --mirror
    MR->>USB: bundle → proj-out-0001-full.bundle（首次全量）
    USB->>DEV: clone
    Note over DEV: 在 feature/xxx 上开发并提交
    DEV->>USB: bundle → proj-back-0001.bundle
    USB->>WK: fetch
    WK->>WK: rebase 到分支的基准（origin/main 或发布分支），确认提交
    WK->>GL: push
    GL->>MR: remote update
    MR->>USB: bundle → proj-out-0002-incr.bundle（之后增量）
    USB->>DEV: fetch
```

## 功能

| 内网端 | 外网端 |
|---|---|
| 克隆镜像（`clone --mirror`） | 首次用全量包克隆，写入提交身份和 `core.autocrlf=input` |
| 导出全量 / 增量包（自动 fetch、verify） | 按序号导入增量包，跳号或重复导入会被拦截 |
| 导入回传 bundle，或用 `git am --3way` 应用 patch | 基于主线或发布分支新建分支，rebase 到它的基准 |
| rebase 到分支的基准，列出提交确认后推送 | 回传：bundle（只含内网没有的提交）或 patch |
| 冲突时提供“继续 / 中止” | 冲突时提供“继续 / 中止” |

所有 git 命令及其输出实时显示在底部的“命令日志”中。

## 主线分支与发布分支

配置档里填写**主线分支**（如 `main`）和**发布分支**（如 `release/1.2, release/1.3`，手动填写，可以有多个，两端要一致）。约定：

| 分支前缀 | 基准分支 |
|---|---|
| `feature/`、`bugfix/` | 主线分支 |
| `hotfix/` | 某个发布分支 |

- 每个分支的基准记录在仓库配置 `branch.<分支>.syncBase` 中：外网新建分支时写入，回传包的 manifest 带上（`refs[].base`），内网导入时写回工作仓库。rebase、领先/落后、提交列表、patch 导出范围都按这个基准计算。
- 没有记录的分支（手工创建的、旧版本导出的包）按前缀推断：`hotfix/` 在发布分支中选分叉点最近的一个，其他前缀用主线。分支表里会标出“推断”，rebase 一次后记录下来。
- 前缀和基准不匹配（如从 `main` 拉 `hotfix/x`）只显示警告，不阻止操作。
- 在内网“Rebase 并推送”里可以改基准：用 `git rebase --onto origin/<新基准> origin/<旧基准>`，只搬运分支自己的提交。
- 仓库身份（根提交）和增量导出基线仍然只看主线分支。

## 安全措施

- **禁止在镜像仓库中推送**：`--mirror` 仓库一推送就会覆盖、删除远程分支。推送只能在工作仓库中进行。
- 每个包旁边有一个 `*.manifest.json`，记录仓库身份（根提交）、序号和导出时的所有分支：
  - 导入包之前核对仓库身份，防止导错项目；
  - 增量包序号必须连续；
  - 外网端据此同步“指向旧提交的新分支”和“已删除的分支”，这两种变化 bundle 本身无法表达。
- 增量基线记录全部分支和 tag，不只是 `main`，其他分支的更新也不会漏。
- 只打包 `refs/heads` 和 `refs/tags`，不会带上 GitLab 镜像里的 `refs/merge-requests` 等引用。
- 回传分支如果与内网本地分支已经分叉（比如内网 rebase 过），会导入成 `<分支>-import-<序号>`，不会覆盖本地分支。
- 工作区有未提交修改，或仓库里有未完成的 rebase/am 时，会拒绝执行 rebase 和导入 patch。

## 目录结构

```
src-tauri/src/core/     与界面无关的同步核心（可单独测试）
  git.rs                git 执行器：参数数组、实时日志、Windows 不弹黑窗、GIT_TERMINAL_PROMPT=0
  sync.rs               各个同步流程
  repo.rs               仓库状态、分支、提交、同步状态文件
  manifest.rs           包描述文件
src-tauri/src/commands.rs  Tauri 命令（在后台线程执行，日志以 git-log 事件推送）
src-tauri/tests/e2e.rs     端到端测试：本地裸仓库模拟 GitLab，完整往返
src/                    React 界面（全部使用 HeroUI v3 组件）
  index.css             设计 token（Minimalist Modern）→ HeroUI 变量、组件定制、动效
  ui.tsx                基于 HeroUI 的应用级组合组件：StepCard、PathInput、Notice、PackageRow…
  runner.tsx            串行执行 + Toast 提示 + AlertDialog 确认框
```

### 界面约定

- 组件统一使用 HeroUI v3（`@heroui/react`，基于 React Aria，需要 Tailwind CSS v4）。页面只使用 `ui.tsx` 里的组合组件或 HeroUI 原生组件，不写一次性样式。
- 颜色、圆角、阴影等设计 token 只在 `src/index.css` 的 `:root` 中定义，并映射为 HeroUI 语义变量（`--accent`、`--surface`、`--border` 等），修改主题只需改这一处。
- 字体（Inter / Calistoga / JetBrains Mono）通过 `@fontsource` 打包进程序，内网离线也能正常显示。
- 动效只用 CSS 实现，系统开启“减少动态效果”时自动关闭。

### 应用图标

源文件在 `assets/icon/`：`app-icon.svg` 是 macOS 版本，四周留边距并带投影；`app-icon-windows.svg` 是 Windows 版本，铺满画布。修改后重新生成：

```bash
pnpm tauri icon assets/icon/app-icon.svg                              # 全部尺寸 + icns
pnpm tauri icon assets/icon/app-icon-windows.svg -o /tmp/win-icons    # 再覆盖 Windows 相关文件
cp /tmp/win-icons/icon.ico /tmp/win-icons/Square*Logo.png /tmp/win-icons/StoreLogo.png src-tauri/icons/
rm -rf src-tauri/icons/android src-tauri/icons/ios
```

界面里的 logo（`ui.tsx` 中的 `AppGlyph`）和图标用的是同一个图形。

同步状态保存位置：
- 内网：`<镜像仓库>/offline-sync/state.json`
- 外网：`<开发仓库>/.git/offline-sync/state.json`

界面配置保存在系统应用配置目录中，路径可在“设置”里查看。

## 开发

需要 Node 22+、pnpm、Rust stable 和 Git ≥ 2.25。

```bash
pnpm install
pnpm tauri dev                    # 开发运行
cd src-tauri && cargo test        # 单元测试 + 端到端测试
```

> macOS 上如果还没同意 Xcode 许可，`/usr/bin/git` 会拒绝运行。可以执行 `sudo xcodebuild -license accept`，
> 或者在应用的“设置”里把 git 路径指定为 `/Library/Developer/CommandLineTools/usr/bin/git`。

## 打包

Tauri 不能交叉编译，Windows 包必须在 Windows 上构建：

- **CI**：`.github/workflows/build.yml` 会在 Windows 和 macOS 上分别测试并打包，从 Actions 的 Artifacts 下载 `.msi`/`.exe` 和 `.dmg`。
- **本地**：在对应系统上执行 `pnpm tauri build`。

Windows 离线安装说明：
- 已配置 `webviewInstallMode: offlineInstaller`，安装包内含 WebView2，没有 WebView2 的 Win10 也能离线安装。
- 目标机器需要安装 Git for Windows。如果 git 不在 PATH 中，在“设置”里指定 `git.exe` 的路径。
- 未签名的 macOS 包首次打开时，需要右键选择“打开”。
