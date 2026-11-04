# 项目开发约定

## 技术栈（强制）

本项目严格使用 **Rust + Tauri v2 + React + shadcn/ui**。

- Rust 负责 Git 执行、同步协议、文件与状态持久化、锁、取消及恢复；业务正确性校验必须保留在核心层。
- Tauri 必须使用 v2，前后端通过 Tauri commands/events 通信，原生能力使用 v2 API 和插件，并配置相应 capabilities。
- 前端使用 React + TypeScript，沿用 Vite 构建。不得改用其他前端框架或桌面运行时。
- UI 基础组件统一使用 shadcn/ui，以本地组件源码形式维护在 `src/components/ui/`，业务组件在此基础上组合。不得新增 HeroUI、Ant Design、MUI 等其他组件库，也不得只给旧组件改名来宣称完成迁移。
- 样式沿用 Tailwind CSS v4，主题使用 shadcn/ui 语义变量；优先复用组件变体，保留键盘操作、焦点管理与无障碍语义。
- shadcn/ui 接入时必须提供有效的 `components.json`，并使组件路径、工具函数和 TypeScript/Vite 别名配置一致。
- 离线运行所需的字体、图标、样式及脚本必须随安装包提供或由系统提供，不依赖在线 CDN。

## 当前迁移状态

前端已接入 shadcn/ui（new-york、Radix），基础组件源码位于 `src/components/ui/`，配置位于 `components.json`，通用样式合并函数位于 `src/lib/utils.ts`。HeroUI 组件、样式和依赖已移除；业务界面通过本地基础组件组合实现。日期只读展示使用原生 `<time>`。Rust 与 Tauri v2 继续承担原有同步及原生能力。

## 文档与验证

- 本文件集中维护技术栈要求。旧版 UI 设计、原型、截图和视觉约束已清理，不再作为实施依据；不沿用旧配色、字体尺寸、圆角、布局或动效参数作为强制要求。
- 同步业务规则与数据安全边界见 [README](README.md)。UI 迁移必须保留包校验、引用事务、推送确认、取消、冲突恢复和未提交修改保护。
- `docs/releases/` 是历史发布说明，保留当时事实，不作为当前组件选型或视觉规范。
- 实现变更按影响运行前端测试、生产构建及相关 Rust 检查。模拟 IPC 的浏览器验证不能替代 Windows/macOS 原生应用验收。
