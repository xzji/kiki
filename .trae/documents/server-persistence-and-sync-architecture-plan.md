# KiKi 服务端持久化与本地连接器架构规划

## Summary

目标是把当前“浏览器内 Zustand + localStorage + 临时 telemetry 文件”的原型，升级为“服务端持久化 + 多端访问 + 用户自有本地 Claude CLI Connector”的正式架构。

本方案按以下方向设计：

- 产品形态：公开 Web 产品，用户登录后可在任意设备访问自己的历史数据。
- 数据模型：单用户单租户，所有业务数据按 `userId` 隔离。
- 持久化介质：近期以 `SQLite` 单节点落地。
- 演进方向：数据访问层与表结构预留未来迁移到云端数据库（如 Postgres）的能力。
- 本地 AI 连接：用户本机运行轻量 Connector，与服务端建立长连接；任务由服务端分发到该用户本机 Connector，再由 Connector 调用本地 Claude CLI。
- 保存策略：默认全量保存核心业务数据、会话内容、执行日志、结果与 Claude session 关联信息。

补充结论：

- 仅有“服务端持久化”还不足以保证“关闭浏览器后继续运行”。
- 要满足本机 24h 运行，必须把当前浏览器里的调度与触发逻辑迁移到后台常驻 Worker/Daemon。
- 因此最终目标应是“三层分离”：浏览器 UI、Web/API 服务、后台 Worker/Connector。
- 关闭浏览器后能否继续运行，取决于本地后台进程是否还活着，而不是取决于数据是否已落 SQLite。

本次规划的优先级调整为：

- 第一优先级：满足你当前最关心的能力，即“只要电脑没关，浏览器关闭后后台 Claude 仍可按计划持续运行”。
- 第二优先级：让这些运行状态、结果、历史能够可靠持久化，而不是只存在浏览器。
- 第三优先级：在不推翻前两者的前提下，为未来公开产品的云端控制面和多端访问预留演进接口。

因此，近期推荐路线不是“先做纯 Web 服务端持久化”，而是：

1. 先落本机常驻 `Runtime Daemon`
2. 再把任务调度和执行从浏览器迁出
3. 再把数据真源切到本地 SQLite + 文件存储
4. 最后再接云端控制面，扩展为公开产品

## Current State Analysis

基于当前仓库实现，现状如下：

### 1. 业务主数据仍主要驻留在浏览器

- `src/stores/goalStore.ts`
  - 使用 `zustand/middleware` 的 `persist`，持久化键为 `kiki.goals`。
  - `goals` 是目标、子目标、任务、任务实例、执行结果的核心数据源。
- `src/stores/conversationStore.ts`
  - 使用 `persist`，持久化键为 `kiki.conversations`。
  - 对话标题、消息、`goalInfoCollection`、会话状态、`claudeSessionId` 都仅保存在浏览器。
- `src/stores/runtimeEnvStore.ts`
  - 使用 `persist`，持久化键为 `kiki.runtime.environments`。
  - 当前运行环境配置完全在浏览器端。
- `src/stores/easterEggSettingsStore.ts`
  - 使用 `persist`，持久化键为 `kiki.easter-egg-settings`。
- `src/stores/scheduleStore.ts`
  - 手动读写 `window.localStorage`，持久化键为 `kiki.schedule.events`。
- `src/stores/assistantStore.ts`
  - 仅保存侧边栏开关状态 `kiki.assistant.isOpen`，消息流本身未形成稳定服务端状态。

结论：当前核心业务数据只要更换浏览器、清除浏览器存储、切换设备，历史就会丢失。

### 2. 服务端已有 Node Runtime 入口，但尚未成为系统真源

- `src/app/api/claude/chat/route.ts`
  - 已在服务端桥接 Claude CLI 流式输出。
- `src/app/api/goals/tasks/execute/route.ts`
  - 已在服务端 fire-and-forget 地启动任务执行。
- `src/app/api/goals/*`
  - 已存在目标规划、澄清、执行进度等 API 入口。
- `src/app/api/runtime-envs/*`
  - 已存在本地运行环境发现与状态检查接口。

结论：项目已经具备“服务端编排”的雏形，但浏览器 store 仍然是事实主数据源，前后端职责倒置。

### 3. 唯一服务端落盘数据目前只是临时 telemetry

- `src/lib/server/goalTelemetry.ts`
  - 通过 `fs.readFileSync/writeFileSync` 将 telemetry 写入 `os.tmpdir()/kiki-goal-telemetry.json`。

问题：

- `os.tmpdir()` 不适合正式持久化。
- 只能存一个全局 telemetry 文件，没有用户隔离。
- 重启、清理临时目录、部署迁移都可能丢失。
- 只适合短期运行态观测，不适合历史查询与恢复。

### 4. 当前还没有用户体系与租户隔离

- 全仓库未发现真实 `auth/userId/account/workspace` 数据模型。
- 设置页虽有 `account` tab（见 `src/components/settings/SettingsModal.tsx` 与 `src/lib/settings.ts`），但尚未落地真实账号体系。

结论：如果做公开产品，必须先建立用户身份与资源归属关系，否则无法安全保存服务器历史数据。

### 5. 当前“本地 Claude CLI”模型默认运行在服务端机器上

- `src/lib/server/claudeCli.ts`
  - 通过 `spawn` 直接在服务端运行 Claude CLI。
- `src/app/api/runtime-envs/discover/route.ts`
  - 当前发现的是服务器机器上的本地 CLI。
- `src/app/api/runtime-envs/status/route.ts`
  - 当前检查的也是服务器机器路径。

结论：这套模型适合“开发机本地调试”，但不适合“公网用户连接自己电脑上的 Claude CLI”。正式产品必须引入本地 Connector。

### 6. 当前任务调度器运行在浏览器，而不是后台服务

- `src/components/providers/app-providers.tsx`
  - 直接在客户端 Provider 中挂载了 `GoalSchedulerRuntime`。
- `src/components/providers/GoalSchedulerRuntime.tsx`
  - 文件本身是 `"use client"`。
  - 通过 `useEffect(...)` 启动调度。
  - 通过 `window.setInterval(...)` 周期触发扫描与执行。

结论：

- 当前实现下，只要浏览器页面关闭、标签页被挂起、或页面不再存活，调度循环就停止。
- 所以即使现在把数据改成 SQLite，仍然不能自动实现“关闭浏览器继续跑”。
- 若想支持你说的场景，第一优先级不是“只换存储”，而是“把调度器迁到后台进程”。

## Assumptions & Decisions

### 已确认决策

- 账号模型：单用户单租户。
- 部署阶段：先按单节点常驻服务落地。
- 主存储：SQLite。
- 兼容未来：Repository/DAO 层与 schema 设计为未来迁移到云数据库做准备。
- 运行时接入：用户本机运行 Connector，对接自己本地 Claude CLI。
- 数据保存：默认全量保存。
- 当前 MVP 目标：优先支持“本机单机运行 + 浏览器关闭后仍继续执行”。
- 当前目标平台：优先按 `macOS` 设计常驻方案。
- 一期范围：本机优先，但所有接口、设备模型、数据层为未来云端控制面预留扩展位。

### 关键架构决策

1. 服务端数据库成为唯一真源

- 浏览器内 Zustand 不再承担长期事实存储。
- Zustand 退化为页面级缓存与 UI 响应层。
- 所有核心实体改为通过服务端 API 读写。

2. 持久化拆成两层

- 结构化业务数据：SQLite。
- 大文本日志、结果快照、产物文件：文件系统目录。

3. 采用“混合持久化”

- 核心实体不建议全部塞进 SQLite 的一个 JSON 列。
- 任务日志、长结果、调试快照、导出产物不建议全部做关系型列。
- 因此选用：
  - SQLite：负责索引、关系、状态、元数据、关键结果摘要。
  - 文件系统：负责流式日志原文、结果全文、Markdown/JSON 产物、未来附件。

4. Connector 是公网产品连接用户本地 Claude CLI 的标准解法

- Web 服务本身不能直接访问用户本机文件路径与本地 CLI。
- 服务端只管理任务、会话、状态与结果。
- 真正执行 CLI 的位置是用户机器上的 Connector 进程。

5. 对“本机关闭浏览器仍继续运行”的支持，必须通过后台常驻执行层实现

- 浏览器只负责展示和交互。
- 任务是否到期、是否可运行、是否需重试，必须由后台进程判定。
- 在“本机运行项目”的情况下，这个后台进程可以也运行在本机，但它必须独立于浏览器。

6. 路线采用“两阶段架构”，避免一次做太重

- Stage 1：本机单机模式
  - `Web UI + Local API + Local Daemon + Local SQLite`
  - 不依赖云端控制面，也能实现关闭浏览器后继续运行。
- Stage 2：公开产品模式
  - `Web 前端 + 云端控制面 + 本地 Runtime Daemon`
  - 支持跨设备访问、任务远程下发、设备状态云端可见。

这能保证：

- 先快速满足你的核心产品体验。
- 后续不会推翻现有数据层和 daemon 层，只是在其上方增加云端控制面。
- 一期落地聚焦 Stage 1，但接口命名、表结构、任务模型、设备模型都要兼容 Stage 2。

## Proposed Changes

### A. 引入服务端数据层与存储边界

#### 新增目录与核心文件

- `src/lib/server/db/`
  - `client.ts`
  - `schema.ts`
  - `migrations/`
- `src/lib/server/repositories/`
  - `usersRepository.ts`
  - `conversationsRepository.ts`
  - `goalsRepository.ts`
  - `runtimeEnvsRepository.ts`
  - `taskRunsRepository.ts`
  - `artifactsRepository.ts`
- `src/lib/server/storage/`
  - `paths.ts`
  - `artifactStore.ts`
  - `logStore.ts`

#### 设计意图

- 将数据库访问与业务逻辑解耦，避免未来从 SQLite 迁移到 Postgres 时大面积改 API 或页面逻辑。
- 把“结构化实体”和“日志/产物文件”明确分层，避免存储职责混乱。

#### 数据目录建议

- 数据库文件：
  - `./data/kiki.db`
- 文件存储根目录：
  - `./data/storage/`
- 其下按用户隔离：
  - `./data/storage/users/<userId>/task-runs/<runId>/`
  - `./data/storage/users/<userId>/conversations/<conversationId>/`

#### 路径与部署约束

- 统一新增 `KIKI_DATA_DIR` 环境变量。
- 默认开发环境可回落到项目根目录下 `data/`。
- 禁止继续使用 `os.tmpdir()` 作为正式业务持久化路径。

### B. 建立正式领域模型

#### SQLite 表设计

建议至少包含以下表：

- `users`
  - `id`
  - `email`
  - `display_name`
  - `created_at`
  - `updated_at`

- `user_sessions`
  - 登录态或服务端 session 映射

- `runtime_connectors`
  - `id`
  - `user_id`
  - `device_name`
  - `status`
  - `last_seen_at`
  - `connector_version`
  - `created_at`

- `runtime_environments`
  - `id`
  - `user_id`
  - `connector_id`
  - `runtime_kind`
  - `name`
  - `working_directory`
  - `cli_path`
  - `permission_mode`
  - `is_default`
  - `health_status`
  - `health_reason`
  - `last_checked_at`
  - `created_at`
  - `updated_at`

- `conversations`
  - `id`
  - `user_id`
  - `title`
  - `status`
  - `runtime_env_id`
  - `claude_session_id`
  - `last_message_at`
  - `created_at`
  - `updated_at`

- `conversation_messages`
  - `id`
  - `conversation_id`
  - `user_id`
  - `role`
  - `kind`
  - `content`
  - `status`
  - `source`
  - `quoted_message_json`
  - `goal_ref_json`
  - `task_ref_json`
  - `unread`
  - `created_at`

- `goal_info_collections`
  - `id`
  - `conversation_id`
  - `user_id`
  - `goal_text`
  - `status`
  - `current_round`
  - `min_rounds`
  - `max_rounds`
  - `summary_json`
  - `assistant_message`
  - `started_at`
  - `updated_at`

- `goal_info_collection_rounds`
  - `id`
  - `collection_id`
  - `questions_json`
  - `answer`
  - `asked_at`
  - `answered_at`

- `goals`
  - `id`
  - `user_id`
  - `conversation_id`
  - `title`
  - `summary`
  - `progress`
  - `status`
  - `workflow_phase`
  - `workflow_plan_decision`
  - `workflow_json`
  - `created_at`
  - `updated_at`

- `sub_goals`
  - `id`
  - `goal_id`
  - `user_id`
  - `title`
  - `sort_order`

- `tasks`
  - `id`
  - `goal_id`
  - `sub_goal_id`
  - `user_id`
  - `title`
  - `description`
  - `expected_outcome`
  - `task_type`
  - `trigger_rule`
  - `deadline`
  - `progress`
  - `execution_kind`
  - `result_view_kind`
  - `execution_strategy`
  - `execution_objective`
  - `recommended_working_directory`
  - `priority`
  - `dependencies_json`
  - `auto_run_disabled`
  - `requires_confirmation`
  - `sort_order`
  - `created_at`
  - `updated_at`

- `task_instances`
  - `id`
  - `task_id`
  - `goal_id`
  - `user_id`
  - `date_label`
  - `status`
  - `intro`
  - `payload_json`
  - `runner_json`
  - `execution_json`
  - `awaiting_user_json`
  - `result_summary`
  - `result_final_message`
  - `result_structured_output_json`
  - `created_at`
  - `updated_at`
  - `finished_at`

- `task_run_logs`
  - `id`
  - `task_instance_id`
  - `user_id`
  - `request_id`
  - `level`
  - `phase`
  - `message`
  - `details`
  - `event_type`
  - `tool_name`
  - `status`
  - `timestamp`

- `task_run_artifacts`
  - `id`
  - `task_instance_id`
  - `user_id`
  - `label`
  - `kind`
  - `relative_path`
  - `mime_type`
  - `size_bytes`
  - `created_at`

- `schedule_events`
  - `id`
  - `user_id`
  - `goal_id`
  - `task_id`
  - `task_instance_id`
  - `title`
  - `start_at`
  - `end_at`
  - `all_day`
  - `color_token`
  - `created_at`
  - `updated_at`

- `user_settings`
  - `user_id`
  - `easter_egg_settings_json`
  - `ui_preferences_json`
  - `updated_at`

#### 设计原则

- 所有核心表必须带 `user_id`。
- 列表展示常用字段做显式列，复杂结构使用 `*_json` 保留灵活性。
- `workflow / runner / execution / payload` 这类变化较快的结构允许先存 JSON，减少迁移成本。
- 为未来云迁移预留统一主键和时间戳策略，不依赖 SQLite 特有行为。

### C. 将现有 API 从“操作前端 store”改为“读写数据库”

#### 保留并重构的现有 API 边界

- `src/app/api/claude/chat/route.ts`
  - 现状：只负责桥接流。
  - 改造：在请求开始时创建消息草稿与 run 记录，流式过程中增量写数据库/文件，结束后落最终消息和 `claude_session_id`。

- `src/app/api/goals/plan/route.ts`
  - 现状：返回规划草案，但事实数据最终仍写到浏览器 store。
  - 改造：规划过程中服务端直接写 `goal_info_collections`、草案目标、工作流状态。

- `src/app/api/goals/collect/route.ts`
  - 改造：每一轮问答都写入 `goal_info_collection_rounds`。

- `src/app/api/goals/tasks/execute/route.ts`
  - 现状：fire-and-forget + telemetry。
  - 改造：改为创建正式 `task_instances`/`task_run_logs`/`artifacts`，并通过 Connector 队列分发。

- `src/app/api/goals/progress/route.ts`
  - 改造：从数据库与日志存储查询，而非从进程内存 + 临时 JSON 文件读取。

- `src/app/api/runtime-envs/*`
  - 改造：不再直接探测服务器本机 CLI，而是查询该用户在线 Connector 暴露的运行环境能力。

#### 新增 API 建议

- `src/app/api/auth/*`
  - 登录、登出、会话校验。
- `src/app/api/me/route.ts`
  - 当前用户信息。
- `src/app/api/conversations/route.ts`
  - 会话列表查询/创建。
- `src/app/api/conversations/[conversationId]/messages/route.ts`
  - 消息分页查询/发送。
- `src/app/api/goals/route.ts`
  - 目标列表、创建。
- `src/app/api/goals/[goalId]/route.ts`
  - 目标详情、更新。
- `src/app/api/schedule/route.ts`
  - 日程事件增删改查。
- `src/app/api/settings/route.ts`
  - 用户设置读写。
- `src/app/api/connectors/register/route.ts`
  - 本地 Connector 注册。
- `src/app/api/connectors/heartbeat/route.ts`
  - 在线状态和能力上报。
- `src/app/api/connectors/pull/route.ts`
  - Connector 拉取待执行任务。
- `src/app/api/connectors/push-result/route.ts`
  - Connector 回传执行日志、结果、产物索引。

### D. 引入 Connector 通道，替换“服务端直接跑用户本地 Claude CLI”

#### 新增目录

- `connector/`
  - `src/index.ts`
  - `src/client.ts`
  - `src/claudeRunner.ts`
  - `src/config.ts`
  - `src/storage.ts`

补充：若以本机单机模式优先落地，建议把 `connector` 命名和实现先收敛为更明确的本地守护进程：

- `src/lib/daemon/`
- `src/bin/kiki-runtime-daemon.ts`
- `src/types/runtime-daemon.ts`
- `packaging/macos/com.kiki.runtime-daemon.plist`

原因：

- “connector”更适合云端控制面阶段的设备接入语义。
- 你当前最需要的是“本机常驻执行器”，产品上用 `daemon` 更准确。

建议：

- Stage 1 文件命名先使用 `daemon`
- Stage 2 若引入云端控制面，再把 daemon 对外呈现为 connector/device
- 一期实现仅要求本机单机闭环跑通，不强制同时落云端消息转发。

#### Stage 1：本机单机模式连接模型

1. 用户在本机启动 `kiki-runtime-daemon`
2. Daemon 常驻并维护：
   - Claude CLI 可用性
   - 已授权工作目录
   - 当前任务忙闲状态
   - 本地心跳与日志
3. Web 端不再直接决定任务是否运行，而是把任务写入本地数据库队列
4. Daemon 从本地数据库领取任务并调用本地 Claude CLI
5. 结果、日志、sessionId 回写到本地数据库和文件存储
6. 用户重新打开浏览器时，Web UI 直接读取本地持久化状态

这样即使浏览器关闭，只要 daemon 没停，任务仍继续。

#### Stage 2：公开产品模式连接模型

在保留 Stage 1 本地 daemon 的前提下，再增加云端控制面：

1. 用户登录 Web，设备完成绑定
2. 云端控制面维护设备在线状态与任务队列
3. 本地 daemon 通过 WebSocket/长轮询接收云端任务
4. daemon 本地执行 Claude CLI 并把结果回写云端
5. 用户在任意设备登录都能看到历史和执行状态

#### 一期的接口预留原则

虽然一期只做本机模式，但以下设计必须从一开始就预留：

- `deviceId`
  - 本机 daemon 也要有稳定设备标识，未来可直接绑定到云端。
- `jobId`
  - 所有执行都使用统一 job/run 主键，而不是页面内临时状态。
- `runtime transport`
  - 保留 `local_daemon` 与未来 `cloud_control_plane` 的执行传输枚举。
- `userId`
  - 即使一期主要本机使用，业务表和 API 也尽量保留用户归属字段。
- `heartbeat`
  - 一期可先本地使用，二期可无缝扩展到云端设备在线状态。

#### 连接模型

1. 用户登录 Web，获取一个设备绑定 token。
2. 用户在自己电脑安装并登录 Connector。
3. Connector 周期性向服务端心跳并拉取待执行任务。
4. 服务端将属于该 `userId` 的任务分配给在线 Connector。
5. Connector 在本机调用 Claude CLI。
6. 执行过程中持续回传：
   - 流式输出
   - 阶段状态
   - 最终结果
   - sessionId
   - 错误信息
   - 产物清单
7. 服务端持久化后，前端再拉取或订阅更新。

#### 为什么不用当前 `runtime-envs/discover`

- 当前接口只能看到服务器本机环境，不符合公网用户场景。
- Connector 模式才可以安全访问用户本机目录、CLI 路径、认证状态与会话文件。

### D1. 增加本机 24h 常驻运行模式

这是针对“关闭浏览器后仍可正常运行”的必需补充层。

#### 新增目录与文件

- `src/lib/server/worker/`
  - `goalSchedulerWorker.ts`
  - `taskDispatchWorker.ts`
  - `recoveryWorker.ts`
- `src/lib/server/runtime/`
  - `jobLease.ts`
  - `heartbeat.ts`
- `scripts/`
  - `start-worker.ts`
- `src/lib/daemon/`
  - `daemonConfig.ts`
  - `daemonState.ts`
  - `daemonRunner.ts`
  - `launchAgent.ts`
- `src/bin/`
  - `kiki-runtime-daemon.ts`
- `packaging/macos/`
  - `com.kiki.runtime-daemon.plist`

#### 后台常驻职责

1. `goalSchedulerWorker`

- 周期扫描数据库中的目标、任务、实例。
- 判断触发时间、依赖关系、任务状态、并发上限。
- 为符合条件的任务创建 run 或投递队列。

2. `taskDispatchWorker`

- 将待执行任务分配给本机执行器或在线 Connector。
- 跟踪执行超时、失败重试和回传状态。

3. `recoveryWorker`

- 进程重启后恢复未完成任务。
- 清理过期 lease。
- 将卡死任务重新放回可领取状态。

#### 本机单机运行的最小闭环

若当前项目仍只运行在你自己的电脑上，要实现“浏览器关闭后继续跑”，最小需要：

- 一个持续运行的 Web/API 进程。
- 一个持续运行的 Worker 进程。
- 一个持续运行的本机 Daemon 或直接本机执行器。
- 三者共享同一个 `SQLite + data/` 目录。

这样关闭浏览器后，只要这些后台进程仍在，任务仍会继续执行。

#### 守护建议

若目标真的是接近 24h 持续运行，还需要系统级守护：

- macOS：`launchd`
- Linux：`systemd`
- 开发期临时方案：`pm2`

它们负责：

- 进程退出后自动拉起。
- 开机后自动启动。
- 固定日志落盘。

推荐首版直接使用：

- 守护方式：`LaunchAgent`
- 本地配置目录：`~/.kiki/runtime/`
- 本地日志目录：`~/.kiki/runtime/logs/`
- 本地设备配置：
  - `~/.kiki/runtime/config.json`
  - `~/.kiki/runtime/device.json`

#### 边界说明

- 关闭浏览器：可以继续运行，只要后台进程仍在。
- 关闭启动进程的终端且无守护：通常会一起退出，不能继续运行。
- 电脑睡眠：任务会暂停，恢复后需补偿执行。
- 电脑关机：无法继续运行，只能在重启后基于持久化状态恢复。

### E. 前端状态层改造：Zustand 从“真源”改为“缓存”

#### 需要改造的现有 store

- `src/stores/goalStore.ts`
- `src/stores/conversationStore.ts`
- `src/stores/runtimeEnvStore.ts`
- `src/stores/scheduleStore.ts`
- `src/stores/easterEggSettingsStore.ts`

#### 改造方式

- 移除核心业务实体的 `persist(localStorage)` 依赖。
- 首屏从 API 拉取服务端数据并 hydrate 到 store。
- 页面上的增删改操作改为：
  - 先调用 API
  - 成功后更新 store
  - 或使用 React Query 统一管理请求缓存

#### 推荐做法

- 保留 Zustand 处理：
  - 抽屉开关
  - 选中态
  - 临时表单态
  - 局部 optimistic UI
- 使用 React Query 处理：
  - conversations / messages
  - goals / tasks / instances
  - runtime environments
  - schedule events
  - settings

#### 与当前代码的衔接

- 现有 `src/lib/api/goals.ts`、`src/lib/api/kiki.ts` 仍大量直连 store 或 mock。
- 需要改造成真正请求 API 的客户端数据层。

### F. 替换 telemetry：从临时文件升级为正式 run 记录

#### 当前问题文件

- `src/lib/server/goalTelemetry.ts`

#### 改造方案

- 保留“追加日志”的编程模型，但底层改为 `task_run_logs` + 文件落盘。
- 不再使用单全局文件 `kiki-goal-telemetry.json`。
- 进度读取改为按：
  - `userId`
  - `taskInstanceId`
  - `requestId`
  查询。

#### 存储策略

- 结构化进度状态写 SQLite。
- 大段原始流式文本按 run 分文件保存，例如：
  - `data/storage/users/<userId>/task-runs/<runId>/stream.ndjson`
  - `data/storage/users/<userId>/task-runs/<runId>/result.md`

### F1. 为后台常驻运行增加可恢复执行语义

如果希望浏览器关闭后任务仍继续，run 记录必须具备“可恢复”能力，而不仅仅是存最终结果。

#### 额外字段建议

- `task_instances`
  - `lease_owner`
  - `lease_expires_at`
  - `retry_count`
  - `next_retry_at`
- 新增 `task_run_queue`
  - `id`
  - `user_id`
  - `task_instance_id`
  - `status`
  - `assigned_connector_id`
  - `lease_owner`
  - `lease_expires_at`
  - `available_at`
  - `created_at`
  - `updated_at`

#### 语义说明

- Worker 取任务时先加 lease，防止重复执行。
- Worker 崩溃或异常退出后，lease 到期的任务可以重新领取。
- 浏览器不参与执行真相判断，前端只负责展示服务端状态。

### G. 引入认证与资源隔离

#### 新增目录

- `src/lib/server/auth/`
  - `session.ts`
  - `guards.ts`
  - `currentUser.ts`

#### 改造原则

- 所有 `app/api/*` 路由先解析当前用户。
- repository 层所有查询默认带 `userId` 条件。
- 所有页面 API 响应只返回当前用户数据。

#### 当前代码衔接点

- `src/components/settings/SettingsModal.tsx`
  - `account` tab 可作为用户信息入口。
- `src/components/layout/UserMenu.tsx`
  - 可挂载登录态、登出、设备管理入口。

### H. 增加数据迁移与兼容策略

#### 首次上线迁移

- 因当前历史数据只在浏览器本地，服务器端无法自动拿到所有旧数据。
- 需要提供一次性“导入浏览器现有数据”的迁移工具。

#### 建议方式

- 新增临时导入 API：
  - `POST /api/migration/import-local-state`
- 浏览器端读取：
  - `kiki.goals`
  - `kiki.conversations`
  - `kiki.runtime.environments`
  - `kiki.schedule.events`
  - `kiki.easter-egg-settings`
- 导入到服务器后，标记迁移完成，前端逐步关闭旧 `persist`。

#### 冲突策略

- 若服务器无数据，则直接导入。
- 若服务器已有数据，则提示用户：
  - 覆盖服务器
  - 仅导入缺失项
  - 放弃导入

### H1. 增加本机 Daemon 配置与运行状态持久化

除了业务数据，还需要为常驻 daemon 持久化独立配置与运行状态。

#### 建议本地文件

- `~/.kiki/runtime/config.json`
  - 默认 CLI 路径
  - 授权工作目录白名单
  - 默认 permissionMode
  - 自动启动开关
- `~/.kiki/runtime/device.json`
  - 本机 `deviceId`
  - 最近绑定信息
  - daemon 版本
- `~/.kiki/runtime/state.json`
  - 最近心跳
  - 最近成功执行时间
  - 当前运行 job

#### 为什么单独存

- 这些信息不适合混进业务 SQLite 表里。
- daemon 在无浏览器、无 Web UI 的情况下也需要自恢复。
- 即使 Web 服务暂时未启动，daemon 也能先完成自检和恢复。

### I. 渐进式实施顺序

#### Phase 0: 先落本机 Runtime Daemon 骨架

- 新增本地 daemon 入口、配置目录、日志目录。
- 提供手动启动与状态检查能力。
- 确认 daemon 脱离浏览器生命周期独立存活。
- 这一阶段不要求云端控制面落地，但要求接口命名不要把未来路线锁死。

#### Phase 1: 把调度器从浏览器迁到后台

- 识别并替换前端 `GoalSchedulerRuntime` 的真调度角色。
- 用后台 Worker 承接任务扫描、派发与恢复。
- 这是满足“关闭浏览器仍继续运行”的前置条件。

#### Phase 2: 建本地真源基础

- 建立本地 SQLite、repository、数据目录。
- 让 daemon、worker、Web UI 共享同一份本地真源。
- 在这个阶段就已经可以满足“单机关闭浏览器继续运行”。

#### Phase 3: 建服务端真源基础（为未来公开产品预留）

- 建立 SQLite、repository、auth 基础骨架。
- 落 `users / conversations / messages / goals / tasks / task_instances / settings` 基础表。
- 新增 `KIKI_DATA_DIR` 与数据目录管理。
- 本阶段对外能力仍可只服务本机模式，但 schema 与 repository 必须兼容未来云端部署。

#### Phase 4: 落地后台 Worker/Daemon

- 新增 `goalSchedulerWorker`、`taskDispatchWorker`、`recoveryWorker`。
- 提供本地脚本启动与守护方案。
- 确保浏览器关闭后仍可推进任务。

#### Phase 5: 把前端核心 store 迁到 API

- 优先迁移：
  - `conversationStore`
  - `goalStore`
  - `runtimeEnvStore`
  - `scheduleStore`
- 让页面数据来自 API，而不是 localStorage。

#### Phase 6: 替换 telemetry 与任务执行链路

- 将 `goalTelemetry.ts` 改造成正式 run 存储。
- 任务执行记录进入数据库。

#### Phase 7: 落地云端控制面/Connector MVP

- 支持用户本机登录 Connector。
- 支持在线心跳、环境上报、任务拉取、结果回传。
- Web 端显示“设备在线/离线”和默认运行环境。
- 这是二期方向，不作为当前第一阶段阻塞项。

#### Phase 8: 浏览器旧数据迁移与清理

- 提供导入工具。
- 下线核心 `localStorage persist`。
- 仅保留 UI 偏好类轻量本地状态。

## Proposed File-Level Changes

### 现有文件改造

- `src/lib/api/goals.ts`
  - 从直接读 `useGoalStore.getState()` 改为真实 HTTP API 客户端。
- `src/lib/api/kiki.ts`
  - 去除 mock 依赖，改为服务端消息/草案接口。
- `src/stores/goalStore.ts`
  - 从持久化领域 store 改为页面级缓存与动作分发层。
- `src/stores/conversationStore.ts`
  - 从 localStorage 真源改为服务端 hydration。
- `src/stores/runtimeEnvStore.ts`
  - 改为读取用户可用 Connector/环境。
- `src/stores/scheduleStore.ts`
  - 改为服务端 CRUD，不再直接写 `window.localStorage`。
- `src/stores/easterEggSettingsStore.ts`
  - 从 localStorage 持久化改为服务端 `user_settings`。
- `src/lib/server/goalTelemetry.ts`
  - 改为 repository + artifact storage。
- `src/app/api/claude/chat/route.ts`
  - 加入认证、会话持久化、消息持久化、run 持久化。
- `src/app/api/goals/tasks/execute/route.ts`
  - 改为创建 run 记录并派发给 Connector。
- `src/app/api/runtime-envs/discover/route.ts`
  - 改为查询用户在线 Connector 报告的环境。
- `src/app/api/runtime-envs/status/route.ts`
  - 改为检查用户环境状态快照，而非直接探测服务器本地路径。
- `src/components/settings/SettingsModal.tsx`
  - 新增账号、设备、守护进程安装状态、同步状态、数据管理入口。
- `src/components/layout/UserMenu.tsx`
  - 新增登录态/登出/Connector 管理入口。
- `src/components/settings/RuntimeEnvironmentPanel.tsx`
  - 从“CLI 可用性面板”升级为“设备/daemon 状态面板”。
- `src/components/settings/LocalRuntimeWizard.tsx`
  - 增加 daemon 安装、LaunchAgent 启用、授权目录确认流程。

### 新增文件

- `src/lib/server/db/client.ts`
- `src/lib/server/db/schema.ts`
- `src/lib/server/db/migrations/*`
- `src/lib/server/repositories/*.ts`
- `src/lib/server/auth/*.ts`
- `src/lib/server/storage/*.ts`
- `src/app/api/auth/*`
- `src/app/api/conversations/*`
- `src/app/api/settings/route.ts`
- `src/app/api/connectors/*`
- `connector/src/*`
- `src/lib/daemon/*`
- `src/bin/kiki-runtime-daemon.ts`
- `packaging/macos/com.kiki.runtime-daemon.plist`

## Verification Steps

### 功能验收

1. 新注册用户登录后，在 A 设备创建会话、目标、任务、日程、运行环境与设置。
2. 换 B 设备登录，确认历史完整可见。
3. 关闭浏览器后，仅保留本地 Web/API + Worker + Connector 进程运行，确认到期任务仍会继续触发。
4. 退出并重新登录，确认服务端数据恢复正常。
5. 重启应用服务进程，确认 SQLite 与文件存储中的历史仍可恢复。
6. Worker 重启后，可恢复处理 lease 过期的未完成任务。
7. Connector 在线时可成功领取任务、回传结果、保存 sessionId。
8. Connector 离线时，任务保持可追踪的排队/失败状态，而不是静默丢失。
9. 删除某个会话或目标后，只影响当前用户，不影响他人数据。
10. 安装 `LaunchAgent` 后，用户重新登录 macOS，daemon 自动拉起并恢复在线。

### 技术验收

- 数据库文件位于 `KIKI_DATA_DIR`。
- 产物与日志文件位于用户隔离目录中。
- 所有核心查询都带 `userId` 约束。
- 前端在清空浏览器 localStorage 后，重新登录仍能恢复历史。
- 不再依赖 `os.tmpdir()` 保存正式业务数据。
- 不再依赖浏览器中的 `useEffect/setInterval` 作为任务调度真源。
- 浏览器关闭后，后台 Worker 仍能独立推进任务。
- 本地 daemon 有独立配置目录、日志目录与自恢复状态文件。
- `pnpm lint` 通过。
- `pnpm build` 通过。

### 回归重点

- `/goal` 多轮信息收集与草案生成链路。
- 会话重命名、右键菜单、消息历史展示。
- 任务执行结果页、日志时间线、停止执行。
- 设置页运行环境展示、默认环境选择、状态刷新。
- 日程页事件增删改查。

## Risks

- 若过早把全部领域模型一次性强关系化，迭代成本会偏高；因此部分波动结构建议暂存 JSON。
- 若不先做认证与 `userId` 隔离，后续数据迁移会很痛。
- 若继续让服务端直连本地 CLI，会在公网产品场景下完全失效。
- 若继续保留浏览器为主真源，会导致多端一致性和恢复能力始终不可靠。

## Recommended Execution Order

1. 先做本机 `Runtime Daemon + LaunchAgent`，保证浏览器关闭后仍有后台执行主体。
2. 再把调度器从浏览器迁到后台 Worker。
3. 再做本地 SQLite、repository、数据目录，形成本地真源。
4. 再迁 conversations/goals/runtime/settings/schedule 到 API 和持久化层。
5. 再重构 telemetry 与 task run 持久化。
6. 最后按公开产品方向接入云端控制面/Connector，并清理浏览器旧持久化。

## Current Recommendation

针对你现在的目标，最直接的答案是：

- 是，可以做到“浏览器关闭后继续按计划运行”，但前提不是单纯换存储。
- 必须新增本机常驻 `Runtime Daemon`，并用 `LaunchAgent` 守护。
- 必须把当前 [GoalSchedulerRuntime.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/GoalSchedulerRuntime.tsx#L432-L456) 里的浏览器调度迁到后台 Worker/Daemon。
- 必须把运行状态、任务队列、执行日志写入本地 `SQLite + 文件存储`，而不是只存在浏览器或 `os.tmpdir()`。
- 在“一期本机优先，但接口预留”的路线下，这套方案是最稳、实现成本也最低的。
