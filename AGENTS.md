# 项目开发约定

## 技术栈（强制）

本项目严格使用 **Rust + Tauri v2 + React + shadcn/ui**。

- Rust 负责 Git 执行、同步协议、文件与状态持久化、锁、取消及恢复；业务正确性校验必须保留在核心层。
- Tauri 必须使用 v2，前后端通过 Tauri commands/events 通信，原生能力使用 v2 API 和插件，并配置相应 capabilities。
- 前端使用 React + TypeScript，沿用 Vite 构建。不得改用其他前端框架或桌面运行时。
- UI 基础组件统一使用 shadcn/ui（new-york、Radix），以本地组件源码形式维护在 `src/components/ui/`，业务组件在此基础上组合。不得新增其他组件库。
- 样式沿用 Tailwind CSS v4，主题使用 shadcn/ui 语义变量；优先复用组件变体，保留键盘操作、焦点管理与无障碍语义。
- `components.json`、`src/lib/utils.ts` 与 TypeScript/Vite 别名配置必须保持一致。
- 离线运行所需的字体、图标、样式及脚本必须随安装包提供或由系统提供，不依赖在线 CDN。

## 文档与验证

- 同步业务规则与数据安全边界见 [README](README.md)。实现变更必须保留包校验、引用事务、推送确认、取消、冲突恢复和未提交修改保护。
- `docs/releases/` 是历史发布说明，保留当时事实，不作为当前组件选型或视觉规范。
- 实现变更按影响运行前端测试、生产构建及相关 Rust 检查。模拟 IPC 的浏览器验证不能替代 Windows/macOS 原生应用验收。
