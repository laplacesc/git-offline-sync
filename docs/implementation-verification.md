# 本轮实现与验证

本轮将精简交互与两种主题材质接入正式 React/Tauri 应用，并实现日常组合操作所需的后端能力。独立 HTML 原型仍用于演示。

## 已实现

- 内网：导出更新 / 导入回传；外网：同步更新 / 回传提交。项目在顶栏切换，配置在弹窗编辑，选项、管理和日志默认收起。
- 浅色使用真实 WebGL fbm 渐变与明亮内容面板，深色使用夜景玻璃与香槟金强调。浅色、深色、跟随系统三种选择均保留；减少动态效果、不可用回退及渲染暂停由背景组件处理。
- `sync_updates` 在一个可取消的后端操作内导入镜像、逐个获取开发仓库引用或创建首次工作副本；取消后不启动后续仓库。
- `dev_sync_status` 比较实际引用和 origin 绑定，读取失败明确显示，不能当作新仓库或已同步。
- Bundle 回传以内容识别身份，原子提交 inbox、receipt 与 review 引用，使用独立工作树整理。同包改路径、整理后重导、冲突继续均复用接收记录。
- 推送计划绑定源 OID、最终地址、目标引用及远程旧值。全部推送使用显式 lease；非快进仍需确认。查询和实际写入使用同一冻结地址，避免 URL 重写到其他仓库。
- 推送后核验远程结果；无法确认时显示未知。已核实推送的当前审查提交持久标记，后续生成新提交时自动重新成为待处理事项。
- 共享导出恢复只提交所属游标，不能把新的镜像接收状态倒退。导入前优先处理或阻止未完成导出。

## 自动验证

| 检查 | 结果 |
|---|---|
| `pnpm build` | TypeScript 与生产构建通过 |
| `pnpm test` | 126 项前端测试、13 项发布脚本测试通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 37 项通过：12 单元、14 核心流程、10 端到端、1 版本 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| `pnpm check:version` | package / Cargo / Tauri 均为 2.0.9 |

核心回归覆盖：确认后源提交或远程配置改变、普通推送预检后目标被删除、insteadOf/pushInsteadOf 重写、接收事务中断、回传重导、审查改基准后重导、冲突继续后的 ready 收尾、标记写入失败、取消后的远程核验、结果未知、开发仓库真实引用状态及旧导出恢复防倒退。

前端回归覆盖：新双页签入口、状态读取错误、请求过期保护、单条组合同步、冻结计划确认、取消确认、工作区变化后拒绝迟到计划、已推送条目隐藏、分支选择、主题生命周期及需要处理的操作结果。

## macOS 桌面实测

以独立应用标识和临时 Git 仓库运行 `pnpm tauri dev --config <验证配置>`，使用实际桌面按钮及 Tauri IPC 完成：

1. 内网导出 `verification-out-0001-full.bundle`。
2. 切到外网，一次点击完成镜像导入与开发仓库创建；开发仓库 origin 指向本地镜像，HEAD 为 main。
3. 在临时开发仓库创建 `feature/ui-validation` 并提交，应用导出 `verification-back-0001.bundle`。
4. 切回内网，一次点击接收并在托管 worktree 整理。核对主工作区仍在原来的 main，inbox、receipt 和 ready 引用均存在。
5. 应用展示冻结计划，确认后推送至临时裸远程的 `feature/ui-validation`。远程、导出分支和 pushed 标记均为 `bdd5768474e62aa228869f94506e3bec152a67d3`。
6. 已推送条目从默认待处理列表移除。实际查看深色主界面、菜单与确认弹窗，以及浅色着色器界面。

验证配置使用独立标识 `com.jxwu.gitofflinesync.verify4e3a4293`，开发服务端口 1430。验证结束后关闭隔离实例，改用 `pnpm tauri dev` 启动使用原有配置的正常开发版（端口 1420），保留窗口供继续检查。上述原生桌面验证仅在 macOS 完成；Windows 需要对应平台 CI 和桌面复验。

## 后续阶段

继续读写 format 1。`format: 2` / refs-only / 新流迁移、统一 requestId 与 operationId、inspectWorkspace，以及 Patch 的统一接收与审查模型尚未实现。Patch 仍通过已有兼容入口应用到指定独立工作树，不能等同于 Bundle 新接收流程的幂等保障。

完整目标与迁移顺序见 [核心逻辑设计](./core-logic-redesign.md)。本记录不代表整个长期迁移计划完成。
