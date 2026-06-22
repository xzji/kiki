# KiKi 项目总览

## 1. 项目定位

KiKi 是一个面向长期目标管理与自主执行的本地 Agent 产品原型。它不是单纯的聊天助手，也不是传统待办工具，而是把以下三类能力整合到同一套产品里：

- 对话式目标澄清与目标规划
- 任务级自主执行与结果回流
- 收件箱、会话、目标、任务、日程之间的统一编排

当前项目基于 `Next.js 14 + TypeScript + Tailwind CSS + Zustand` 构建，AI 运行时通过可插拔 **Runtime 适配层** 接入本地 CLI（Claude / Pi / Cursor 等），并围绕本地运行环境、会话续接、任务调度、执行 telemetry、SQLite 状态快照建立了一套完整闭环。

---

## 2. 当前产品方案

### 2.1 产品核心命题

项目的核心命题可以概括为一句话：

> 让用户通过自然语言发起目标，KiKi 先澄清、再拆解、再执行，并把执行进展持续同步回用户可理解的产品界面。

因此当前产品并不是“给一个 Prompt，返回一段结果”，而是围绕一个长期目标形成完整生命周期：

1. 用户在侧边栏助手或会话页输入普通问题，进入实时对话模式
2. 用户输入 `/goal xxx`，进入长程目标模式
3. 系统先进行 1-3 轮信息收集与澄清
4. 信息充分后，系统生成目标规划草案
5. 用户在目标规划抽屉中确认方案
6. Scheduler 根据规则自动派发任务实例
7. 任务在本地 Claude CLI 中执行
8. 执行日志、结果、等待确认状态回流到目标页、任务页、会话流和收件箱

这意味着 KiKi 既有“对话入口”，也有“目标编排系统”，同时还有“执行系统”。

### 2.2 当前主要产品界面

当前产品信息架构主要由以下页面与容器组成：

- `/`：收件箱首页，承接系统主动产生的任务提醒、执行结果与待确认事项
- `/conversations`：会话列表
- `/conversations/[conversationId]`：沉浸式会话页，是普通聊天和 `/goal` 模式的主要承载页
- `/goals/[goalId]`：目标详情页，查看目标拆解、子目标与任务结构
- `/goals/[goalId]/tasks/[taskId]`：任务详情页，可查看任务说明、执行结果和实例历史
- `/schedule`：日程页，承接由 Agent 自动生成的执行事件
- 全局右侧 `AssistantSidebar`：轻量助手入口
- 各类 Drawer：目标规划、任务详情、执行结果等右侧抽屉

### 2.3 当前交互策略

项目已经形成比较清晰的交互原则：

- 普通对话和 `/goal` 共用输入入口，但进入不同工作流
- `/goal` 不再一跳式生成结果，而是先做多轮交互式澄清
- 规划结果优先以“会话中的规划卡片 + 抽屉详情”呈现
- 执行过程优先后台推进，前端重点承担可视化与状态同步
- 关键节点通过收件箱、会话卡片、任务抽屉多点通知用户
- 运行环境与隐藏调参能力集中放在设置体系中

---

## 3. 总体架构

从工程上看，当前项目可以拆成 5 层：

1. App Router 页面层
2. 组件与交互容器层
3. Zustand 前端状态层
4. API / Server 运行时层
5. 本地 daemon / worker / SQLite 持久化层

对应的核心目录如下：

```text
src/
├─ app/                # Next.js 路由、页面与 API Route
├─ components/         # 页面组件、侧边栏、抽屉、消息项、任务视图
├─ hooks/              # 触发器、虚拟时钟等客户端逻辑
├─ lib/                # 业务编排、API 封装、服务端能力、daemon 能力
├─ mocks/              # 初始化演示数据与原型数据
├─ stores/             # Zustand 状态中心
├─ types/              # 领域模型定义
└─ bin/                # 本地 daemon 启动入口
```

此外，仓库根目录还包含：

- `data/`：SQLite 数据库
- `scripts/`：worker 启动脚本
- `packaging/macos/`：本地 runtime daemon 的系统集成配置
- `.trae/documents/`：产品方案与阶段性设计文档

---

## 4. 前端结构

### 4.1 App Shell

全局 UI 外壳由 `src/app/layout.tsx` 与 `src/components/layout/AppShell.tsx` 负责，承担：

- 全局字体、样式与 Provider 注入
- 左侧主导航 `Sidebar`
- 右侧助手侧边栏 `AssistantSidebar`
- 任务详情抽屉、用户菜单、DevPanel 等全局浮层
- 根据页面类型切换普通壳层 / 沉浸式壳层

当前沉浸式体验主要用于会话页和结果页，让聊天与任务结果具有更强专注感。

### 4.2 页面路由分工

`src/app/` 基本分成两部分：

- 页面路由：`/conversations`、`/goals`、`/inbox`、`/schedule`、`/history`
- API 路由：`/api/claude/*`、`/api/goals/*`、`/api/runtime/*`、`/api/runtime-envs/*`

其中页面层负责展示和交互，真正的目标规划、任务执行、运行时同步等逻辑主要进入 API 与 `lib/server`。

### 4.3 组件分层

`src/components/` 当前基本可以按业务域理解：

- `layout/`：全局框架，包含侧边栏、助手、用户菜单、FAB
- `conversation/`：会话消息流、目标规划抽屉、任务消息卡片
- `goal/`：目标详情、子目标块、任务编辑、任务抽屉
- `task/`：任务执行结果、时间线、实例列表
- `settings/`：运行环境设置、日志面板、本地运行时向导
- `schedule/`：日程视图
- `execution/`：不同任务结果内容视图，例如 `flashcard`、`draft_review`、`confirm_action`

这套分层说明产品已经从“页面原型”演进为“按领域对象组织 UI”。

---

## 5. 状态管理结构

项目核心状态由 Zustand 承担，但已从"前端权威"转向"服务端权威 + 前端 projection"。

### 5.1 关键 Store

- `assistantStore.ts`
  - 管理右侧助手侧边栏的消息流、发送态、中断、权限请求
  - 支持普通 Claude 对话与 `/goal` 信息收集

- `conversationStore.ts`
  - 已从 `persist` 模式重构为 read-only projection
  - 通过 `/api/conversations/state` 初始 hydrate，后续由 SSE 增量更新
  - 写动作走 `/api/conversations/commands` 命令式 API
  - 是会话模式与目标模式的连接点

- `goalStore.ts`
  - 服务端持久化 + 命令式写入（`/api/goals/commands`）
  - 通过 SSE event_log 增量同步
  - 支持乐观更新失败后的 resync 回滚

- `runtimeEnvStore.ts` / `scheduleStore.ts`
  - 已彻底移除 localStorage 业务数据
  - 服务端为事实源，前端仅作 projection
  - 写入命令带 `expectedRevision` 防旧覆盖

- `easterEggSettingsStore.ts`
  - 管理隐藏调参项（信息收集轮数、任务并发数、调度周期、超时阈值、拆解阈值等）
  - 仍保留本地持久化，因为属于偏好而非业务事实

- `inboxStore.ts`
  - 收件箱卡片 projection

### 5.2 状态设计特点

当前状态层的特征：

- 服务端是事实源，前端 store 是 projection
- 命令式写路径 + SSE 投影路径单向数据流
- 多 Tab 通过 `BroadcastChannel` 同步刷新
- 命令携带 `expectedRevision`，冲突 409 + snapshot 回灌
- revision 防旧覆盖：旧 snapshot 不会回滚新命令结果

---

## 6. `/goal` 长程目标方案

这是当前项目最核心的产品能力。

### 6.1 工作流定位

`/goal` 并不是一个简单 Prompt 模板，而是一个 Orchestrator：

1. `collecting_info`：先澄清目标背景
2. `decomposing`：拆解子目标
3. `generating_tasks`：逐个子目标生成任务
4. `reviewing_tasks`：对任务与目标的对齐度做 Review
5. `presenting_plan`：生成适合前端展示的规划草案

主要前端编排入口在：

- `src/lib/goalWorkflow.ts`

主要服务端生成逻辑在：

- `src/lib/server/goalPlanning.ts`

### 6.2 当前 `/goal` 交互链路

用户输入 `/goal 学习某个技能` 后，系统流程为：

1. 检查当前本地运行环境是否可用
2. 创建或复用会话
3. 调用 Claude 生成首轮澄清问题
4. 用户回答后，系统判断信息是否充分
5. 若不足，继续追问，最多 3 轮
6. 若充分，进入规划阶段
7. 生成目标标题、摘要、子目标、任务、风险、提醒策略
8. 写入 `goalStore` 与 `conversationStore`
9. 在会话中生成“目标规划草案”卡片

### 6.3 Prompt 设计思路

当前 `/goal` Prompt 方案已经比较产品化，主要特点是：

- 先信息收集，再规划
- 子目标拆解强调 `MECE + 逆向推演`
- 任务生成按子目标逐个进行，而不是一次性平铺
- 任务生成后还有一次 Review，对齐最终目标和子目标
- 最终再单独生成面向 UI 展示的标题、摘要、提醒策略

这使得 KiKi 的目标规划结果更接近“产品可执行计划”，而不是“一段漂亮文本”。

### 6.4 JSON 容错策略

`goalPlanning.ts` 内置了较强的 JSON 容错链路：

1. 直接解析
2. 平衡括号截取
3. 常见格式修复
4. Claude 二次修复 malformed JSON

这是当前目标规划链路稳定性的关键基础设施，也是项目已沉淀出的重要工程经验。

---

## 7. 普通对话方案

除了 `/goal`，项目还支持标准 Claude 对话。

### 7.1 两个入口

普通对话现在有两个主要入口：

- 右侧 `AssistantSidebar`
- 会话页 `ConversationView`

二者都会：

- 读取当前激活运行环境
- 检查是否是可用的本地 Claude CLI
- 通过 `/api/claude/chat` 发起 SSE 流式对话
- 在前端实时拼接 `delta`
- 支持中断

### 7.2 会话连续性

项目已明确采用 Claude 原生 session 持续对话，关键约束是：

- 同一会话连续对话必须使用 `--resume <sessionId>`
- 会话页会把 `claudeSessionId` 存到 `conversationStore`
- 服务端支持删除本地 session 文件，便于清理异常会话

这部分的目标不是“每次都新开一个 chat”，而是尽量维持本地 Claude 的真实会话上下文。

---

## 8. 任务执行与调度方案

### 8.1 当前执行模型

当前项目采用“daemon 唯一生产者 + 浏览器只读 projection”的模式：

- 用户确认目标规划后，目标进入可执行状态
- 服务端 daemon scheduler 找到可启动任务并派发
- daemon 创建实例 `TaskInstance`、写 `runtime_jobs`、生成事件
- 任务通过本地 Claude CLI 后台执行
- 执行中间态和最终结果写入 telemetry / event log
- 前端通过 SSE 订阅事件，更新 UI projection（不再写回服务端）

因此用户在界面上看到的不是同步阻塞式 AI，而是“daemon 在后台推进任务，浏览器只是把状态投影出来”。

### 8.2 浏览器侧 Scheduler（已下线）

`src/components/providers/GoalSchedulerRuntime.tsx` 已被有意清空，仅保留 `hydrateSettings` 副作用。组件文件顶部明确注释：

> Browser-side scheduling, notification delivery, and watchdog logic are intentionally disabled.
> The daemon is the only producer; RuntimeEventBridge consumes SSE events and updates UI projections.

历史上由浏览器侧承担的调度、通知投递、watchdog 三类职责，全部已迁移到服务端 worker。

### 8.3 服务端 Scheduler / Worker（当前主链路）

任务调度与执行已完全收口到服务端：

- `src/lib/server/worker/goalSchedulerEngine.ts`：依赖检查、到期判定、优先级排序、并发上限、实例创建
- `src/lib/server/worker/taskDispatchWorker.ts`：派发与执行驱动
- `src/lib/server/worker/goalNotificationWorker.ts`：通知投递、watchdog（超时暂停、提醒兜底）
- `src/lib/server/worker/recoveryWorker.ts`：异常恢复
- `src/lib/server/goalTaskRunner.ts`：单次任务的本地 Claude CLI 执行、telemetry 落库
- `src/bin/kiki-runtime-daemon.ts` + `scripts/start-worker.ts`：daemon 启动入口

任务执行的 HTTP 入口（`src/app/api/goals/tasks/execute/route.ts`）当前主要供调试与重放使用，正常流程下由 daemon 自治推进，无需前端发起。

---

## 9. 运行时、Daemon 与持久化

### 9.1 为什么需要运行时层

普通前端原型只要本地 store 即可，但 KiKi 已经进入“本地 Agent 系统”阶段，所以必须解决：

- 运行环境发现与切换
- 任务队列持久化
- 本地 daemon 心跳与状态
- 前后端状态一致性
- 重启后的快照恢复

### 9.2 Runtime Environment

运行环境相关逻辑主要分布在：

- `src/stores/runtimeEnvStore.ts`
- `src/lib/runtime/defaultRuntimeEnvironments.ts`
- `src/app/api/runtime-envs/*`
- `src/components/settings/*`

当前运行环境对象会记录：

- CLI 路径
- 工作目录
- 类型与 runtimeKind
- 健康状态
- 权限模式
- 是否为当前默认环境

这是 Claude 对话、`/goal` 规划、任务执行的共同基础。

**Runtime 适配层**（`src/lib/server/runtime/adapters/`）将 KiKi 统一任务请求翻译为各 CLI 协议：

- `claudeAdapter` — Claude Code CLI（`claude`）
- `piAdapter` — Pi CLI（`pi`）
- `cursorAdapter` — Cursor Agent CLI（`cursor agent acp`，JSON-RPC 双向通道 + `session/request_permission` 审批）
- 注册表见 `registry.ts`，发现与健康检查经 `runtimeEnvValidation.ts` 自动扫描已注册适配器

Cursor 运行时额外支持：按 KiKi 工具策略写入工作目录 `.cursor/cli.json` overlay（confirm 模式）、`buildCursorEnv()` 环境清洗、以及 `runtimeSessions[cursor]` 分键 session 续接。

### 9.3 干净环境变量

项目有一个明确工程约束：

- Claude CLI 必须在经过清洗的环境变量中启动

核心实现位于：

- `src/lib/server/claudeEnv.ts`

它会过滤掉 `npm_*`、`TRAE_*`、`NEXT_*` 等污染性变量，只保留系统变量、代理变量和必要的 Claude/Anthropic 变量，目的是保证本地 CLI 会话稳定和跨环境一致。

### 9.4 SQLite 持久化

当前数据库在：

- `data/kiki.db`

Schema 定义位于：

- `src/lib/server/db/schema.ts`

当前两类核心持久化表：

- `runtime_jobs`
  - 保存任务队列、执行状态、lease、progress、logs、result
- `runtime_state_snapshots`
  - 保存前端关键状态快照，例如 goals、runtimeEnvironments、scheduleEvents

这说明项目已经不满足于“只存在浏览器 localStorage”，而是在向服务端持久运行时演进。

### 9.5 Daemon / Worker 模型

本地执行器相关代码主要在：

- `src/bin/kiki-runtime-daemon.ts`
- `src/lib/server/worker/taskDispatchWorker.ts`
- `src/lib/server/repositories/runtimeJobsRepository.ts`
- `scripts/start-worker.ts`

当前工作方式是：

1. 任务进入 `runtime_jobs`
2. worker claim 队列任务
3. daemon 记录设备状态与心跳
4. 任务执行后写回 progress / logs / result
5. 根据最新 telemetry 同步目标快照

这套结构为未来扩展“真正脱离浏览器的持久任务系统”提供了基础。

---

## 10. 前后端状态同步方案

项目现在不是单向数据流，而是前后端双向同步。

### 10.1 RuntimeEventBridge（projection-only）

`src/components/providers/RuntimeEventBridge.tsx` 负责：

- 启动时从服务端拉取 conversations / goals / runtime / schedule 的初始 snapshot
- 订阅聚合后的 SSE 通道 `/api/runtime/events/stream`，将 daemon 写入的事件投影到前端 store
- 在 `bootstrapped` && `conversationHydrated` 之后才连接 SSE，避免 cursor 未就绪导致的事件回放
- 监听 `request.signal.abort`，确保连接断开时资源正确释放

它的角色已经从“双向桥”降级为单向 projection：服务端是事实源，浏览器只读。

### 10.2 写路径：命令式 API + 乐观锁

历史上的 `/api/runtime/state/sync` 反向同步路由及 `syncRuntimeStateSnapshot` helper 已删除。所有写动作都走命令式 API：

- `/api/conversations/commands`
- `/api/goals/commands`
- `/api/runtime/environments/[id]`
- `/api/schedule/events`

每条命令都携带 `expectedRevision` / `If-Match`，冲突返回 `409` 并回灌最新 snapshot；snapshot 通过 revision 防止旧数据回滚新结果。

### 10.3 多 Tab 同步与 Snapshot

服务端 snapshot 读写：

- `src/lib/server/runtime/stateSnapshot.ts`
- `src/lib/server/runtime/goalStateSnapshot.ts`

跨 Tab 同步：

- `src/lib/runtimeStateChannel.ts`：基于 `BroadcastChannel`，写入成功后通知同浏览器其它 Tab 触发 snapshot 刷新

当前同步对象包括：

- `conversations` / `messages` / `conversation_event_log`
- `goals` / `goal_event_log`
- `runtimeEnvironments`
- `scheduleEvents`

---

## 11. 当前关键领域对象

从产品模型上看，当前项目围绕以下对象组织：

- `Conversation`
  - 用户与 KiKi 的消息流容器
  - 可以绑定目标、运行环境、Claude session

- `Goal`
  - 长期目标主体
  - 包含 summary、deadline、workflow、subGoals

- `SubGoal`
  - 目标拆解后的阶段性块

- `Task`
  - 可执行任务
  - 包含执行方式、优先级、依赖、结果类型、触发规则

- `TaskInstance`
  - 某个任务在某次时间点被调度出来的执行实例

- `RuntimeEnvironment`
  - 本地 AI 运行环境

- `RuntimeJob`
  - 后端持久化任务队列记录

这些对象让 KiKi 的系统结构具备比较明确的 DDD 风格雏形。

---

## 12. 当前工程约束与已形成共识

结合现有实现，当前项目已经有几条非常明确的硬约束：

- 产品名称统一为 `KiKi`，已完成去 `dora` 化
- Claude CLI 必须使用干净环境变量启动
- Claude 会话续接必须使用 `--resume`
- `/goal` 必须走 Orchestrator，不再一跳式生成
- 规划链路的 JSON 解析必须具备多级容错
- 隐藏调参统一存放在 `easterEggSettingsStore.ts`
- 侧边栏 / 抽屉顶部导航统一为左侧 Breadcrumb、右侧收起与全屏按钮
- 弹窗层级必须高于侧边栏，避免遮挡

这些约束说明项目已经不只是“写几个页面”，而是形成了较稳定的产品和工程规范。

---

## 13. 当前项目成熟度判断

如果从阶段上判断，当前项目大致处于：

> 从高保真前端原型，进入到“具备本地 Agent 运行时雏形的产品验证版”。

已经完成的关键跨越包括：

- 从静态原型进入真实 Claude CLI 集成
- 从一次性规划进入多轮 `/goal` 编排系统
- 从前端本地状态进入 SQLite + runtime snapshot
- 从手动任务查看进入自动调度与后台执行
- 从单页面组件演示进入会话、目标、任务、收件箱、日程的联动

但它仍然是“验证版”，还不是最终形态，原因也很明确：

- 前后端状态边界还在演进中
- 浏览器 scheduler 与 daemon 模式并存
- 数据模型已具雏形，但还没有完整服务端主导架构
- 运行中的后台任务还没有完全脱离前端生命周期

---

## 14. 适合继续演进的方向

基于当前结构，后续最自然的演进方向有 4 条：

### 14.1 从浏览器调度迁移到服务端常驻调度

目标是让任务真正做到：

- 浏览器关闭后仍可持续推进
- daemon 成为唯一执行者
- 前端只负责展示与交互

### 14.2 会话、目标、任务的数据统一收口到服务端

目前仍有相当一部分主状态在 Zustand，本地持久化占比较高。未来可逐步收口到：

- 服务端 repository
- 更稳定的 snapshot / event log
- 明确的客户端缓存层

### 14.3 丰富执行结果类型

当前已经有 `flashcard`、`draft_review`、`confirm_action` 等视图类型，后续可继续扩展：

- 更复杂的结构化结果
- 多步骤交互确认
- 跨任务成果聚合

### 14.4 形成真正的“目标操作系统”

当前已经具备雏形：

- 对话收集意图
- 规划拆解任务
- 自动调度执行
- 多容器回流结果

进一步演进后，KiKi 可以从“目标助手”升级为“围绕长期目标持续运转的个人 Agent OS”。

---

## 15. 一句话总结

当前 KiKi 项目的本质可以概括为：

> 一个以 `/goal` 长程目标编排为核心、以本地 Claude CLI 为执行引擎、以会话/目标/任务/收件箱/日程为产品外壳、并正向本地持久运行时系统演进的 Agent 产品原型。

