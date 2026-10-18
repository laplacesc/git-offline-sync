# Git 离线同步 · 交互与动效

## 产品与设计约束

面向通过 U 盘在内网 GitLab 与外网开发机之间交换代码的开发人员。主要操作是导入、导出、开发分支与 worktree 管理、回传、检查提交和推送。技术栈为 Tauri 2、React 19、HeroUI v3、Tailwind CSS v4。

继承 [MASTER.md](MASTER.md) 的双主题、语义颜色、排版与布局：蓝色表示交互，正文 14px、区块标题 16px、页面标题 24px/小屏 20px，4px 间距网格，240px 桌面侧栏和小屏抽屉。路径与哈希保持本地 JetBrains Mono。动效只解释用户刚刚触发的状态变化。

## 参考与取舍

- [60fps PRO](https://60fps.design/pro)：完整库需要订阅。本轮观察公开的 [Quartr Suggestion Expand on Click](https://60fps.design/shots/quartr-suggestion-expand-on-click-interaction) 视频，在初始与 6s 位置检查选中、加载和相关内容展开的关系。借鉴局部反馈与空间连续性；其 onboarding 卡片错峰、弹性与列表重排不适用于当前高频开发工作台。
- [Emil Kowalski Skills](https://github.com/emilkowalski/skills)：本地 `find-animation-opportunities`、`animate`、`emil-design-eng` 可用。先按频率、目的、时长与功能筛选，再实现。`simplify` 用于新增代码的可读性检查。
- [React Bits Animated Content](https://reactbits.dev/animations/animated-content)：React 技术栈兼容，但默认 100px 位移、0.8s 的滚动/挂载动画和 GSAP 依赖不符合本项目的任务节奏。因此只参考局部内容出现的方式，使用已有组件、CSS 与原生 Web Animations API 实现。

## 值得实现的位置

| 位置 | 原先状态 | 目的 | 频率 | 动效与功能边界 |
| --- | --- | --- | --- | --- |
| `App.tsx` 小屏侧栏 | 直接出现或消失 | 空间一致性 | 偶尔 | `translateX(-100%) ↔ 0`、`opacity 0 ↔ 1`，220ms，`cubic-bezier(0.32, 0.72, 0, 1)`；焦点和主内容的 inert 状态立即切换，关闭向同一侧退出 |
| `ui.tsx` 完整同步链路 | 直接展开或隐藏 | 状态指示、缓和突变 | 偶尔 | 实测内容高度 `0 ↔ scrollHeight`、`opacity 0 ↔ 1`，200ms，`cubic-bezier(0.23, 1, 0.32, 1)`；收起立即禁止内部控件接收焦点 |
| `index.css` 按钮按压 | 只改变阴影 | 操作反馈 | 每天多次 | `scale(1 ↔ 0.97)`，120ms，`cubic-bezier(0.23, 1, 0.32, 1)`；只用于指针按压，禁用按钮不产生反馈 |

这三项均保持在 300ms 内，不延迟操作执行。短促的抽屉与局部展开收益最高。候选筛选在实现前完成，`find-animation-opportunities` 阶段只读取项目。

## 有意不加动效的位置

- 工作流页签与键盘导航：频率和输入方式不适合运动；方向键、Home/End、Tab、Esc 即时响应。
- 分支、包、提交和日志列表：用户需要持续阅读与选择，装饰性位移或错峰会妨碍定位。
- 日志拖动调高：高度直接跟随指针或键盘，不追加缓动。
- 搜索结果与完整主题切换：避免在频繁输入或整个工作区上加入大面积动画。
- HeroUI 弹窗、Toast、加载指示：复用现有组件的行为，避免叠加另一套进出动画或伪造 Git 进度。

## 实现规则

共享 token 位于 `src/index.css`：

- `--spring: cubic-bezier(0.23, 1, 0.32, 1)`，沿用已有 token 的名称。
- `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`。
- 按压、局部展开、抽屉分别为 120ms、200ms、220ms。

`src/motion.ts` 统一记录指针/键盘输入方式，并管理两个 disclosure 的视觉进出。快速反向操作先采样当前可见位置，再取消旧动画、启动新动画；旧动画完成回调不能覆盖新状态。退出期间只保留视觉内容，调用方立即设置 `aria-hidden` 和 `inert`。退出结束恢复原生 `hidden`，不长期保留填充动画。响应式断点切换直接完成布局调整，后续主动展开或收起才播放动效。

抽屉与按压只改变 transform/opacity；链路展开是局部折叠的高度动画例外，开始时测量一次，持续 200ms，不用逐帧 JavaScript 测量。遮罩仅改变 opacity；退出时立即移除指针拦截。

继承现有设计系统的减少动效约定：`prefers-reduced-motion` 开启时即时切换。动画运行中按键或开启该设置，也会立即到达目标状态。未提供 `Element.animate` 的运行环境直接完成状态切换。

## 验证

新增 7 项单元回归覆盖视觉退出与无障碍状态分离、快速反转、键盘/减少动效/禁用模式即时切换、运行中开启减少动效、响应式模式切换，以及卸载清理。前端 62 项测试、发布脚本 13 项测试与生产构建通过。

2026-10-15 在真实 Brave 浏览器中使用页面内模拟 Tauri IPC，46 项检查全部通过。覆盖导入、同步开发仓库、分支选择、回传、内网导出、推送确认、侧栏焦点循环、Esc 恢复、页签键盘操作、表单校验与读取失败。另检查动画时长、位移方向、快速反转、退出时可访问性、减少动效和小屏溢出。两种外观的 axe 自动无障碍检查均无违规，机械样式扫描无发现。

浏览器截图中的动画暂停在中途，用于核查实际运动路径；不会修改正式组件的时长或播放速度。截图与结果位于 `screenshots/motion/`。浏览器中的模拟验收不包含真实 Git 执行、原生文件选择器、系统 WebView 或物理触屏设备。

- [链路展开中途](screenshots/motion/pipeline-enter.png)
- [抽屉进入中途](screenshots/motion/drawer-enter.png)
- [抽屉展开完成](screenshots/motion/drawer-open.png)
- [小屏配置校验](screenshots/motion/form-mobile.png)
- [46 项浏览器结果](screenshots/motion/verification.json)
- [双主题 axe 结果](screenshots/motion/accessibility.json)
