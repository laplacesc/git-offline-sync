# Git 离线同步 · 桌面工作台设计规范

## 产品与使用者

本项目面向在内网 GitLab 与外网开发机之间交换代码的开发人员。通过 U 盘传输 Git bundle 或 patch；使用者需要明确当前电脑的角色、仓库状态、包序号以及下一步操作。

- 内网端：建立镜像、导出全量或增量包、接收外网回传、检查提交、Rebase 与推送。
- 外网端：导入内网包到裸镜像、克隆或同步开发仓库、管理开发分支和 worktree、导出回传。
- 技术栈：Tauri 2、React 19、HeroUI v3、Tailwind CSS v4。继续使用现有 HeroUI 与应用组合组件。

本轮按用户要求重新建立视觉方向。真实业务依据来自 README、同步 API 与两端页面；仓库没有业务截图，现有图片是应用图标。旧原型不作为当前设计依据。

## 设计来源与适配

- [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)：本地 Skill 可用。执行产品设计系统、开发工具配色与 React 交互规则查询。设计系统结果中的营销页结构与本项目不匹配，使用桌面工具的扁平表面、排版、焦点、反馈与减少动效规则。
- [App Shell UI](https://github.com/yg2224/app-shell-ui/blob/master/SKILL.md)：本地未安装，已读取上游 Skill 及 tokens、layouts、components。采用控制台型 App Mode、双主题、单品牌色与首屏容量规则。组件继续使用 HeroUI，未引入 shadcn 或演示组件。
- [Vercel Web Design Guidelines](https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md)：读取上游 Skill 与最新 Web Interface Guidelines，检查键盘、表单、焦点、反馈、排版与响应式。

浏览器 URL 状态与服务端渐进增强规则不直接套用到当前本地 Tauri 单窗口客户端。外观偏好独立存储，不增加同步配置字段。

## 颜色

| 语义 | 浅色 | 深色 |
| --- | --- | --- |
| 画布 | `#F4F5F7` | `#1C1E22` |
| 侧栏 | `#F0F2F5` | `#191B1F` |
| 主面板 | `#FFFFFF` | `#25282E` |
| 次级表面 | `#F5F6F8` | `#292C32` |
| 正文 | `#202632` | `#F2F3F5` |
| 辅助文字 | `#596273` | `#B5BAC5` |
| 边框 | `#D9DEE7` | `#444B57` |
| 主操作填充 | `#245BD6` | `#356CD8` |
| 链接与焦点 | `#245BD6` | `#79A8FF` |
| 选中背景 | `#EDF3FF` | `#263750` |
| 成功 | `#16704C` | `#74D6A4` |
| 警告 | `#8A550E` | `#EFC174` |
| 错误 | `#B52C3B` | `#FF99A5` |

唯一交互品牌色为蓝色。语义颜色必须配文字或图标。实心主按钮使用白色文字；深色的浅蓝强调控件使用深色前景。面板以 1px 边框区分层级，只使用轻阴影。

颜色在 `src/index.css` 中定义，映射到 HeroUI 的 surface、field、accent、muted、overlay 等语义变量。组件消费 token，不单独建立配色。

## 字号、间距与材质

- 中文正文：系统字体，优先 macOS/Windows 原生中文字体。正文与按钮 14px、区块标题 16px、页面标题 24px、小屏标题 20px、辅助信息 12px。正文行高约 1.6。
- 路径、命令、分支、哈希：本地 JetBrains Mono，12–13px。数字使用等宽数字，长路径可换行或截断，并提供完整值。
- 4px 间距网格：控件间距 8–12px、内容面板间距 14–24px、面板内边距 20–24px。
- 控件圆角 8px、面板圆角 12px。桌面按钮至少 32–36px 高，字段 40px；小屏按钮和输入控件至少 44px 高。
- 150–160ms 颜色、边框和阴影反馈；不通过移动卡片制造交互。遵循 `prefers-reduced-motion`。

交互动效遵循 [MOTION.md](MOTION.md)：指针按压 120ms、小屏抽屉 220ms、完整链路展开 200ms。键盘操作与减少动态效果即时完成，业务数据列表保持稳定。

所有字体随包分发或由系统提供；界面不需要在线字体、图片或第三方运行脚本。

## 布局与操作

桌面以 1280×800 为基础验证视口。240px 固定侧栏包含配置搜索、内外网分组、Git 环境、版本与设置；顶栏保留工作区上下文、侧栏控制、外观切换及编辑配置。

工作区顺序：配置标题及路径信息 → 建议下一步 → 可展开的完整同步链路 → 四步骤页签 → 当前任务面板。主任务优先显示，完整链路默认折叠。桌面任务面板的长内容在内部滚动，面板至少保留 240px 高度；窗口较矮或同时展开链路与日志时，工作区允许纵向滚动，保证任务仍可到达。表单因字段较多允许工作区滚动。

小于 1024px 侧栏转抽屉。抽屉展开时工作区 inert，Tab 在导航中循环，Esc、关闭按钮与遮罩可关闭并恢复焦点。小屏工作区自然纵向滚动，流程页签可横向浏览，页面自身不横向溢出。

页签支持左右方向键、Home/End；面板保持挂载，保留输入和分支选择。包行说明序号、类型、时间、分支数、是否已导入及禁用原因。日志默认折叠、错误时展开，仍支持复制、跟随和键盘调整高度。桌面与小屏均使用用户设置的日志高度，并限制在视口高度的一半以内。提示消息放在工具栏下方，保留顶栏操作空间。

Git 操作继续串行执行，运行时禁用重复操作并提供停止请求。推送前确认提交；删除配置和放弃修改使用确认框。表单错误保留填写内容，错误摘要可定位字段。

## 外观

顶栏外观菜单提供浅色、深色和跟随系统三项，并标记当前选择。默认跟随系统；系统模式实时响应 `prefers-color-scheme` 变化，手动选择浅色或深色时保持固定。`localStorage.app-shell-theme` 保存 `light`、`dark` 或 `system`，兼容旧的手动偏好。存储不可用时切换仍可使用。根节点通过 `data-theme` 与 `color-scheme` 同步 WebView 原生控件及滚动条，theme-color 与画布保持一致。

## 验证与截图

真实 Brave 浏览器验证使用临时 Puppeteer 脚本和页面内模拟 Tauri IPC；模拟数据不在正式代码中。覆盖外网导入、同步开发仓库、分支选择与回传，以及内网导出、提交检查和推送确认。验证 320、375、414、768、1024、1280、1440px 宽度，并检查抽屉焦点循环、Esc、页签键盘操作、配置错误摘要、读取失败与减少动效。

2026-10-15 续验增加 1280×600 窗口同时展开链路与日志的任务可达性检查，以及 375px 小屏日志的键盘和按钮调高检查。桌面、内外网任务和小屏截图已更新，并新增两张布局回归截图；设置、首次使用及配置校验截图保留上一轮版本，本轮交互检查使用当前代码。前端 55 项测试与发布脚本 13 项测试通过，生产构建通过。

截图使用演示仓库数据，便于审阅布局：

- [桌面浅色](screenshots/desktop-light.png)
- [桌面深色](screenshots/desktop-dark.png)
- [外网回传](screenshots/return-dark.png)
- [内网导出](screenshots/internal-dark.png)
- [小屏浅色](screenshots/mobile-light.png)
- [小屏深色](screenshots/mobile-dark.png)
- [短窗口展开链路与日志](screenshots/short-expanded.png)
- [小屏日志调高](screenshots/mobile-log-dark.png)
- [首次使用](screenshots/welcome-light.png)
- [设置](screenshots/settings-dark.png)
- [小屏配置校验](screenshots/form-mobile-light.png)
- [浏览器检查结果](screenshots/verification.json)
- [axe 无障碍结果](screenshots/accessibility.json)：当前内网镜像页面在两种外观下的 WCAG A/AA 自动检查均未报告违规；自动检查不能替代人工读屏。

浏览器验证不包含真实 Git 命令执行、原生目录选择器或 Windows/macOS 的 Tauri WebView。真实同步与安装包验证应在桌面运行环境完成。旧 `prototype.html` 保留为历史文件，当前实现及以上截图是本轮设计依据。
