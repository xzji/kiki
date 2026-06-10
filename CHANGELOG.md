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
- 修复会话页 Suspense/loading、Pages Router `_app` 入口、Next 路由 hook 空值类型与生产构建中的类型兼容问题。
- 修复任务规格生成与 tick 增量任务路径的降级、重复 ID 检测和 stale 标记遗漏。

### Removed
- 移除远端 `docs/` 目录并加入 `.gitignore`，项目文档不再同步到仓库。
- 清理远端当前树中的 `.trae/`、本地 diagnostics、task audit 和历史备份分支中的本地数据库文件。

### Verification
- 通过 `pnpm tsc --noEmit`。
- 通过 `pnpm test:planning`。
- 通过 `pnpm build`。
- 提交前执行路径与内容扫描，确认当前提交范围不包含 `data/`、`.trae/`、`docs/`、`tmp/`、数据库、密钥、`.env`、OpenClaw/Hermes 本地路径等敏感或本地运行数据。

## 2026-06-09

### Added
- 新增 KiKi 默认 skills 的安装与状态查询链路，支持本地执行面与远程机器 tunnel 两种模式。
- 新增 bundled skills 定义与安装元数据，避免覆盖非 KiKi 管理的用户 skill 目录。
- 新增流式文件 artifact 捕获与前端展示能力，CLI 写入文件后可通过会话消息回传附件。

### Changed
- 增强 Claude transport 与 machine stream 处理，支持更完整的流式 chunk、artifact ref 与消息持久化。
- 扩展 RuntimeEnvironmentPanel，展示 skills 状态、安装入口与权限相关提醒。

## 2026-06-08

### Changed
- 将机器 tunnel 从 WebSocket 迁移为 HTTP 长轮询，新增 poll、result、stream-chunk API。
- 调整远程 daemon loop、remote CLI proxy 与 machine stream hub，提升 Railway 等部署环境下的连接稳定性。
- 增强本地工作目录选择与远程 runtime 代理能力，支持通过已连接机器发现和使用本地 runtime。

### Fixed
- 修复 WebSocket 在云端环境中的压缩协商、重复 attach、reply 注册时序和断线重连问题。

## 2026-06-07

### Added
- 新增账号隔离与认证体系，包括登录/注册、邀请码、用户上下文、认证中间件与多 API 路由鉴权。
- 新增云端控制面与 orchestrator，支持按用户扫描待执行工作、分发任务和管理并发预算。
- 新增机器连接能力与 `@kiki_agent/daemon` 包，提供 connect-machine UI、本地 daemon CLI、npm 发布流程和远程执行入口。
- 新增会话治理与任务规格能力，支持 conversation governance、任务变更确认、task spec 生成与执行 prompt 注入。
- 新增 Railway 生产部署配置，包括 Dockerfile、railway 配置、生产启动入口和 Next.js/Railway 兼容调整。

### Changed
- 推进“云端控制面 + 本地执行面”架构，服务端 API 统一围绕用户上下文、远程机器和 runtime state 收敛。
- 将 runtime session resume 字段通用化为 `resumeSessionId`，并按 `runtimeKind` 隔离存储。
- 加强仓库治理，清理本地 diagnostics、task audit、docs 与运行时数据，防止本地文件进入远端仓库。

### Fixed
- 修复 saga plan card 进度持久化、机器列表 ghost entry、daemon PATH、runtime scan 与 tunnel hub 状态共享问题。
- 修复 Railway 安全门槛相关依赖与构建问题，包括 Next.js 版本和 pnpm 版本固定。

## 2026-06-05 至 2026-06-06

### Changed
- 收敛 runtime state 权威来源，优化运行时状态处理、事件同步和本地/远程状态一致性。
- 重构 runtime state command 路径，减少重复更新链路，为后续云端控制面和远程执行做准备。

## 2026-06-03

### Added
- 新增自适应 thread task governance，用于线程任务的判断、变更建议和执行治理。
- 新增 runtime activity monitor 与结构化用户输入能力，提升运行时活动可观测性和交互输入质量。

## 2026-06-01 至 2026-06-02

### Changed
- 完成 topic thread runtime migration，将 topic/thread 执行路径迁移到统一运行时体系。
- 对齐 thread runner prompt 与 action schema，降低模型输出和执行协议不一致风险。

### Fixed
- 修复 goal command event consistency、goals fallback snapshot 写入 thread、dev panel hydration title 等稳定性问题。

## 2026-05-30 至 2026-05-31

### Added
- 新增 P0 finalization runtime 与 deliverable primitives，为任务最终交付、产物状态和运行时收尾提供基础结构。
- 新增服务端会话持久化能力，支持 conversation state、message history 和前端 hydration。
- 新增运行时事件与 planning review 加固逻辑，提升任务规划、回放和状态恢复可靠性。

### Changed
- 合并 runtime state command paths，规范任务协议展示文本和任务通知追加方式。
- 加固 P0 finalization flows 与 daemon dogfood execution，提升端到端自测能力。

## 2026-05-20 至 2026-05-29

### Changed
- 进行项目结构重构，逐步从早期页面原型演进到更完整的应用架构。
- 持续更新 goal、task、runtime 与 UI 交互链路，为后续服务端持久化和 runtime command 化打基础。

## 2026-05-06 至 2026-05-19

### Added
- 接入 Claude Code 相关能力，建立本地 Claude 调用、agent run 与任务执行雏形。
- 新增 goal command 多轮迭代能力，逐步完善目标拆解、任务创建和命令式更新流程。
- 新增 session context management，用于维护执行上下文和跨轮对话状态。

### Changed
- 多次重构 Web UI 页面结构、信息架构与任务执行 prompt，提升目标拆解和任务输出质量。
- 调整 ID 生成规则，避免 ID 中包含中文等不稳定字符。

### Fixed
- 修复早期 agent run、任务流和 UI 状态同步中的多个问题。

## 2026-04-26

### Added
- 创建 Inbox 原型与应用 shell，建立收件箱式入口和本地 demo flow。
- 新增 Goal detail 与 breakdown flow，支持目标详情、目标拆解和规划卡片雏形。
- 新增 Task views 与 execution shell，建立任务视图、执行入口和任务结果展示基础。
