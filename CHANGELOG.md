# Changelog

本文件记录产品与工程迭代的主要变化。格式按时间倒序维护，提交前需过滤本地测试数据、临时路径、密钥和运行时数据。

## 2026-07-06

### Removed
- 完整下线 legacy Goal 规划命令（`/goal`），规划链路统一收敛到 Topic Init Saga（`/topic`）：
  - 删除 slash 命令定义中的 `goal` 条目与联合类型成员，`/goal` 不再被解析为命令。
  - 删除服务端 `src/lib/server/goalPlanning.ts` 单体规划器（`generateGoalPlanWithClaude`、澄清/信息收集、checkpoint 读写恢复等 Goal-only 编排），以及仅其使用的私有 helper。
  - 删除客户端 `src/lib/api/goals.ts` 规划客户端与 `goalWorkflow.ts` 中的 Goal-only 编排函数（`runGoalPlanning`、`startGoalInfoCollection`、`continueGoalWorkflowAfterInfo`、`resumeGoalWorkflowFromCheckpoint`、`resumeGoalWorkflowFromRecovery` 等），保留被 Topic UI 复用的 `commitGoalDraftToStores`/`replaceGoalDraftInStores`。
  - 删除 `topicPlanning.ts` 中已无消费者的 legacy re-export 别名，仅保留 Saga 入口。

### Changed
- 抽离 6 个被 Topic Saga 复用的共享 prompt builder 到新模块 `src/lib/server/goalPlanning/promptBuilders.ts`（Interviewer / Planner / Presenter 角色锚点与规划回归 spec 改为引用该模块），使其不再依赖已下线的 legacy 编排。
- 侧边栏助手（`assistantStore`）的规划入口从 `/goal` 迁移到 `/topic` Saga，并完整移植多轮澄清（`awaiting_user`）续答：以累积问答 history 作为上下文重放，避免多轮后早期答案丢失。
- 会话视图（`ConversationView`）删除 `command === "goal"` 分支、信息收集续答分支与 goal checkpoint/recovery 恢复子路径，保留基于 `planningRunState.source === "saga"` 的 Saga 失败恢复路径。
- 任务默认超时阈值 `taskDefaultTimeoutMs` 从 10 分钟（600000）上调至 30 分钟（1800000，配置允许上限）：单段连续执行时间较长的任务不再频繁被看门狗（`runGoalWatchdogWorker`）中途判超时暂停。
- 引入统一设计 token 体系与组件视觉重构：`globals.css` 定义文本/边框/表面/品牌/语义色等 CSS 变量，`tailwind.config.ts` 接入 token；新增 `ConfirmDialog` 全局确认弹窗（基于 `@radix-ui/react-alert-dialog`）并接入 `sonner` toast、`@radix-ui/react-popover`，多组件改用 token 与统一交互控件。

### Fixed
- 修复看门狗超时计龄导致的「续跑→秒超时→再续跑」死循环：`runGoalWatchdogWorker`（`src/lib/server/scheduling/goalSideEffects.ts`）原以 `instance.createdAt` 计算执行超时 age，使久存且反复暂停/续跑的实例刚进入 `in_progress` 就被立即判超时并暂停（线上一任务因此累计跑 77h 仍未通过）。改为优先用 `execution.activeSince`（当前执行片段起点）计龄，回退到 `execution.startedAt` / `createdAt`；`awaiting_user` 心跳分支保留原 `createdAt` 语义不变。

### Deprecated
- 将 Goal 规划相关路由改为 410 墓碑并返回迁移提示（引导使用 `/api/topics/plan`），保留一个迭代观察窗口后再物理删除：`/api/goals/plan`、`/api/goals/plan/resume`、`/api/goals/plan/checkpoint`、`/api/goals/clarify`、`/api/goals/collect`、`/api/goals/progress`。执行运行时的 `goalTelemetry` 与任务执行进度接口不受影响。

### Notes
- `goalInfoCollection` 的持久化基础设施（会话命令类型、store reducer、repository、DB 列 `goal_info_collection_json`）按最保守策略保留，仅移除前端写入方；本次不做破坏性 schema 变更。
- 本地 daemon 无改动，版本保持 `@kiki_agent/daemon@0.2.25`。

### Verification
- 通过 `pnpm build`。
- 通过 `pnpm tsc --noEmit`。
- 通过 `pnpm lint`。
- 通过 Topic Saga 与 prompt 去重专项 spec（`topicInitSaga` / `runTopicInitSagaDefaults` / `sagaDraftAdapter` / `promptDuplicationGuard`）。

## 2026-07-03

### Changed
- 云端/本地任务续跑链路新增 `resumeSessionId` 与 `executionMachineId` 透传：调度器会优先把任务派回原执行 machine，Claude 续跑中 fork 出的新 session id 也会实时回写到 runtime job，避免断点续跑丢失最新会话锚点。
- 本地 daemon 收到重复 `execute` 时新增运行中与僵尸态区分：真正仍在执行的 job 直接忽略，controller 已失效但 `runningJobs` 残留时先回收再重跑，减少 hello 上报里的假 running 占位。
- 调度器对循环任务的预筛增加 paused 实例冻结语义；同一任务存在已暂停实例时不再继续 fan-out 新实例，保持“暂停”而非“继续追加执行”。
- 删除会话前会先终止关联 active dispatch、取消 runtime job 并释放 lease，避免数据库记录删除后本地 daemon 仍保留残留运行态。
- 本地 daemon 包版本升级到 `@kiki_agent/daemon@0.2.25`，发布任务续跑会话保持与僵尸任务回收修复。

### Fixed
- 修复 Claude 任务续跑依赖旧 session id 时，一旦原会话失效就直接失败的问题：现在会先清除失效 session，再保留 `resumeContext` 做一次软续跑重试。
- 修复 Tunnel lease 续租失败后把 `awaiting_user` 误当成普通失活任务回收的问题，避免工具授权等待中的任务被提前释放 active dispatch 和并发预算。
- 修复 runtime session 所属 machine 离线后仍尝试带着陈旧 `resumeSessionId` 下发的问题；若原 machine 不在线，会清除 session 绑定并回退到普通执行。
- 修复任务暂停/恢复、Tunnel 调度和本地 worker 链路未完整保留 `resumeSessionId` / `executionMachineId` 的问题，避免恢复后退化为重新开始。
- 修复会话删除后 daemon 进程内残留 running job 占满并发槽，导致后续任务无法派发的问题。

### Added
- 新增 Claude transport、task dispatcher、task scheduler、dispatch pause service 等规格测试，覆盖 session id 提升/失效清理、离线 fallback、paused 循环任务冻结和恢复链路保留 session 绑定。

### Verification
- 通过 `pnpm test:planning`。
- 通过 `pnpm build`。
- 通过 `pnpm tsc --noEmit`。
- 通过 `pnpm lint`。
- 通过 `packages/daemon` 的 `npm run build`。

## 2026-06-25

### Changed
- 本地 daemon 包版本升级到 `@kiki_agent/daemon@0.2.24`，发布 `kiki-daemon log/logs` 实时日志查看能力。
- Runtime 状态快照接口增加 ETag/unchanged 返回，前端 RuntimeEventBridge 在 SSE 断线恢复、跨标签同步和批量事件收敛时复用已知 ETag，减少重复全量 `/api/runtime/state` 拉取。
- SSE 空闲心跳改为注释帧并增加空闲退避，降低无事件会话的轮询与 DB 压力；生产自定义 server 增加文本/JSON 响应压缩，排除 SSE 流。
- 机器 tunnel WebSocket 开启消息压缩，并对 daemon hello 做状态签名去重；存在运行中 job/治理 tick 时仍按周期续发 hello 以续租。
- 后端日志面板在页面隐藏时暂停轮询，恢复可见后继续刷新，降低后台标签页负载。
- 会话列表摘要只返回截断后的预览文本（最长 500 字），并剥离 `cliProcess` 等大字段，避免首屏会话列表被大输出拖垮；`lastMessageAt` 保留服务端按 `MAX(created_at)` 计算的结果。

### Fixed
- 删除本地 Runtime 环境改为确认后立即从本地投影移除，服务端失败时回滚；检测刷新返回时若环境已删除则跳过持久化，避免“检测中”和删除互相抢 revision。
- Runtime 命令遇到服务端 404 时会刷新快照，清理浏览器侧已不存在的陈旧 Runtime 投影。
- 助手消息中的工具授权卡片按 CLI 事件时间线展示，避免最终回复先于授权卡片造成上下文顺序混乱。
- **[核心修复]** 修复生产响应压缩在背压下死锁导致 `/api/runtime/state` 永不返回、“目标规划”侧栏一直卡在加载态的问题：根因是压缩包装器把数据缓冲在 compressor 而非 socket，而 Next 的 body pump 在首个 `res.write()` 前就注册了 `res.on("drain")`，导致等待的 drain 永不触发。修复改为缓冲早于 compressor 创建的 drain 监听并重定向到 compressor，双向打通背压（socket 满则暂停 compressor，compressor drain 唤醒生产者），并在客户端中断（socket close）时销毁 compressor 释放缓冲。
- “目标规划”侧栏改为基于 `goalId` 存在即渲染，本地目标投影缺失时展示加载态并主动拉取 `/api/runtime/state` 重新同步，修复点击“目标规划”无响应。

### Added
- `kiki-daemon log` / `kiki-daemon logs` 子命令：默认显示最近 200 行 `daemon.log` 并实时跟随，支持 `--lines`/`--tail` 和 `--no-follow`。
- 新增 daemon log、Runtime 快照 ETag、Runtime 删除乐观投影、助手消息时间线和 RuntimeEventBridge 快照应用回归测试。
- 新增响应压缩背压（忠实复刻 Next body pump 注册顺序的 br/gzip/identity 往返）与 GoalPlanDrawer 缺失目标加载态回归测试。

### Verification
- 通过 `pnpm test:planning`。
- 通过 `pnpm build`。
- 通过 `pnpm tsc --noEmit`。
- 通过 `pnpm lint`。
- 通过 `packages/daemon` 的 `npm run build`。

## 2026-06-24

### Changed
- 账号/设置入口在桌面端恢复为侧边栏左下角头像；移动端改为底部导航中的“我的”入口，避免小屏幕左下角浮动头像难以点击。
- 任务监控面板默认宽度调整为 400px，拖拽范围收敛到 350px-500px；任务详情抽屉宽度限制在 450px-600px，多面板并排时按可用宽度动态分配，避免详情与监控互相挤占全屏。
- 任务执行新增并发上限排队提示：达到账号最大并发数时新任务进入排队状态，UI 给出明确提示，不再直接失败或无反馈。
- 任务暂停/恢复升级为上下文续跑：暂停时保存 runtime job 的 progress、logs、trajectory 与 resumeContext，恢复时复用同一实例并携带旧轨迹进入增量执行模式。
- 本地 daemon 包版本升级到 `@kiki_agent/daemon@0.2.23`，用于发布工具授权跨进程共享修复。

### Fixed
- **[核心修复]** 彻底解决工具授权请求“立即点击依然提示过期”的问题：根因是 Next.js 自定义 Server（编排侧创建请求）与 API Routes（用户侧响应授权）是两份独立 Bundle，模块级 `const Map` 内存不共享；将 pending 授权请求和会话级授权规则挂载到 `globalThis` 通过 `Symbol.for` 共享，彻底消除跨 Bundle 状态隔离。
- 修复点击“始终允许并写入 Runtime 策略”后同一工具仍反复弹窗的问题：任务续跑/下发前会刷新最新 Runtime `filePolicy`，不再使用入队时缓存的旧策略。
- 修复“本会话内始终允许”在云端与本地 daemon 跨进程时失效的问题：会话级工具授权规则会随 job/tunnel payload 下发到 daemon，并在 daemon 侧灌入本地 session rule store。
- 工具授权审计日志按用户回应 scope 区分本次允许、会话内始终允许、Runtime 策略写入和拒绝；仅在规则真正新增时记录 `tool_permission.rule_persisted`。
- 修复任务停止/暂停只更新云端状态、未真正中止本地 daemon 执行的问题；现在云端会向 active machine 下发 `cancel`，daemon 通过 `AbortController` 中止正在运行的任务。
- 修复 `停止/中止` 文案未被识别为终止语义，可能把 cancelled runtime job 合成为 `paused` 并被错误恢复的问题。
- 修复任务监控抽屉操作（开始/暂停/恢复/重跑）缺少通知反馈的问题，增加行内 notice 提示区。
- 修复会话页、日程页和结果页隐藏 `UserMenu` 后，头像入口消失且设置弹窗无法通过全局事件打开的问题。
- 补齐任务面板布局在宽监控栏、仅开监控等场景的边界测试。

### Added
- 新增 pause/resume checkpoint 构建逻辑和回归测试，覆盖全局暂停恢复、Tunnel cancel 下发、迟到执行结果忽略和恢复 payload 携带旧轨迹。
- 新增任务调度下发回归测试，覆盖 runtime 级工具规则刷新与会话级工具规则跨进程携带。

### Verification
- 通过 `pnpm test:planning`。
- 通过 `pnpm build`。
- 通过 `pnpm tsc --noEmit`。
- 通过 `pnpm lint`。
- 通过 `packages/daemon` 的 `npm run build`。

## 2026-06-23

### Changed
- 任务详情、任务监控和助手抽屉改为通过统一布局计算分配宽度，窄视口下多面板并存时不再超出屏幕。
- 任务结果展示增加外层摘要去重与内部运行元叙述清洗，避免把工具权限、Runtime 限制或重复摘要写进用户可见交付物。
- 主题任务列表为待执行任务展示下一次触发时间，帮助区分“立即开始”和“按计划稍后执行”。

### Fixed
- 修复删除会话确认弹窗被侧栏层叠上下文限制，无法覆盖底部输入框的问题。
- 修复任务进入 `awaiting_user` 等待工具授权后，Tunnel 收尾逻辑提前取消 pending 授权请求，导致用户点击允许时提示“该工具授权请求已过期或不存在”的问题。
- 修复多任务侧边栏在 1024px 等窄视口下互相挤出屏幕的问题。
- 清理本地 mock HTML 中形如真实 machine api-key 的示例值，改为不可用占位符。

### Added
- 新增任务面板布局、任务消息展示、任务结果清洗、结果解析和工具授权恢复回归测试。

### Verification
- 通过 `pnpm test:planning`。
- 通过 `pnpm build`。
- 通过 `pnpm tsc --noEmit`。
- 通过 `pnpm lint`。

## 2026-06-22

### Changed
- 多角色任务执行链路重构：按任务真实结果面决定角色写权限，普通 `visual_report` 不再默认进入多角色链，Presenter 只输出装配计划，最终结果由 Executor 的 `candidateBlocks` 确定性装配，避免内部角色/工具权限叙述泄漏到交付物。
- 任务执行提示词放开真实阻塞点逃生通道：执行中若出现无法靠检索、推理或执行消解的关键分叉，可结构化抛出 `during_execution` 用户确认；偏好反馈与“是否满意”仍归入 `suggested_actions`，不阻塞当前任务。
- 任务执行并发上限改为账号级云端持久化配置：手机和 PC 都从服务端回填 `maxConcurrentTasks`，云端 orchestrator 按用户配置派发任务，本地浏览器缓存不再反向覆盖服务端。
- Slash command 对外入口从 `/saga` 更名为 `/topic`，内部 Saga 实现命名保持不变，避免外部命令和内部架构概念混淆。
- 会话列表与移动端主导航继续收敛窄屏布局：会话页自带滚动与底部安全区，移动端底部导航保留收件箱、会话、日程三个主入口。
- 会话页移动端底部输入区改为固定在底部导航上方，并为消息列表增加安全区留白，避免输入框和最后一条消息被底部导航遮挡。
- Runtime 适配层扩展到 Claude / Pi / Cursor / Codex：注册表、运行环境向导、设置页、会话与目标规划入口统一识别四类本地 CLI。
- Cursor 运行时切换为 `cursor agent acp` JSON-RPC 通道，支持会话恢复、流式事件解析、工具调用映射、`session/request_permission` 审批桥接和 `.cursor/cli.json` 权限 overlay。
- Codex 运行时接入 `codex exec --json`，按权限模式映射 read-only / workspace-write sandbox；首版显式禁用 KiKi 手动确认弹窗，并在 UI 中提示限制。
- 项目概览和 daemon README 更新为多 Runtime 说明，避免继续把本地执行节点描述为 Claude-only。
- SQLite 用户库默认启用 `auto_vacuum=INCREMENTAL`，云端控制面增加受低峰窗口、磁盘水位、freelist 阈值和单轮库数限制保护的轻量后台回收，降低 Railway Volume 存储浪费。
- 任务执行二次准入改为基于 `composeGoalsWithRuntimeJobs` 的合成状态判断依赖完成度，避免 raw projection 滞后时把已完成上游误判为 pending。

### Added
- 新增多角色编排装配与元叙述清洗规格测试，覆盖无 id block 重排删除、工具权限提示边界、真实用户决策上抛和安全清洗误伤边界。
- 新增 `user_runtime_settings` 用户级运行配置表、仓储与规格测试，用于保存跟账号走的运行参数。
- 新增 Cursor ACP client、parser、permission resolver、tool policy 与环境清洗模块，并补充 Cursor/Codex adapter 规格测试。
- 新增 `reclaim:sqlite` 运维脚本和 SQLite 存储维护模块，支持只读扫描库体积、手动 `VACUUM INTO` 完整压缩、压缩后完整性校验、原子替换和结构化维护日志。
- 规划规格入口纳入 Cursor ACP 权限解析、Cursor adapter 与 Codex adapter 覆盖，防止 runtime registry 与协议解析回退。

### Fixed
- 修复多角色 Presenter 被只读降权后误把“当前 runtime 已禁用写入文件工具”写进最终报告的问题；任务模式下不再要求 Agent 复述工具禁用状态。
- 修复多角色执行中 Executor 已写入文件但 Synthesizer 不知道真实落盘事实的问题；现在从写工具调用流捕获路径，files 任务会回读真实文件生成 artifact。
- 修复手机端任务执行情况显示默认并发 `3`，而 PC 已设置为 `1` 时两端不一致的问题；新浏览器打开页面只会读取账号配置，不会把本地默认值写回云端。
- 修复 SQLite 后台维护先截断 active 用户列表再判断是否需要回收，导致后续大库可能长期饥饿的问题；现在只限制实际执行回收的库数量。
- 修复存量 SQLite 库完整压缩后未切换到 `auto_vacuum=INCREMENTAL` 的问题，确保压缩后的旧库也能参与后续增量回收。
- 修复调度器预筛已通过但 `startTaskAttempt` 再次裸读 raw snapshot 造成下游任务被 `blocked_config` 拦截的问题。

### Removed
- 过滤本地 Cursor ACP 探测脚本和个人工作目录 fixture，避免临时测试流程与本机路径进入提交。

### Verification
- 通过 `pnpm test:planning`。
- 通过 `pnpm build`。
- 通过 `pnpm tsc --noEmit`。
- 通过 `pnpm lint`。

## 2026-06-21

### Changed
- Web 前端完成移动端适配：手机端隐藏桌面左侧栏，新增底部导航，并将助手、CLI 过程、任务详情、任务结果、任务监控和创建/编辑抽屉改为移动端全屏覆盖层。
- 收件箱、会话列表、会话消息、主题规划、日程、设置、运行环境向导和任务结果内容补齐窄屏布局；表格/电子表格改为容器内横向滚动，iframe 小应用在移动端限制高度并保留外部打开兜底。
- 会话写桥改为同步直接调整：用户在会话里要求改任务、重跑或恢复时，会复用治理命令服务即时落盘并返回结果，治理 tick 仅负责后台对账与后续校正。
- `redo_now` 会先更新任务定义再抢占旧执行并重新入队，避免运行中任务被 `already_running` 闸拦住后用户反馈无效。
- 任务执行状态统一以 `runtime_jobs` 合成视图为权威，调度、监控、暂停/恢复和任务上下文读取不再依赖滞后的 projection。
- Claude 工具返回结果进入主执行流，区分基础设施/网络策略失败与业务工具失败，并对持久化错误文本做脱敏截断。
- 会话上下文新增最近任务结果摘要注入，只保留标题、状态、摘要、关键结论、产物名和 blocker，避免 Agent 需要用户重复复述历史任务结果。
- 任务监控执行时长改为活跃执行时长，暂停时间不再计入“已执行”展示。

### Fixed
- 修复移动端日程页强制把周视图切回日视图的问题；现在只在首次移动端进入时默认日视图，用户仍可手动切换周/月视图。
- 修复月视图桌面端事件可见数量被移动端降级影响的问题；桌面恢复最多展示 3 条事件，移动端保持紧凑展示。
- 修复会话中 `task_interaction_request` 用户补充信息请求消息未渲染的问题，并恢复消息反馈清除链路。
- 修复删除会话时仅存在于 `runtime_jobs.payload_json` 的 queued/paused 运行记录未被级联清理的问题。
- 修复 `replan` 直接走整盘替换会丢失任务历史、且活跃目标可能返回 409 的问题；当前会降级为澄清/改任务路径。
- 修复已完成任务在 resume-all、手动执行或 blocked 恢复时被再次拉起的问题；completed job 现在会返回 `already_completed` 并空操作。
- 修复运行中任务收到会话反馈后无法立即改完重做的问题；重跑前会真实终止旧 open job，再创建新实例。
- 修复工具失败被统一当作业务缺口的问题；环境拦截类失败会单独记录为 infra failure，减少误导用户补充无关信息。

### Added
- 新增移动端 viewport hook 与 `MobileBottomNav`，统一手机端收件箱、会话、日程、助手/过程入口，并避免底部悬浮入口互相遮挡。
- 新增治理 apply telemetry、治理意图/门控、调度暂停、blocked 恢复、任务实例合成态和执行时长规格测试。
- 新增 Claude 连通性检查脚本，用于排查本地网络、DNS、TLS 和企业网络策略对 Claude/Anthropic 访问的影响。

## 2026-06-20

### Changed
- 机器隧道命令协议收敛：服务端 `tunnelHub.ts` 引入 `MachineCommandRegistry` 统一描述各命令的超时、requestId 前缀与结果解析，并将分散的 `pendingXxx` 队列合并为单一 `pendingRequests` 生命周期管理；`remoteDaemonLoop.ts` 改为注册表式 `commandHandlers` 分发，替代长 `if/else` 链，避免命令定义与执行实现脱节。
- 任务结果卡片标题去重增强：除首个 heading 外，新增对首个段落与 markdown 标题行的同标题识别，并在比较前归一化日期（如 `（2026/06/20）`、`2026年6月20日`），减少产出物正文与卡片标题的重复展示。

### Fixed
- 修复远程取消语义：`cancel` 命令不再伪造 `execute/failed` 终态回执，改为仅记录显式 unsupported 日志，避免提前 resolve `pendingExecutes` 并触发运行中任务的错误状态流转与真实结果回传时的二次冲突。

## 2026-06-18

### Changed
- 任务结果卡片改为“产出物为主体”的内联展示：长报告、结构化文档和交互产物可在会话内预览，并支持一键全屏展开阅读，减少卡片内嵌套滚动的负担。
- 任务监控抽屉新增全局暂停/恢复入口：暂停会阻止新任务派发，并将待执行、执行中的任务统一转为可恢复状态；恢复时按本地 Runtime 可用性重新排队。
- 治理 tick 派发前会刷新 topic/thread snapshot，补齐当前任务列表、近期实例和线程列表，避免远端治理模型基于过期快照重复派发任务。

### Fixed
- 修复治理 job 在 lease 后 entity revision 已变化时仍继续派发的问题；现在会在派发前识别 stale revision 并提前失败，避免浪费 LLM 调用且减少后续回执冲突。
- 修复 thread governance payload 缺少 `currentTasks` / `recentTaskInstances` 时重复任务校验被绕过的问题，并补充协议校验与回退兼容。
- 修复治理动作展示与通知中缺少 `update_task` / `cancel_task` 细节的问题，提升治理变更在会话和收件箱里的可读性。

### Added
- 新增 `ExpandableContentCard`、`DeliverableArticle` 与内容溢出检测 hook，统一任务产出物的折叠预览、全屏展开和阅读遮罩能力。
- 新增任务调度全局暂停 API `/api/runtime/daemon/dispatch-pause` 及服务端暂停/恢复服务。
- 补充治理派发、协议校验和调度边界规格测试，覆盖 snapshot 刷新、stale revision 拦截、重复派发检测和全局暂停调度。

## 2026-06-17

### Changed
- 会话任务询问卡片改为独立的 `task_interaction_request` 消息组件：用户提交补充信息后前端立即乐观更新，历史询问卡片不再被后续任务输出覆盖，新内容按新消息追加。
- 会话消息与 CLI 过程聚合继续收敛：消息更新、导入、反馈与任务交互提交保持 append-only 语义，降低历史消息被运行时结果误覆盖的风险。
- 远程 Runtime 流式调用补齐附件透传，Claude transport 与 tunnel payload 对齐图片/文件输入字段。
- 治理 tick lease 链路增强为长耗时安全：daemon 执行治理期间会通过 WS hello 与 HTTP polling 上报运行中的 governance job，云端据此续租；过期 lease 增加 grace 抑制，避免刚过期即重复重发。
- 治理回执处理补充 machine/user 上下文，云端控制面启动时即注册治理 result listener，避免第一帧前或无用户上下文时丢失回执。

### Fixed
- 修复任务监控中“暂停”和“停止”语义混同的问题：暂停保持可恢复并进入已暂停列表，停止会终止本次实例并进入已完成列表显示“已终止”，支持重新执行；同时补齐已暂停实例再停止时不被旧 runtime job 覆盖的状态投影边界。
- 修复 Topic / Thread 治理 job 在长耗时执行后因旧 `leaseToken` 回执被拒而永久卡在 `leased` 的问题；现在同一 lease owner 的旧 token 回执会在 revision 校验保护下被接受并完成落库。
- 修复治理 job 失败后同 revision 幂等键阻塞后续重试的问题：failed job 再次到期时会重置为 queued。
- 修复任务交互提交后新生成结果可能覆盖历史询问卡片的问题，保留用户询问/提交历史的独立消息视图。

### Added
- 新增长耗时治理死锁模拟规格，覆盖 `token A` 执行中超时、云端重租为 `token B` 后旧 token 回执仍能完成 job 的场景。
- 增加治理 lease 关键日志：lease 获取、过期回收、续租、宽容接受旧 token、完成与失败均输出结构化埋点，便于 Railway 后续排查。

## 2026-06-16

### Changed
- 会话内联执行时间线继续升级为“主事件流 + 子代理分区”：普通思考、普通工具调用与输出仍按时间顺序展示，连续发起的 `Task` / `Agent` 子代理会在同一入口下拆成各自独立的滚动区域，避免多个子代理的工具调用混在一条时间线上难以区分。
- Claude stream transport 会为 `Task` / `Agent` 工具调用补充稳定的子代理调用 id，并把子代理描述、类型等元信息回填到后续 `subagent_event`，前端刷新或回灌后仍能恢复正确的分组关系。
- 会话过程侧边栏将普通 `Tool Calls` 与 `Subagents` 分开展示，减少子代理过程和普通工具调用混在一起的噪音。
- 消息分享按钮增加生成中的 loading 态与重复点击保护，生成分享卡片图片时会展示明确的进行中提示。

### Added
- 新增 `InlineCliProcessTimeline.spec.ts`，覆盖并行子代理分组与“两个子代理批次之间夹普通工具调用”时的顺序边界，防止主时间线被错误合并。

### Fixed
- 修复多个子代理并行时行为记录难以区分的问题：每个子代理现在在自己的区域内滚动更新，不再共享一条平铺日志。
- 修复多批次子代理调用被错误合并到同一个入口、导致后发起的子代理提前出现在主时间线中的问题；现在只有连续的子代理调用才会归为同一组。

## 2026-06-14

### Changed
- 设置弹窗的账户页改为读取当前登录用户信息：`UserMenu` 会向 `SettingsModal` 透传用户对象，账户卡片与资料字段不再展示硬编码的昵称和邮箱，而是显示真实账号信息并兼容未加载态。
- 账户设置继续扩展为可编辑个人资料：新增昵称修改与密码修改表单，前端通过受保护的 `/api/auth/profile`、`/api/auth/password` 接口提交，成功后会同步刷新左下角用户菜单中的显示信息。
- 会话内联 CLI 时间线改为更紧凑的展示：过滤 prompt/status/assistant_trace 噪音事件，统一中文 badge 与摘要文案，减少消息气泡中的过程噪声。
- Claude 会话桥接与运行时上下文链路继续收口：resume session 仍由服务端按 runtimeKind 单点持久化，同时补齐 Pi/Claude transport、remote CLI proxy 与 workspace context pack 的对齐。
- 任务规划链路继续强化交付导向：task draft prompt 显式要求准备任务、构建任务、验收任务组成最小闭环，并在最终子目标下对齐目标交付契约，避免只产出准备性待办。
- planning review 与 compiler 继续收紧：review prompt 改为更保守的对齐评估，task compiler / goal planning 增加交付闭环审计、跨子目标依赖与失败恢复处理，降低“任务都相关但无法真正交付”的情况。
- 调度器与执行上下文增强依赖就绪判断：scheduler 会同时检查任务依赖、板块依赖和 runtime job 占用，任务执行上下文会把上游 blocker、依赖 digest 与软等待原因暴露出来。
- 设置页与会话页继续补强交互细节：`TaskMonitorDrawer`、`TopicPlanContent`、`ConversationView` 等组件适配了新的 planning / cli process 数据结构。
- 任务依赖语义进一步硬化：decompose / normalize prompt 明确区分 `triggerRule` 与真实 `dependencies`，要求把“X 完成后再做”的前置关系落到结构化依赖上，而不是只写进自然语言触发文案。
- blocked task 恢复链路增强为可累计多轮补充：恢复时会从历史 `interactionSubmission` 和 `resumeContext` 回收已提交字段，避免用户分多轮补充信息时重复丢字段、重复追问。
- 任务通知投递改为更稳的 append-only 账本：conversation/inbox 派发、deliveryState 标记和事件日志写入保持同事务，normal `result_ready` 旧通知会自动迁移到 conversation 语义，避免重试或补投时覆盖历史卡片。
- 会话列表排序收敛到 `conversationOrdering` 单一比较器，前端 store、侧边栏和服务端 repository 统一按置顶、最后消息时间、创建时间与 id 稳定排序。
- 任务就绪判定继续收紧：规划期 `requiredUserInputs` 会优先驱动 readiness，未知字段只接受字段名显式提交或单字段反馈，避免 options 子串跨字段误命中。
- 治理回顾 UI 增加历史弹层：Topic / Thread 页面可查看最近治理 tick、失败次数、静默次数和派发/更新/取消动作摘要。
- 将 `@kiki_agent/daemon` 版本提升到 `0.2.17`，配合本轮 runtime daemon API 与治理历史能力更新。
- 会话消息体验继续增强：Kiki 回复支持好评/差评、差评原因与备注提交，消息反馈会持久化到 `message_feedbacks` 表，并可在会话重新加载后恢复。
- 消息操作区新增复制与分享能力：支持将问答渲染成分享卡片图片并复制到剪贴板，新增 `html-to-image` 作为导出依赖。
- Runtime 工具权限从静态规则扩展为交互式确认：高风险工具调用可生成授权请求，用户可选择单次、会话或 Runtime 级授权，也可拒绝并触发任务恢复或替代路径。
- 任务执行链路透传工具权限状态：Claude / Pi / remote daemon / tunnel 会携带工具权限请求、授权结果和审计事件，前端 Runtime 设置页增加工具规则管理入口。

### Added
- 新增账户资料与密码修改接口，以及对应的服务端鉴权/校验逻辑：昵称限制 30 字以内，密码要求至少 8 位且同时包含字母和数字，并校验当前密码与新旧密码重复场景。
- 新增多组规划与调度规格测试：覆盖 `goalFactory`、task draft prompt、delivery closure audit、runtimeJobsRepository、task compiler 与 scheduler 相关边界。
- 新增 blocked task / notification / scheduler 相关规格测试，覆盖 `contextResolver`、`goalSideEffects`、`goalRuntimeService`、`sagaDraftAdapter` 等多轮恢复与通知派发边界。
- 新增治理历史 API `/api/runtime/governance-history`，从 agent runtime events 中按 topic/thread 查询治理 tick 记录。
- 新增 `EVALUATION_PLAN.md`，沉淀 KiKi 的节点级评测方案、黄金集/回放集/LLM-as-judge 分层路线与反馈闭环设计。
- 新增消息反馈 API `/api/message-feedback`、工具权限决策 API `/api/tool-permissions/[requestId]/respond`、`MessageFeedbackControls` 和 `ToolPermissionRequestDialog`。

## 2026-06-12

### Added
- 新增 machine tunnel WebSocket 优先通道：服务端在自定义 server 上挂载独立 `/api/machine-tunnel/ws` upgrade 端点，支持 header 鉴权、同机顶替、ping/pong 心跳、70s 入站看门狗与 close 即时离线回收；保留 HTTP 长轮询作为自动回退。
- daemon `0.2.8` 默认优先建立 WS tunnel，连接成功后发送 `hello` 重同步握手，断线按 1s→2s→30s 退避重连，连续快速失败后自动降级到 HTTP 长轮询。
- 新增邀请码多次使用能力：注册表增加 `max_uses`、`usage_count` 与 `invite_code_redemptions`，支持内置 `KIKIG00D` 多次兑换、显式批量创建邀请码，以及注册失败后的使用次数回滚。
- 新增 topic 级 governance tick 链路：包含 topic/thread 调度器、governance tick job/outbox repository、event bridge、本地执行器与 machine tunnel 协议扩展，支持把治理帧分发到在线 daemon 执行并按 lease 回传结果。
- 新增会话消息内联 CLI 时间线组件，可直接在消息气泡中查看运行状态、工具调用、子代理信息、prompt 输入与过程输出。

### Changed
- tunnelHub 支持按 machineId 优先路由到 WS 连接，无 WS 连接时回落到既有长轮询队列；在线判定合并 WS 内存连接与 DB 心跳。
- 会话事件 SSE 改为自适应轮询：活跃期 400ms、空闲期 2s，配合发送端约 120ms 的消息更新去抖合帧，观察方流式收敛更平滑、DB 压力更低。
- 将 `@kiki_agent/daemon` 版本提升到 `0.2.11`，进一步强化 WS tunnel 稳定性、goal task 终态回执与前台/后台运行提示。
- 将 `@kiki_agent/daemon` 版本提升到 `0.2.16`，新增 daemon 分层日志能力：默认记录生命周期、连接、心跳、命令、执行与流式元数据，支持结构化 `daemon.log`、大小轮转与显式 trace 双开关。
- Topic 初始化 Saga 运行过程现在可实时映射为 CLI 过程事件，前端可直接看到 Interviewer/Planner/Critic/Refiner/Spec/Presenter 的 prompt、输出和结构化结果。
- 将 daemon 主入口重构为 `composeDaemon` 分层装配：调度主循环、任务分发、lease/process 对账、thread governance 各自独立 runner，云端与本地可复用同一 runner 能力而不再耦合在单文件里。
- governance / scheduling 目录边界收紧：通过 ESLint 限制两层互相直接 import，只允许经 services/types 公共契约跨层协作；同时将 thread task 读取收敛到 `threadTaskView` 只读 adapter。
- 调度与治理链路补齐 observability：新增 scheduling/tick 结构化日志、tick recorder、时区描述与 orchestrator user frame 观测，便于排查 tick 漏跑、lease 回收和云端/本地执行分工。
- 将治理模型从仅 thread loop 扩展到 topic + thread 双层：topic runner 负责主题级状态评估、节奏调优与 loop 调整，thread runner 输出协议同步升级，治理回执与任务 patch 合并逻辑相应更新。
- 触发规则与时间计算模型重构为 `TriggerSpec`：统一支持 cron / 每日 / 每周 / 间隔 / 指定时间等表达，并显式纳入时区语义，减少 tick 调度对自然语言触发文案的脆弱解析。
- 会话与收件箱状态接口、conversation store 与前端列表同步增强：消息/cliProcess 合并逻辑更稳，消息页支持直接展示内联过程时间线，侧边栏与会话页会消费新的过程聚合数据。

### Fixed
- 修复 `message.updated` 乱序/重复回灌导致旧快照短暂覆盖新内容、词序错乱的问题；为每条消息增加 version 单调守卫，只应用更高版本快照。
- 修复消息删除后 module 级流式状态和已应用版本未回收，导致同 id 消息重生时被旧状态误判拦截的问题。
- 修复云端 machine 执行 goal task 后只回传 `ok:true/false` 的“瘦回执”问题；现在会把 `completed/failed/awaiting_user`、`blocker`、`trajectory` 与结构化结果一并回传，避免服务端误判任务状态。
- 修复 WebSocket tunnel 在 `perMessageDeflate` 压缩开启时的兼容性风险，服务端与诊断链路统一关闭压缩。
- 修复默认多次使用邀请码示例码中包含字母 `O` 导致与规则和肉眼识别不一致的问题，改为 `KIKIG00D`。
- 修复调度 worker 仍依赖旧 `executionSupervisor` 的单体所有者问题，统一切换到 `runtime/processSupervisor`，避免本地子进程生命周期管理继续散落在 worker 层。
- 修复远程 daemon 治理帧缺少 WS 补发与命令类型协商的问题，避免 topic/thread governance tick 在断线重连或 hello 对账后丢失。
- 修复 conversation store 合并本地流式输出与回灌快照时的内容回退、CLI 过程丢失与控制提示残留问题。

## 2026-06-11

### Fixed
- 修复 `kiki-daemon install` 仅校验 launchctl/systemctl 命令退出码、进程拉起后立即崩溃仍报"安装成功"的问题；install 后轮询确认进程稳定 running，失败时抛出明确错误并附带 `daemon.stderr.log` 末尾日志。
- 修复 Linux systemd 单元缺少 `StartLimitIntervalSec=0` 导致启动即崩时被默认节流（10s 内崩 5 次进 failed 永久不再拉起）的问题，保证无限重启。
- 修复 daemon 遇到 401 鉴权失败时与瞬时网络错误一视同仁、每 5s 无意义高频重试且日志静默的问题；改为区分鉴权失败并退避 60s，连续失败时周期性打印含失败原因、本机指纹与补救命令的醒目诊断。
- 修复网页开启 24h 运行时前台进程未退出、与 launchd/systemd 后台进程共用同一 machineId 并发争抢长轮询与命令队列导致任务丢失/心跳抖动的自冲突问题；后台服务确认 running 后前台进程在在途任务与流式会话完成后优雅退出。

### Changed
- 将 `@kiki_agent/daemon` 版本提升到 `0.2.7`，强化后台服务安装校验、鉴权失败诊断与单进程交接稳定性。
- 云端模式下 daemon 状态页改以服务端 `machines` 表心跳为单一事实来源，优先展示在线机器，其次回退到最近一次连接机器，避免 web 进程读不到用户本机状态文件时显示失真。
- 本地环境状态查询增加 45s 超时与更明确的报错；对长时间停留在 `checking` 的环境不再无限视作“检查中”，会自动重新刷新状态。

## 2026-06-10

### Added
- 新增会话记忆与用户记忆能力，包括 memory API、MemoryEditor、候选记忆、提升合并、digest gate、审计与互斥保护。
- 新增 Runtime Adapter 抽象层，接入 Claude/Pi adapter、adapter registry、Pi 环境解析、runtime transport 与文件 artifact 捕获。
- 新增会话过程侧边栏，用于在会话页查看 CLI 运行过程与聚合后的过程信息。
- 新增 KiKi 默认 skills 管理能力，包括本地/远程状态查询、安装 API、tunnel 指令与前端调用封装。
- 新增流式文件 artifact 回传与消息持久化支持，CLI 生成文件可作为会话附件展示。
- 新增远程 24h daemon 后台服务管理能力，支持通过 machine tunnel 查询、开启和关闭本机后台服务。
- 新增项目架构层级与产品定位文档，沉淀 KiKi 的长期目标执行平台定位、分层架构和演进优先级。
- 新增 Saga Prompt 总结文档，说明 Interviewer、Planner、Critic、Refiner、Spec Writer、Presenter 的职责、输入输出与约束。
- 新增真实 Refiner Prompt 与校验测试，5 角色 Saga 的 Refiner 不再是占位 no-op。

### Changed
- 将机器 tunnel 从 WebSocket 调整为 HTTP 长轮询，降低部署环境中的连接兼容性问题。
- 优化会话创建链路，支持即时进入会话，并在 workspace 或持久化后台失败时展示可恢复提示。
- 优化会话 hydration 逻辑，保留本地乐观创建的 `conv-new-*` 会话，避免远端旧快照覆盖本地新会话。
- 扩展规划测试入口，纳入 memory、runtime adapter、conversation store 与即时会话入口相关规格测试。
- 增强 Runtime 环境与权限提示，关闭关键权限时明确提示附件能力受限。
- 统一任务运行状态查询视图，API 返回 progress、logs、trajectory、blocker 与等待原因时使用同一服务端聚合逻辑。
- 将 `@kiki_agent/daemon` 版本提升到 `0.2.5`，补充 `install`、`uninstall`、`status` 子命令与远程后台服务控制入口。
- 增强 5 角色 Saga 规划失败恢复，保留失败阶段、可重试断点和补充信息状态，支持用户继续回复后重试。
- Refiner 改为调用真实 JSON invoke，支持局部 patch 合并到当前计划；Refiner 失败时保留当前计划继续让 Critic 复审。
- goal plan card 支持持久化与 hydration `cliProcess`，刷新后仍可查看目标规划过程。
- 缩短远程 daemon 服务状态和自启动设置请求超时时间，减少 UI 长时间等待。
- 将 `@kiki_agent/daemon` 版本提升到 `0.2.6`，使用稳定设备指纹支持同一电脑覆盖连接自动去重。

### Fixed
- 修复多 runtime 共用会话字段导致的跨 CLI session 泄漏问题，改为按 `runtimeKind` 隔离 `resumeSessionId`。
- 修复 Railway/WebSocket 压缩、重复 attach、reply 注册时序与 tunnel hub 状态共享等连接稳定性问题。
- 修复会话页 Suspense/loading、Pages Router `_app` 入口、Next 路由 hook 空值类型与生产构建中的类型兼容问题。
- 修复任务规格生成与 tick 增量任务路径的降级、重复 ID 检测和 stale 标记遗漏。
- 修复 Pi CLI 在模型调用失败、自动重试失败、assistant 输出为空或长时间静默时被误判为等待中的问题。
- 修复任务取消、恢复和进度查询接口中 blocker/取消态/等待原因不一致的问题。
- 修复 Saga 恢复上下文可能暴露内部错误、agent run id 或本地路径的问题。
- 修复 dev panel saga 刷新 hook 的无效依赖 warning。
- 修复过程侧边栏对已完成/无事件过程的折叠展示与空态提示。
- 修复已连接电脑重复展示且在线机器无法移除的问题，删除在线电脑时会提示将断开 daemon。

### Removed
- 移除远端 `docs/` 目录并加入 `.gitignore`，项目文档不再同步到仓库。
- 清理远端当前树中的 `.trae/`、本地 diagnostics、task audit 和历史备份分支中的本地数据库文件。
- 过滤本地调试目录与 debug markdown，避免 `.dbg/`、`debug-*.md` 和本地调试上报地址进入提交。
- 删除历史残留的 `debug-project-restart-error.md` 调试记录，避免本地排障过程进入远端当前树。

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
