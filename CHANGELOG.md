# Changelog

本文件记录产品与工程迭代的主要变化。格式按时间倒序维护，提交前需过滤本地测试数据、临时路径、密钥和运行时数据。

## 2026-06-10

### Added
- 新增会话记忆与用户记忆能力，包括 memory API、MemoryEditor、候选记忆、提升合并、digest gate、审计与互斥保护。
- 新增 Runtime Adapter 抽象层，接入 Claude/Pi adapter、adapter registry、Pi 环境解析、runtime transport 与文件 artifact 捕获。
- 新增会话过程侧边栏，用于在会话页查看 CLI 运行过程与聚合后的过程信息。
- 新增 KiKi 默认 skills 管理能力，包括本地/远程状态查询、安装 API、tunnel 指令与前端调用封装。
- 新增流式文件 artifact 回传与消息持久化支持，CLI 生成文件可作为会话附件展示。

### Changed
- 将机器 tunnel 从 WebSocket 调整为 HTTP 长轮询，降低部署环境中的连接兼容性问题。
- 优化会话创建链路，支持即时进入会话，并在 workspace 或持久化后台失败时展示可恢复提示。
- 优化会话 hydration 逻辑，保留本地乐观创建的 `conv-new-*` 会话，避免远端旧快照覆盖本地新会话。
- 扩展规划测试入口，纳入 memory、runtime adapter、conversation store 与即时会话入口相关规格测试。
- 增强 Runtime 环境与权限提示，关闭关键权限时明确提示附件能力受限。

### Fixed
- 修复多 runtime 共用会话字段导致的跨 CLI session 泄漏问题，改为按 `runtimeKind` 隔离 `resumeSessionId`。
- 修复 Railway/WebSocket 压缩、重复 attach、reply 注册时序与 tunnel hub 状态共享等连接稳定性问题。
- 修复会话页 Suspense/loading、Next 路由 hook 空值类型与生产构建中的类型兼容问题。
- 修复任务规格生成与 tick 增量任务路径的降级、重复 ID 检测和 stale 标记遗漏。

### Removed
- 移除远端 `docs/` 目录并加入 `.gitignore`，项目文档不再同步到仓库。
- 清理远端当前树中的 `.trae/`、本地 diagnostics、task audit 和历史备份分支中的本地数据库文件。

### Verification
- 通过 `pnpm tsc --noEmit`。
- 通过 `pnpm test:planning`。
- 通过 `pnpm build`。
- 提交前执行路径与内容扫描，确认当前提交范围不包含 `data/`、`.trae/`、`docs/`、`tmp/`、数据库、密钥、`.env`、OpenClaw/Hermes 本地路径等敏感或本地运行数据。
