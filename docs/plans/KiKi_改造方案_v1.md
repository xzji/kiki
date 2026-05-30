# KiKi → Topic-Centric Autonomous Agent 完整改造方案

> 版本：v2.1
> 适用项目：KiKi（本地长期目标管理 Agent 产品原型）
> 改造目标：从"目标编排 + 后台执行"升级为"Topic 持续运转 + 多 Thread 并行循环 + 全链路可追溯可恢复"的自主 Agent 系统
>
> **v2.1 变更说明**（在 v2.0 基础上）：
> - **双价值闸门（Pre-Action / Post-Action Gate）本期不做**，整体后置到 P6（预留，按需启用）
> - P2 由"Thread 循环 + 双闸门 + Topic 多 Agent 协作"瘦身为"Thread 循环 + Topic 多 Agent 协作"
> - 推送侧暂沿用 KiKi 现有 notification 逻辑，不引入 PostGateResult.notifyChannel
> - Task 数据模型暂不携带 `preGateDecision` / `postGateDecision` 字段，留到 P6 启用时再扩展
> - 用户参与度（L0-L4）的"是否打断"判断本期改为基于参与度规则与 Topic 状态，不依赖 Pre-Gate
>
> **v2.0 变更说明**（基于最新 PROJECT_OVERVIEW）：
> - 浏览器 Scheduler 已下线，daemon 已成为唯一执行者 → P4 大幅简化为"扩展现有 worker"
> - 服务端已具备 `conversation_event_log` / `goal_event_log` + revision 乐观锁 + SSE 投影 → P0 改为"通用化已有事件机制"
> - 状态层已重构为"服务端权威 + 命令式 API + 前端 projection + BroadcastChannel" → 所有改造都必须严格遵守此范式，不能引入新的双向同步
> - 已有三个服务端 worker（goalSchedulerEngine / goalNotificationWorker / recoveryWorker） → 新增的 ThreadLoopWorker 与之并列，不能职责重叠
> - RuntimeEventBridge 是项目唯一的服务端 → 前端事件通道 → 所有 Agent 事件复用此通道，不另起 SSE

---

## 第零部分：需求背景、目标与预期

> 本部分用于在动手前对齐"为什么改"与"改完长什么样"。后续所有架构选择、阶段划分、模块拆分都应该能在这里找到对应的动机或验收条件。

### 0.1 需求背景（为什么要改）

KiKi 当前是一套"目标编排 + 后台执行"系统：用户提一个 Goal → 系统拆 SubGoal → daemon 按计划执行 → 推送结果。这一架构已经支撑了"可量化、有 deadline、动作空间有限"的场景，但在我们想要它真正承担的角色面前暴露出五个结构性缺口：

| # | 现状痛点 | 体现场景 | 根因 |
|---|---|---|---|
| 1 | 顶层抽象过窄 | "炒美股"、"考托福"、"持续关注 AI 行业动态"这类没有明确完成态、需要长期陪伴的诉求，无法被表达成一个 Goal | Goal 强假设"可量化 + 可结束"，不允许"持续运转但无终点"的实体 |
| 2 | 一次性规划，缺少持续演进 | SubGoal 在创建时就被静态拆出来，新信息进来后无法触发拆分调整 | SubGoal 是静态分块，没有自己的"循环 tick"，也没有触发再规划的钩子 |
| 3 | 行动空间受限 | 所有行为最终落到 Claude CLI 直接执行，没有"先想清楚要做什么、再决定怎么做"的环节 | 没有 Action Reasoner + Capability Resolver，能力被硬编码 |
| 4 | 多 Agent 协作弱、可追溯/可恢复不彻底 | 跨 Agent 通信无法事后还原；某一步失败后需要人工介入；中断重启后状态可能丢失 | 没有统一的事件溯源 + 幂等执行 + Saga 补偿，事件 / 消息 / Saga 三层均未统一建模 |
| ⏸ 5 | （暂不处理）缺乏价值过滤 | daemon 跑出的产出会被原样推送，长期使用可能出现信息过载 | 缺少 Pre-Action / Post-Action 价值闸门——**本期不做，后置到 P6 预留阶段**，先沿用现有 notification 逻辑 |

同时，KiKi 服务端已经具备一批可复用的基础设施，本次改造**不是推翻重做**，而是**沿着已有底座（daemon-only 执行、命令式 API + revision 乐观锁、SSE projection、event_log、BroadcastChannel）继续向上长**：

- ✅ 浏览器 Scheduler 已下线，daemon 是唯一执行者
- ✅ 前端状态层已切到 projection-only，不会再有双向同步
- ✅ `conversation_event_log` / `goal_event_log` + revision 乐观锁已经在线上跑
- ✅ RuntimeEventBridge 是唯一的服务端→前端通道
- ✅ 四个 daemon worker（goalSchedulerEngine / taskDispatchWorker / goalNotificationWorker / recoveryWorker）已经在协同工作

因此本次改造的真正命题是：**在不打破现有底座的前提下，把"目标编排器"升级为"Topic-centric 自主 Agent 系统"。**

### 0.2 改造目标（要做成什么样）

围绕上面五个缺口（其中第 5 项已显式后置），本方案设定如下五个核心目标。每个目标都对应后文一个或多个阶段（P0-P6）的交付物：

1. **统一顶层抽象为 Topic**（对应 P1）
   用 Topic 完全取代 Goal，把"可量化目标"与"持续关注"收敛到同一种实体下；deadline / quantifiable / completionCriteria 全部下沉为可选属性。

2. **引入 Thread 作为持续推进单元**（对应 P1-P2）
   用 Thread 取代 SubGoal，让每条 Thread 都有自己的循环 tick（realtime / hourly / daily / event-driven），可以被独立暂停、恢复、调度。

3. **开放行动空间**（对应 P3）
   引入 Action Reasoner（先想清楚要做什么）+ Capability Resolver 四级策略（直连工具 / 已有 Skill / 临时编排 / 求助用户），把"怎么做"从硬编码里解放出来。

4. **构建多 Agent 协作底座 + 全链路可追溯可恢复**（对应 P0、P4'、P6）
   建立 Event Sourcing 四层架构（agent_runs / agent_events / agent_messages / saga_instances + agent_snapshots），保证：
   - 单 Agent 内每一步可重放、可幂等续跑
   - 跨 Agent 通信每一条消息可追溯到因果链
   - 任何崩溃点都能从最近一次 snapshot + 增量事件恢复

5. **沉淀 Knowledge Pool**（对应 P5，优先级靠后）
   把多 Thread 跑出来的知识聚合为 Topic 级共享黑板，供后续 Thread 复用，避免重复消耗算力。

> ⏸ **后置（不在本期范围）**：**建立双价值闸门（Pre-Action / Post-Action Gate）**
> 原计划在每个 Task 执行前后加 Pre-Gate（值不值得做）与 Post-Gate（值不值得推送）。本期暂不建设，**整体后置到 P6（按需启用）**。
> 推送侧本期沿用现有 notification 逻辑；Task 数据模型暂不携带 `preGateDecision` / `postGateDecision` 字段。

### 0.3 预期达到的效果（怎么算改完了）

改造完成后，KiKi 应具备以下可被直接验证的能力。这一节既是产品验收清单，也是后续技术阶段的"出口标准"：

**A. 顶层能力（用户视角）**

- ✅ 可以创建"炒美股"、"持续关注大模型行业"这类没有 deadline、没有量化指标的 Topic，并且系统能持续推进，不要求用户每次给指令
- ✅ 可以创建"3 个月内考下托福 100 分"这类传统目标，二者共用一套 Topic UI，没有割裂
- ✅ 在同一个 Topic 下可以挂多条 Thread（如"美股"下挂"持仓监控"/"行业动态"/"个股深挖"），各自按自己的节奏跑
- ✅ 推送给用户的内容沿用现有 notification 逻辑（本期不引入价值闸门过滤；后续 P6 启用闸门后再做内容过滤升级）
- ✅ 用户可按 Topic / Thread 维度设置参与度（L0 全自动 → L4 每步确认），系统按设定自动调整打扰频次

**B. 系统能力（工程视角）**

- ✅ daemon 重启后，所有 Thread 能从最近 snapshot + 增量事件恢复，不丢任务、不重复执行（幂等键保证）
- ✅ 任意一次 Agent 执行都能在 DevPanel 还原完整因果链：哪个 Thread 触发 → 选用了哪个 Capability → 产出 → 是否推送（P6 启用闸门后，链路上自动多出 Pre/Post Gate 判定节点）
- ✅ Saga（如 Topic 初始化的多 Agent 协作）任一步骤失败可触发补偿，不会留下半成品状态
- ✅ 跨 Agent 的每一条消息都能在 `agent_messages` 表中查到，可按 causationId 追溯到上游事件
- ✅ 所有新模块**完全沿用**现有命令式 API + revision 乐观锁 + SSE projection + BroadcastChannel 范式，前端不引入新的双向同步

**C. 非破坏性保证（迁移视角）**

- ✅ 不引入新的执行位置（仍只有 daemon 执行，不在浏览器跑业务逻辑）
- ✅ 不新建独立 SSE 通道（Agent 事件复用 RuntimeEventBridge，按 `agent.*` 前缀分发）
- ✅ 不与现有 4 个 daemon worker 职责重叠（新增 worker 与之并列）
- ✅ 现有 `conversation_event_log` / `goal_event_log` 不被废弃，而是被 `agent_events` 通用化吸收，保持向后兼容
- ✅ Goal → Topic 是**完全取代**而非长期并存，迁移期内通过一次性数据迁移脚本完成，避免长期维护两套模型

### 0.4 非目标（本次不做）

为避免范围膨胀，以下几项**显式列为本次不做**，待后续版本再议：

- ⏸ **双价值闸门（Pre-Action / Post-Action Gate）本期不做**，整体后置到 P6 预留阶段。本期推送侧沿用现有 notification 逻辑，Task 模型不携带 Gate 决策字段
- ❌ 不做跨用户的 Agent 协作（仍是单用户本地系统）
- ❌ 不做云端 daemon（仍是本地 daemon，浏览器只做 projection）
- ❌ 不替换底层 LLM 调用方式（仍走 Claude CLI / 现有 LLM 客户端）
- ❌ 不做 Knowledge Pool 的语义检索 / 向量化（P5 仅做结构化黑板，向量化后续再议）
- ❌ 不做权限/多租户模型重构（沿用现有运行环境权限）

---

## 第一部分：架构演进总览

### 1.1 改造前后对比

| 维度 | 当前 KiKi | 目标架构 |
|---|---|---|
| 顶层实体 | Goal（必须可量化、有 deadline 倾向） | Topic（统一可量化目标与持续关注，deadline/quantifiable 均为可选属性） |
| 中间层 | SubGoal（目标的静态拆解块） | Thread（持续推进的活循环单元，可独立运转） |
| 执行模式 | Daemon 唯一生产者 + 浏览器 projection-only + 一次性规划后由 scheduler 派发 | Daemon 内多 Thread 持续循环 + 动态产出新 Task（双价值闸门 P6 再启用） |
| 价值判断 | 一道（用户确认规划） | 本期保持一道（沿用现有 notification）；P6 启用时升级为两道（Pre-Action + Post-Action Gate） |
| 行动空间 | 受限于 Claude CLI 直接执行 | 开放式 Action Reasoner + Capability Resolver 4 级策略 |
| 用户参与 | 权限模式（运行环境层面） | Topic/Thread 级别的 L0-L4 参与度分级 |
| 调度位置 | ✅ 已完成迁移：daemon worker（goalSchedulerEngine + taskDispatchWorker + goalNotificationWorker + recoveryWorker） | 在现有 worker 旁新增 ThreadLoopWorker（与现有 worker 并列） |
| 状态同步 | ✅ 已完成：服务端权威 + 命令式 API + SSE projection + revision 乐观锁 + BroadcastChannel | 新增模块全部沿用此范式 |
| 事件日志 | 已有 `conversation_event_log` / `goal_event_log` | 通用化为 `agent_events` + 复用现有 SSE 通道 |
| 知识沉淀 | 仅 telemetry 日志 | Knowledge Pool 跨 Thread 共享黑板（P5 后） |
| 可观测性 | telemetry + snapshot + event_log | Event Sourcing 全链路事件流 + 因果链追溯 |
| 中断恢复 | recoveryWorker 已覆盖任务级 | 事件流 + 幂等键 + Saga 补偿，覆盖到 step / message / saga 三级 |

### 1.2 领域对象终态

```
Topic（顶层，统一原 Goal 概念）
  ├─ 属性
  │   ├─ title / summary
  │   ├─ deadline?            （可空：决定是否有时间压力）
  │   ├─ quantifiable?        （可空：是否可量化）
  │   ├─ completionCriteria?  （可空：完成判定标准）
  │   ├─ participationLevel   （L0-L4 用户参与度）
  │   └─ status               （collecting_info | active | paused | archived）
  ├─ 关联
  │   ├─ conversationId        （对话面板）
  │   └─ knowledgePoolId       （P5 引入）
  │
  └─ Threads（多个并行运转的持续推进线，取代原 SubGoal）
        ├─ 属性
        │   ├─ title / intent
        │   ├─ status             （active | paused | archived）
        │   ├─ loopInterval       （realtime | hourly | daily | event-driven）
        │   ├─ lastRunAt / nextRunAt
        │   └─ participationLevel?（继承 Topic，可覆盖）
        │
        └─ Tasks（有完成态的执行单元）
              ├─ threadId
              │   （preGateDecision / postGateDecision 字段后置到 P6 启用闸门时再加）
              │
              └─ Steps（可选，仅在需要持久化中间状态时建模）
```

### 1.3 运行时编排终态

```
                  ┌──────────────────────────────────┐
                  │      Topic Coordinator           │ ← 跨 Thread 协调
                  │  (去重/关联/推送节奏/状态汇总)    │
                  └──────────────────────────────────┘
                              │
        ┌─────────────┬───────┴───────┬─────────────┐
        ▼             ▼               ▼             ▼
     Thread A      Thread B        Thread C      Thread D
        │             │               │             │
        ▼             ▼               ▼             ▼
   ┌────────────── V4 Pipeline（每个 Thread 独立运转）────────────┐
   │ 采集 → 相关性过滤 → Action Reasoner → Capability Resolver  │
   │ → Executor → 现有 notification 派发                          │
   │ → Knowledge Accumulator（P5）                                │
   │                                                              │
   │ ⏸ P6 启用时：在 Capability Resolver 后插入 Pre-Action Gate， │
   │   在 Executor 后插入 Post-Action Gate                        │
   └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌─────────────────────────────────┐
              │  Inbox / Conversation / Schedule │
              └─────────────────────────────────┘
```

---

## 第二部分：多 Agent 架构设计

### 2.1 多 Agent 适用性判断

#### 适合多 Agent 的位置

| 位置 | 优先级 | 价值 |
|---|---|---|
| **位置 1：Topic 初始化的协作**<br>（Interviewer / Planner / Critic / Refiner / Presenter） | ⭐⭐⭐⭐⭐ | 异构视角带来真正的对抗式批判反馈，规划质量提升最大杠杆点 |
| **位置 2：多 Thread 并行循环**<br>（每个 Thread 是独立 Worker Agent） | ⭐⭐⭐⭐ | Thread 本身就是 Agent，独立 intent / 循环 / 上下文 / 执行权 / 状态 |
| ⏸ **位置 3（本期不做，P6 预留）：Value Gate 多角色辩论**<br>（Value Advocate / Noise Guardian / Judge） | ⭐⭐⭐ | 依赖双价值闸门先落地，本期整体后置到 P6 |

#### 不适合多 Agent 的位置（伪需求）

| 位置 | 原因 | 替代方案 |
|---|---|---|
| Capability Resolver 工具选择 | 确定性问题，向量检索 + 规则匹配即可 | 单 Agent + 能力注册表 + 向量检索 |
| Task Executor | Task 是执行单元，Agent 性在 Thread 层已体现 | 普通执行单元，复杂时用 ReAct |

### 2.2 多 Agent 全景图

```
┌─────────────────────────────────────────────────────────────┐
│  Topic 初始化阶段（位置1：多 Agent 协作 Saga）                │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │Interviewer │→│  Planner   │→│   Critic   │←─┐          │
│  └────────────┘  └────────────┘  └────────────┘  │          │
│         ↑                                ↓        │          │
│         │ (追问)                    ┌────────────┐│          │
│         └──── User                 │  Refiner   ├┘          │
│                                    └────────────┘            │
│                                          ↓                   │
│                                    ┌────────────┐            │
│                                    │ Presenter  │            │
│                                    └────────────┘            │
└─────────────────────────────────────────────────────────────┘
                            ↓ (生成 Thread 列表)
┌─────────────────────────────────────────────────────────────┐
│  Topic 运转阶段（位置2：多 Agent 并行）                       │
│                                                              │
│     ┌──────────────────────────────────────┐                │
│     │       Topic Coordinator Agent         │                │
│     │  (去重 / 关联 / 推送节奏 / 状态汇总)   │                │
│     └──────────────────────────────────────┘                │
│            ↑       ↑       ↑       ↑                        │
│            │       │       │       │                        │
│      ┌─────┴──┐ ┌──┴───┐ ┌─┴────┐ ┌┴─────┐                 │
│      │Thread A│ │Thread│ │Thread│ │Thread│ ← Worker Agents │
│      │ Agent  │ │ B    │ │ C    │ │ D    │                 │
│      └────────┘ └──────┘ └──────┘ └──────┘                 │
│            ↓                                                 │
│      每个 Thread Agent 内部：                                │
│      采集 → 推理 → Capability(单Agent) → 执行 → 价值裁决      │
│                                              ↓               │
│                                      ┌───────────────┐       │
│                                      │ 位置3(可选)：  │       │
│                                      │ Value辩论组    │       │
│                                      └───────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 技术选型

**框架选择**：**自写编排 + 利用 Claude CLI 的 sub-agent 能力**

| 选项 | 适合度 | 决定 |
|---|---|---|
| 自写编排 + Claude CLI sub-agent | ⭐⭐⭐⭐⭐ | ✓ 采用 |
| LangGraph (JS) | ⭐⭐⭐ | 不采用，避免外部依赖 |
| AutoGen | ⭐⭐ | 不采用，侵入性强 |
| CrewAI | ⭐⭐ | 不采用，跨语言成本高 |

**选择理由**：
1. KiKi 已有完整 Daemon/Worker 工程地基
2. Claude CLI 原生支持 sub-agent
3. 保持 TS 单语言栈和 SQLite 持久化模型
4. 多 Agent 通信协议自己设计，可精准控制成本和延迟

---

## 第三部分：可追溯 + 可恢复技术架构

### 3.1 设计范式

> **Event Sourcing + State Machine + Idempotent Replay**

**核心思想**：
- 状态 = 事件序列的累积结果，事件是 source of truth
- 任何执行步骤先写事件再改状态
- 状态机定义每个 Agent 的步骤拓扑
- 每一步都是幂等的（带 step_id + idempotency_key），重放不重复执行副作用

### 3.2 四层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: Agent Runtime（运行时）                            │
│  - AgentExecutor: 单 Agent 状态机驱动器                      │
│  - AgentOrchestrator: 多 Agent 编排器                        │
│  - ResumeManager: 中断恢复管理器                             │
└─────────────────────────────────────────────────────────────┘
                              ↑
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Coordination（协调层）                             │
│  - MessageBus: 跨 Agent 消息总线                             │
│  - SagaCoordinator: 多 Agent 协作的 Saga 管理                │
│  - LockManager: 防并发冲突的资源锁                           │
└─────────────────────────────────────────────────────────────┘
                              ↑
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Event Store（事件存储层）                          │
│  - EventLog: 全局有序事件日志                                │
│  - StateProjector: 事件 → 状态的投影器                       │
│  - SnapshotManager: 快照管理（避免无限回放）                 │
└─────────────────────────────────────────────────────────────┘
                              ↑
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Persistence（持久化层）                            │
│  - SQLite 表：agent_runs / agent_events / agent_messages /  │
│    saga_instances / agent_snapshots                          │
│  - WAL 模式 + 事务保证                                       │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 五张核心表

#### 表 1：`agent_runs`（Agent 执行实例）

```sql
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,             -- 'interviewer' | 'planner' | 'thread_runner' | ...
  agent_instance_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  thread_id TEXT,

  state_machine_version TEXT NOT NULL,
  current_state TEXT NOT NULL,
  status TEXT NOT NULL,                 -- 'running' | 'paused' | 'completed' | 'failed' | 'aborted'

  parent_run_id TEXT,
  saga_id TEXT,

  input TEXT,
  output TEXT,
  error TEXT,

  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  last_event_seq INTEGER DEFAULT 0,

  worker_id TEXT,
  lease_until TEXT
);

CREATE INDEX idx_agent_runs_status ON agent_runs(status);
CREATE INDEX idx_agent_runs_topic ON agent_runs(topic_id);
CREATE INDEX idx_agent_runs_lease ON agent_runs(status, lease_until);
```

#### 表 2：`agent_events`（事件日志，架构灵魂）

```sql
CREATE TABLE agent_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  -- 'step_started' | 'step_completed' | 'llm_called' | 'tool_invoked'
  -- 'message_sent' | 'message_received' | 'state_transitioned'
  -- 'error_occurred' | 'paused' | 'resumed' | 'checkpoint_saved'

  payload TEXT NOT NULL,

  caused_by_event_seq INTEGER,
  caused_by_message_id TEXT,

  idempotency_key TEXT,

  side_effect_kind TEXT,        -- 'llm_call' | 'cli_exec' | 'http_request' | 'db_write' | 'none'
  side_effect_id TEXT,

  created_at TEXT NOT NULL,

  UNIQUE(run_id, idempotency_key)
);

CREATE INDEX idx_agent_events_run ON agent_events(run_id, seq);
CREATE INDEX idx_agent_events_type ON agent_events(event_type);
CREATE INDEX idx_agent_events_causal ON agent_events(caused_by_event_seq);
```

#### 表 3：`agent_messages`（跨 Agent 通信）

```sql
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,

  from_run_id TEXT NOT NULL,
  from_agent_type TEXT NOT NULL,
  to_run_id TEXT,
  to_agent_type TEXT,
  topic_id TEXT NOT NULL,
  thread_id TEXT,
  saga_id TEXT,

  message_type TEXT NOT NULL,
  -- 'request' | 'response' | 'event' | 'broadcast'
  -- 'arbitration_request' | 'arbitration_decision'

  payload TEXT NOT NULL,

  in_reply_to TEXT,
  causation_chain TEXT,

  status TEXT NOT NULL,
  -- 'pending' | 'delivered' | 'consumed' | 'expired' | 'dead_letter'

  delivery_attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,

  produced_by_event_seq INTEGER,
  consumed_by_event_seq INTEGER,

  created_at TEXT NOT NULL,
  deliver_after TEXT,
  delivered_at TEXT,
  consumed_at TEXT,
  expires_at TEXT
);

CREATE INDEX idx_messages_to_pending ON agent_messages(to_agent_type, status, deliver_after);
CREATE INDEX idx_messages_to_run ON agent_messages(to_run_id, status);
CREATE INDEX idx_messages_saga ON agent_messages(saga_id);
CREATE INDEX idx_messages_topic ON agent_messages(topic_id, created_at);
```

#### 表 4：`saga_instances`（多 Agent 协作的 Saga）

```sql
CREATE TABLE saga_instances (
  id TEXT PRIMARY KEY,
  saga_type TEXT NOT NULL,
  topic_id TEXT NOT NULL,

  current_step TEXT NOT NULL,
  status TEXT NOT NULL,         -- 'running' | 'completed' | 'compensating' | 'failed'

  state TEXT NOT NULL,
  compensation_log TEXT,

  participant_runs TEXT NOT NULL,

  created_at TEXT NOT NULL,
  completed_at TEXT,
  last_event_seq INTEGER DEFAULT 0
);
```

#### 表 5：`agent_snapshots`（快照加速回放）

```sql
CREATE TABLE agent_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,

  at_event_seq INTEGER NOT NULL,
  state TEXT NOT NULL,

  created_at TEXT NOT NULL,

  UNIQUE(run_id, at_event_seq)
);

CREATE INDEX idx_snapshots_run_latest ON agent_snapshots(run_id, at_event_seq DESC);
```

### 3.4 核心执行模式

#### 写入路径（先事件后状态）

```ts
async function executeStep(run: AgentRun, step: Step) {
  // 1. 计算幂等键
  const idempotencyKey = computeIdempotencyKey(run.id, step.id, step.input)

  // 2. 检查是否已执行过（断点恢复关键点）
  const existing = await db.agent_events.findOne({
    run_id: run.id,
    idempotency_key: idempotencyKey
  })
  if (existing) return existing.payload.output

  // 3. 写"step_started"事件
  await db.transaction(async (tx) => {
    await tx.agent_events.insert({
      run_id: run.id, step_id: step.id,
      event_type: 'step_started',
      payload: { input: step.input },
      idempotency_key: `${idempotencyKey}::started`
    })
  })

  // 4. 执行副作用（必须可幂等，传 idempotencyKey 给下游）
  let output, error
  try { output = await step.execute({ idempotencyKey }) }
  catch (e) { error = e }

  // 5. 写"step_completed"或"step_failed"
  await db.transaction(async (tx) => {
    await tx.agent_events.insert({
      run_id: run.id, step_id: step.id,
      event_type: error ? 'step_failed' : 'step_completed',
      payload: error ? { error: error.message } : { output },
      idempotency_key: idempotencyKey,
      side_effect_kind: step.sideEffectKind,
      side_effect_id: output?.sideEffectId
    })
    await tx.agent_runs.update(run.id, {
      current_state: step.nextState,
      last_event_seq: latestSeq
    })
  })

  return output
}
```

#### 恢复路径（事件流重建状态）

```ts
async function resumeRun(runId: string) {
  const run = await db.agent_runs.findById(runId)
  if (run.status === 'completed' || run.status === 'aborted') return

  const snapshot = await db.agent_snapshots.findLatest(runId)
  const events = await db.agent_events.find({
    run_id: runId,
    seq: { gt: snapshot?.at_event_seq ?? 0 }
  }).orderBy('seq')

  let state = snapshot?.state ?? initialState(run.agent_type)
  for (const event of events) {
    state = StateProjector.apply(state, event)
  }

  const agent = AgentFactory.create(run.agent_type, state)
  await agent.continueFrom(run.current_state)
}
```

#### 副作用幂等保证

- LLM 调用：传 `idempotency_key` 给 Anthropic SDK
- CLI 调用：通过 session_id 检查是否已有结果
- DB 写入：`INSERT OR IGNORE` 或唯一约束
- HTTP 请求：`Idempotency-Key` header

### 3.5 跨 Agent 通信因果链

任何输出可沿事件流反向追溯：

```
Topic 最终规划
  ← Refiner.step_completed (event 42)
  ← Refiner.message_received (event 38) ← Critic's message_sent (event 35)
  ← Critic.step_completed (event 34)
  ← Critic.message_received (event 30) ← Planner's message_sent (event 27)
  ← Planner.step_completed (event 26)
  ← Planner.message_received (event 22) ← Interviewer's message_sent (event 19)
  ← Interviewer.step_completed (event 18)
  ← ...
  ← saga_started (最初事件)
```

### 3.6 Saga 协作模式

```ts
class TopicInitSaga {
  steps = [
    { name: 'interview', agent: 'interviewer' },
    { name: 'plan', agent: 'planner' },
    { name: 'critique', agent: 'critic' },
    { name: 'refine', agent: 'refiner' },
    { name: 'present', agent: 'presenter' }
  ]

  compensations = {
    plan: async (state) => { /* 删除生成的 Thread 草稿 */ },
    refine: async (state) => { /* 回滚 Thread 修改 */ }
  }

  async execute(input) {
    const saga = await createSagaInstance(...)
    for (const step of this.steps) {
      const result = await this.invokeAgent(saga, step)
      if (result.failed) {
        await this.compensate(saga)
        return
      }
      saga.state = { ...saga.state, [step.name]: result }
      await db.saga_instances.update(saga.id, { state: saga.state })
    }
  }
}
```

---

## 第四部分：分阶段改造路线

### 4.1 总览

| 阶段 | 名称 | 核心交付物 | 改造规模 | 前置依赖 |
|---|---|---|---|---|
| **P0** | Event Sourcing 基础设施（**通用化现有事件机制**） | 通用 `agent_events` / `agent_runs` / `agent_messages` / `saga_instances` / `agent_snapshots` 表 + AgentExecutor + MessageBus + ResumeManager；**复用现有 SSE 通道** | 中（基于已有事件机制扩展，不是从零起步） | 无 |
| **P1** | 领域模型重构 | Goal→Topic、SubGoal→Thread 全面替换 | 大 | P0 |
| **P2** | 编排循环升级 + 多 Agent 协作 | ThreadLoopWorker + Topic 初始化多 Agent Saga（**双价值闸门后置到 P6**） | 大（核心） | P1 |
| **P3** | Capability Resolver + Coordinator | 能力解析器 + 跨 Thread 协调 | 中 | P2 |
| **~~P4~~** | ~~服务端常驻调度~~ | **✅ 已完成**：浏览器 Scheduler 已下线，daemon worker 已是唯一生产者 | - | - |
| **P4'**（替代原 P4） | ThreadLoopWorker 嵌入现有 worker 框架 | 与 goalSchedulerEngine / taskDispatchWorker / goalNotificationWorker / recoveryWorker 并列，复用 daemon 启动与心跳机制 | 小 | P2 |
| **P5** | Knowledge Pool | 知识池 + 多种激活机制 | 中 | P2 |
| **P6**（预留，**本期不做**） | 双价值闸门 + Value Gate 多 Agent 辩论 | 一次性落地 Pre-Action Gate + Post-Action Gate，必要时升级为多角色对抗式裁决；同时升级 notificationWorker 按 PostGate channel 分发 | 中-大 | P2 上线观察一段时间后按需启用 |

**关键变化（v2.1）**：
- 原 P2 中的"双价值闸门"整体后置到 P6，本期 P2 仅交付 ThreadLoopWorker + Topic 初始化多 Agent Saga
- P6 由"Value Gate 多 Agent 辩论"扩展为"双闸门 + 多角色辩论"的一次性方案

**关键变化（v2.0）**：
- 原 P4"浏览器 Scheduler 迁移到 Daemon"已被项目自身演进完成，方案不再承担此工作
- 取而代之的是 **P4'**：把新增的 ThreadLoopWorker 嵌入现有 worker 体系
- P4' 规模远小于原 P4，因为 daemon 启动框架、心跳机制、recovery 兜底都已就绪

### 4.2 P0：Event Sourcing 基础设施

**目标**：在 Topic / Thread / Multi-Agent 引入前，先建好可追溯可恢复的地基。

**v2.0 关键认知**：项目已有 `conversation_event_log` / `goal_event_log` + revision 乐观锁 + SSE 投影通道，**P0 不是从零起步，而是把已有领域事件机制通用化为 Agent 级事件溯源**。

#### 已具备的基础（不重复造）

| 已有能力 | 在新架构中的复用 |
|---|---|
| `conversation_event_log` / `goal_event_log` | 作为 `agent_events` 的设计参考；保留为领域事件，与 agent_events 互不替代 |
| revision 乐观锁（命令式 API） | 多 Agent 写 Topic/Thread 时复用 expectedRevision 机制 |
| SSE 通道 `/api/runtime/events/stream` | Agent 事件作为新事件类型加入此通道，前端通过 RuntimeEventBridge 投影 |
| BroadcastChannel 跨 Tab | Agent 状态变化也通过此机制广播 |
| recoveryWorker | ResumeManager 与之并列：recoveryWorker 管 Task 级恢复，ResumeManager 管 Agent Run / Saga 级恢复 |
| `runtime_jobs` 表 | 不替代，agent_runs 是新的"Agent 执行实例"概念；runtime_jobs 继续承载 Task 级 Job 队列 |

#### 新增（与现有解耦）

| 新增能力 | 与现有的关系 |
|---|---|
| `agent_runs` 表 | 与 runtime_jobs 并列，描述"Agent 执行实例"，不替代 Job |
| `agent_events` 表 | 与领域 event_log 并列，描述"Agent 步骤事件"；可通过 caused_by_event_seq 关联领域事件 |
| `agent_messages` 表 | 新增，跨 Agent 通信 |
| `saga_instances` 表 | 新增，多 Agent 协作管理 |
| `agent_snapshots` 表 | 新增，加速 Agent Run 回放 |
| AgentExecutor | 新模块，与 taskDispatchWorker 并列 |
| MessageBus | 新模块，复用 SQLite + 写命令式 API 模式 |
| SagaCoordinator | 新模块 |
| ResumeManager | 新模块，daemon 启动时被调用，与 recoveryWorker 顺序协作 |

#### Agent 事件接入现有 SSE 通道

```ts
// 现有：服务端写入事件 → 推送到 /api/runtime/events/stream
// 新增：agent_events 写入也触发同一通道，事件类型加 'agent.*' 前缀
publishToEventStream({
  channel: 'runtime',
  type: 'agent.step_completed',
  payload: { runId, stepId, output }
})
```

**RuntimeEventBridge 改造**：识别 `agent.*` 事件类型，更新前端 `agentRunStore`（新增 store，依然是 projection-only）。

#### 写路径接入命令式 API + 乐观锁

```ts
// 例：触发 Agent Run 启动 / 暂停 / 恢复
POST /api/agents/runs/commands
{
  command: 'start' | 'pause' | 'resume' | 'abort',
  runId: '...',
  expectedRevision: 7,
  payload: { ... }
}
// 冲突返回 409 + 最新 snapshot，沿用现有错误约定
```

#### 交付物

- [ ] `agent_runs` / `agent_events` / `agent_messages` / `saga_instances` / `agent_snapshots` 五张表
- [ ] AgentExecutor 状态机驱动器
- [ ] MessageBus 跨 Agent 消息总线（基于 SQLite + 复用命令式 API + revision 乐观锁）
- [ ] SagaCoordinator
- [ ] ResumeManager（daemon 启动阶段调用，与 recoveryWorker 顺序协作）
- [ ] StateProjector + SnapshotManager
- [ ] Agent 事件接入 `/api/runtime/events/stream`（扩展 event type 枚举）
- [ ] 前端 `agentRunStore`（projection-only，由 RuntimeEventBridge 更新）
- [ ] `/api/agents/runs/commands` 命令式写路径
- [ ] DevPanel "Agent 调试面板"基础版

#### 验收

- 模拟一个简单 Agent 跑 5 步任务，中间 kill daemon 进程，重启后从最后一步继续，不重复副作用
- 模拟两个 Agent 通过消息总线协作，中间 kill 进程，重启后 Saga 从 current_step 继续
- Agent 事件可通过现有 RuntimeEventBridge 实时投影到前端 DevPanel
- 多 Tab 打开 DevPanel，一个 Tab 触发 Agent 操作，另一个 Tab 自动刷新

### 4.3 P1：领域模型重构

#### 数据模型迁移

**新增 `Topic` 类型**（取代 `Goal`）：

```ts
interface Topic {
  id: string
  title: string
  summary: string
  conversationId: string

  deadline?: string
  quantifiable?: boolean
  completionCriteria?: string

  participationLevel: 'L0'|'L1'|'L2'|'L3'|'L4'
  status: 'collecting_info' | 'active' | 'paused' | 'archived'

  threads: Thread[]

  createdAt: string
  archivedAt?: string
}
```

**新增 `Thread` 类型**（取代 `SubGoal`）：

```ts
interface Thread {
  id: string
  topicId: string
  title: string
  intent: string
  status: 'active' | 'paused' | 'archived'

  loopInterval?: 'realtime' | 'hourly' | 'daily' | 'event-driven'
  lastRunAt?: string
  nextRunAt?: string

  participationLevel?: 'L0'|'L1'|'L2'|'L3'|'L4'

  tasks: Task[]

  createdAt: string
}
```

**Task 沿用**，加 `threadId` 字段。`preGateDecision` / `postGateDecision` 字段后置到 P6 启用双闸门时再扩展。

#### Store 改造

- `goalStore.ts` → `topicStore.ts`
- 字段重命名：`goals` → `topics`、`subGoals` → `threads`
- `conversationStore.ts`：`goalId` → `topicId`、`goalInfoCollection` → `topicInfoCollection`

#### SQLite Schema 改造

| 原 | 新 |
|---|---|
| `goals` 表 | `topics` 表 |
| `sub_goals` 表 | `threads` 表 |
| `tasks.sub_goal_id` | `tasks.thread_id` |
| `runtime_state_snapshots.goals` | `runtime_state_snapshots.topics` |

**迁移脚本**：一次性 SQL migration，老 Goal 数据平移为 Topic，新增字段填默认值（`participationLevel='L2'`、`status='active'`）。

#### 命令与入口

- `/goal xxx` → `/topic xxx`（保留 `/goal` 别名）
- Orchestrator 状态机：`subGoalDecomposing` → `threadInitialization`

#### 文件级改动清单

| 路径 | 改动类型 | 说明 |
|---|---|---|
| `src/types/goal.ts` | 重命名 → `topic.ts` | Topic / Thread 类型定义 |
| `src/stores/goalStore.ts` | 重命名 → `topicStore.ts` | 状态接口与方法重命名 |
| `src/stores/conversationStore.ts` | 编辑 | 字段重命名 |
| `src/lib/goalWorkflow.ts` | 重命名 → `topicWorkflow.ts` | 状态机阶段重命名 |
| `src/lib/server/goalPlanning.ts` | 重命名 → `topicPlanning.ts` | 返回结构换成 Thread |
| `src/lib/server/db/schema.ts` | 编辑 | 表名与字段改造 |
| `src/lib/server/db/migrations/` | 新增 | 数据迁移 SQL |
| `src/app/goals/[goalId]/` | 重命名 → `/topics/[topicId]/` | 路由重命名 |
| `src/app/api/goals/*` | 重命名 → `/api/topics/*` | API 路径 |
| `src/components/goal/` | 重命名 → `components/topic/` | UI 组件改名 |

#### P1 验收标准

- 所有原 Goal 数据无损迁移为 Topic（执行中 Task 不中断）
- `/topic xxx` 可完整跑通"澄清 → 规划 → 确认 → 派发 Task → 执行 → 回灌"
- UI 上所有"目标/子目标"字样替换为"主题/线索"

### 4.4 P2：编排循环升级 + 多 Agent 协作

> ⏸ **本期范围调整**：原 P2a 中的"双价值闸门（Pre-Action / Post-Action Gate）"整体后置到 P6。
> 本期 P2 仅交付 ① Thread 独立循环 + ② Topic 初始化多 Agent 协作。
> ThreadRunner 在本期不调用任何 Gate，执行结果直接走现有 notification 链路。

#### P2a：Thread 独立循环（不含双闸门）

**新增 ThreadRunner**（`src/lib/server/thread/threadRunner.ts`）：

```ts
class ThreadRunner {
  async tick(thread: Thread, topic: Topic) {
    const signals = await this.collect(thread, topic)
    const relevant = await this.filterRelevance(signals, thread, topic)
    if (relevant.length === 0) return

    const actions = await this.reasonActions(relevant, thread, topic)
    for (const action of actions) {
      // P6 启用后：此处插入 preActionValueGate；本期跳过
      const result = await this.execute(action, thread, topic)
      // P6 启用后：此处插入 postActionValueGate；本期直接派发
      await this.dispatchResult(result, thread, topic)
    }

    thread.lastRunAt = now()
    await this.scheduleNextTick(thread)
  }
}
```

> 📌 **P6 启用时的扩展点已经预留**：tick 主循环只需在两个标注位置插入 Gate 调用，
> 不需要修改外层数据流；推送侧改造也已经隔离在 `dispatchResult` 内部。

#### P2b：Topic 初始化多 Agent 协作

将单链路规划改造为 Saga 编排的多 Agent 协作：

- **Interviewer Agent**：信息收集（最多 N 轮）
- **Planner Agent**：MECE 拆解生成 Thread + Task
- **Critic Agent**：质疑规划，挑刺
- **Refiner Agent**：根据 Critic 反馈调整（可循环回 Critic）
- **Presenter Agent**：生成面向 UI 的标题/摘要/提醒策略

所有 Agent 通过 SagaCoordinator + MessageBus 编排，全程事件溯源。

#### 改造现有执行链路

| 原链路 | 改造后 |
|---|---|
| Scheduler 找到到期 Task → 派发 | Thread 循环 tick → 生成 Action → 直接派发（**P6 启用后才插入 Pre-Gate**） |
| 执行结果直接回灌 | 执行结果 → 沿用现有 notification 派发（**P6 启用后插入 Post-Gate 决定 channel**） |
| 一次性规划 | 规划只生成初始 Thread 列表；后续 Thread 在循环中动态产出新 Task |

#### 用户参与度落地

- Topic 创建默认 `L2`
- Topic 详情页加"参与度设置"控件
- Thread 可继承或覆盖 Topic 设置
- 本期"是否打断用户"由参与度规则 + Topic 状态直接决定（如 L3/L4 命中 confirm-required 类 Action 时弹确认）；不依赖 Pre-Gate
- P6 启用后，参与度规则下沉到 Pre/Post Gate 内部统一判定

#### 受影响文件

| 文件 | 改动 |
|---|---|
| `src/lib/server/goalTaskRunner.ts` | 重命名为 `taskExecutor.ts`，被 ThreadRunner.execute() 调用；保留对 Claude CLI 干净环境变量、`--resume` 续接的现有行为 |
| `src/lib/server/worker/goalSchedulerEngine.ts` | 升级为通用 `schedulerEngine`，支持 Topic / Thread / Task 三层调度判定 |
| `src/lib/server/worker/taskDispatchWorker.ts` | 不重命名，但增加对"由 Thread tick 动态产出的 Task"的派发路径 |
| `src/lib/server/worker/goalNotificationWorker.ts` | 本期**仅做兼容性扩展**（支持来自 Thread 动态 Task 的通知）；P6 启用闸门后再升级为通用 `notificationWorker`，按 Post-Gate 的 `notifyChannel` 决定推送目的地 |
| `src/lib/server/worker/recoveryWorker.ts` | 与 ResumeManager 协作：recoveryWorker 仍负责 Task / runtime_job 级恢复；ResumeManager 负责 Agent Run / Saga 级恢复 |
| **新增** `src/lib/server/worker/threadLoopWorker.ts` | 新增 worker，按 Thread.loopInterval 定时触发 ThreadRunner.tick() |
| `src/components/providers/GoalSchedulerRuntime.tsx` | **已是空壳**（仅 hydrateSettings），仅需重命名为 `SettingsHydrationProvider.tsx` 并保留同样副作用 |
| `src/components/providers/RuntimeEventBridge.tsx` | 增加对 `topic.*` / `thread.*` / `agent.*` 事件类型的 projection 逻辑 |
| `src/app/api/goals/tasks/execute/route.ts` | 保留作为**调试与重放**入口（与现状一致），不再是正常流程入口；正常流程由 daemon 自治 |
| Inbox 推送逻辑 | 本期沿用现有 Inbox 写入路径，由 ThreadRunner.dispatchResult() 走命令式 API；P6 启用 Post-Gate 后改为按 `PostGateResult.notifyChannel === 'inbox'` 才插入 |

**关键原则**：所有新增 worker / 模块都必须遵循"daemon 唯一生产者 + 前端 projection-only"范式，禁止前端组件直接发起调度或写入业务状态。

#### P2 验收标准

创建一个 Topic（如"持续跟踪 NVDA"）：
1. 自动初始化若干 Thread（财报跟踪 / 技术指标 / 新闻舆情）
2. 每个 Thread 独立周期循环
3. 执行结果沿现有 notification 推送（**双闸门过滤本期不做，留给 P6**）
4. L0 模式完全静默；L3 模式按参与度规则在 confirm-required Action 上弹确认
5. 全过程事件流可追溯，中断可恢复

### 4.5 P3：Capability Resolver + Topic Coordinator

#### Capability Resolver 4 级策略

```ts
class CapabilityResolver {
  async resolve(action: Action): Promise<ExecutionPlan> {
    // L1: 已有能力直接匹配（向量检索 + 规则）
    const direct = await this.matchDirectCapability(action)
    if (direct) return { kind: 'direct', capability: direct }

    // L2: 组合已有能力
    const composed = await this.composeCapabilities(action)
    if (composed) return { kind: 'composed', capabilities: composed }

    // L3: 创建新能力（写脚本/MCP工具，需用户确认）
    const created = await this.createCapability(action)
    if (created) return { kind: 'created', capability: created }

    // L4: workaround 或求助用户
    return { kind: 'fallback', strategy: await this.fallback(action) }
  }
}
```

**能力注册表** (`src/lib/server/capability/registry.ts`)：
- Claude CLI 子命令 / MCP 工具 / 自写脚本 / HTTP API
- 元数据：描述 / 入参 / 出参 / 副作用 / 成本

**RuntimeEnvironment 扩展**：从"Claude CLI 在哪"扩展为"环境提供哪些 Capability"。

#### Topic Coordinator

跨 Thread 协调（`src/lib/server/topic/topicCoordinator.ts`）：
- 去重：A Thread 已调研某资料，B 不重复
- 关联：A 的发现影响 B 的优先级
- 推送节奏：合并/排队，避免轰炸
- 状态汇总：Topic 详情页展示"4 个 Thread，2 个 active，本周 12 条洞察"

实现：ThreadRunner 触发 Action 或准备推送时，先经过 Coordinator 仲裁（消息走 MessageBus）。P6 启用 Post-Gate 后，由 Post-Gate 在判定推送前先咨询 Coordinator。

#### P3 验收标准

- 工具不支持的 Action（如"订机票"），Capability Resolver 走到 L4 转用户
- 两个 Thread 同时想推送，Inbox 不轰炸，看到合并/排队
- 跨 Thread 关联在 DevPanel 可视化

### 4.6 P4'：ThreadLoopWorker 嵌入现有 Daemon Worker 框架

**v2.0 重要变化**：原 P4"浏览器 Scheduler 迁移到 Daemon"已被项目自身演进完成（浏览器 `GoalSchedulerRuntime.tsx` 已下线，daemon 已是唯一生产者）。本阶段**不再承担迁移工作**，而是**在已有 worker 体系中嵌入 ThreadLoopWorker**。

#### 当前 daemon worker 全景（已存在）

```
kiki-runtime-daemon
  ├─ goalSchedulerEngine    （依赖检查 / 到期判定 / 优先级 / 实例创建）
  ├─ taskDispatchWorker     （派发与执行驱动）
  ├─ goalNotificationWorker （通知投递 + watchdog）
  └─ recoveryWorker         （异常恢复）
```

#### P4' 新增

```
kiki-runtime-daemon
  ├─ goalSchedulerEngine    → 升级为通用 schedulerEngine（Topic/Thread/Task 三层）
  ├─ taskDispatchWorker     → 增加 Thread 动态产出 Task 的派发路径
  ├─ goalNotificationWorker → 本期沿用现状（仅增加对 Thread 动态 Task 的兼容）；P6 启用闸门后再升级为通用 notificationWorker（按 Post-Gate channel 分发）
  ├─ recoveryWorker         → 与 ResumeManager 协作
  ├─ ★ threadLoopWorker     【新增】按 Thread.loopInterval 触发 ThreadRunner.tick()
  ├─ ★ messageBusWorker     【新增】消费 agent_messages 投递到目标 Agent
  └─ ★ sagaCoordinatorWorker【新增】驱动 Saga 推进
```

#### 嵌入方式

新增 worker 复用现有 daemon 启动框架：
- 注册到 `src/bin/kiki-runtime-daemon.ts` 启动序列
- 沿用现有心跳、租约、日志规范
- 沿用现有 worker 退出和恢复逻辑

#### 交付物

- [ ] threadLoopWorker
- [ ] messageBusWorker
- [ ] sagaCoordinatorWorker
- [ ] daemon 启动序列扩展
- [ ] goalSchedulerEngine 升级为通用 schedulerEngine
- [ ] goalNotificationWorker 本期仅做兼容性扩展（接收 Thread 动态 Task 通知）；通用化升级延后到 P6
- [ ] taskDispatchWorker 增加 Thread 动态 Task 派发路径

#### 验收

- 关闭浏览器、电脑休眠后，Thread 仍按 loopInterval 循环
- 次日打开浏览器看到夜间 Inbox 精选结果
- daemon 重启后所有 Thread / Saga / Message 自动恢复
- 现有 `/goal`（迁移后 `/topic`）老用户行为不受影响

### 4.7 P5：Knowledge Pool

**数据模型**：

```sql
CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  source_thread_id TEXT,
  source_task_id TEXT,
  kind TEXT,              -- 'fact' | 'preference' | 'world_state' | 'pattern'
  content TEXT,
  embedding BLOB,
  conditions TEXT,        -- JSON：触发条件
  expires_at TEXT,
  created_at TEXT
);
```

**写入时机**：
- ThreadRunner 执行完写入发现
- 用户对 Inbox 反馈转为 preference
- Coordinator 写入跨 Thread 关联结论

**激活机制**：
1. 采集时检索：ThreadRunner.collect() 先查知识池补充上下文
2. 条件变化触发：定时扫描 conditions，匹配时主动 trigger Thread
3. 跨关联触发：新知识写入触发相关 Thread 重评
4. 用户唤回：会话提问时作为检索来源

**验收**：用户提问能引用历史发现；长期使用知识池命中率持续提升（**P6 启用 Post-Gate 后，再结合用户反馈让推送越来越贴合用户偏好**）。

### 4.8 P6（预留，本期不做）：双价值闸门 + Value Gate 多 Agent 辩论

P6 一次性落地两项能力，先做闸门、再按需升级为多角色辩论：

**(a) 落地 Pre-Action / Post-Action Gate**
- 新增 `src/lib/server/value/preActionGate.ts` / `postActionGate.ts`
- `PreGateResult { shouldExecute, reason, needsUserConfirm, estimatedValue, estimatedCost }`
- `PostGateResult { shouldNotify, notifyChannel: 'inbox'|'conversation'|'silent_archive', notifyFormat, priority, defer? }`
- ThreadRunner.tick() 在预留的两个扩展点接入 Gate
- Task 模型加 `preGateDecision` / `postGateDecision` 字段
- 升级 goalNotificationWorker → 通用 notificationWorker，按 PostGate channel 分发
- 升级 Inbox 写入路径，按 `notifyChannel === 'inbox'` 才插入

**(b) 闸门误判明显时启用多角色辩论**
- **Value Advocate**：主张推送
- **Noise Guardian**：主张不推送
- **Judge**：综合判断
- 可基于 Constitutional AI 思路实现对抗式裁决

---

## 第五部分：依赖关系与时间线

### 5.1 阶段依赖图

```
P0 (Event Sourcing 基础设施 - 通用化已有事件机制)
   │
   ▼
P1 (领域模型重构)
   │
   ▼
P2 (Thread 循环 + Topic 初始化多 Agent，**不含双闸门**) ←── 核心能力跃迁
   │
   ├──→ P3 (Capability Resolver + Coordinator)
   │
   ├──→ P4' (ThreadLoopWorker 嵌入现有 daemon worker 框架)
   │      ⚠ 原 P4"浏览器调度迁移"已被项目自身演进完成
   │
   ├──→ P5 (Knowledge Pool)
   │
   └──→ ⏸ P6 (本期不做：双价值闸门 + Value Gate 多 Agent 辩论)
```

**P0 + P1 + P2 是主线**，P3/P4'/P5 互不依赖，可并行也可按优先级排队。**P6 本期不做**，待 P2 上线观察一段时间后按需启用。

### 5.2 节奏建议

| 阶段 | 节奏 | 关键里程碑 |
|---|---|---|
| P0 | 集中改造，复用现有事件机制 | 模拟 Agent 中断恢复成功 |
| P1 | 集中改造，不留尾巴 | 老 Goal 数据完全迁移成功 |
| P2 | 先 P2a 后 P2b | 一个"持续关注"型 Topic 跑起来 |
| P3 | P2 验证后再做 | 无现成工具的 Action 妥善处理 |
| P4' | 与 P2 收尾合并交付 | 新增 worker 全部嵌入 daemon |
| P5 | 长尾 | 知识池命中率持续提升 |
| ⏸ P6 | 本期不做 | 待 P2 上线一段时间后，按"推送过载 / 用户反馈噪声多"等信号决定是否启用 |

---

## 第六部分：风险与应对

| 风险 | 应对 |
|---|---|
| P0 事件表膨胀，SQLite 性能下降 | 定期归档老 run 的事件流；Snapshot 加速回放；必要时切 Postgres |
| P1 数据迁移失败导致老 Goal 丢失 | 迁移前自动备份 `data/kiki.db`；提供回滚 SQL |
| P2 多 Thread 并行造成 Claude CLI 调用量暴涨 | runtime_jobs 加全局并发上限；Coordinator 节流 |
| P2 双闸门误判 | ⏸ 本期不适用（双闸门后置到 P6）；P6 启用时双闸门决策必须可追溯（事件流）；DevPanel 回放并调优 Prompt |
| P2 多 Agent 协作 Saga 死锁/无限循环 | Saga 设最大步骤数和总超时；Critic→Refiner 循环设最大迭代次数 |
| P3 Capability Resolver 创建新工具引入安全风险 | "创建新能力"无视参与度等级，强制用户确认 |
| P4' 新增 worker 与现有 worker 职责重叠 / 死锁 | 在 daemon 启动序列中明确 worker 顺序；用 lease 机制避免重复 claim；写 worker 间协作日志规范 |
| Daemon 与浏览器状态不同步 | ✅ 项目已解决：Daemon 为 source of truth，前端通过 RuntimeEventBridge 只读 |
| P5 知识池膨胀拖慢检索 | TTL + embedding 索引 + 定期清理 |
| 多 Agent 消息风暴（Agent 间循环触发） | MessageBus 每条消息 max_attempts；causation_chain 长度上限；环路检测 |

---

## 第七部分：兼容性与硬约束

### 7.1 现有工程约束（全部保留）

| 现有约束 | 改造后状态 |
|---|---|
| 产品名 KiKi | ✓ 不变 |
| Claude CLI 干净环境变量（`claudeEnv.ts`） | ✓ 不变，Capability Resolver 默认走这条路 |
| Claude `--resume` 续接 | ✓ 不变，ThreadRunner 内部仍用；事件溯源补充更细粒度 |
| `/goal` 走 Orchestrator | ✓ 升级为 `/topic`，Orchestrator 升级为多 Agent Saga |
| JSON 多级容错 | ✓ 不变，未来 P6 启用 Pre/Post Gate 输出时复用此容错 |
| EasterEgg 集中存放 | ✓ 不变，新增 loopInterval、Saga 超时等也放这里（闸门阈值 P6 启用时再加） |
| 抽屉/弹窗规范 | ✓ 不变，Thread 详情抽屉沿用规范 |
| **Daemon 唯一生产者**（v2.0 现状） | ✅ 强化：所有新增 worker / 模块严禁前端组件直接发起调度或写入业务状态 |
| **服务端权威 + 前端 projection-only**（v2.0 现状） | ✅ 强化：新增的 topicStore / threadStore / agentRunStore 全部 projection-only |
| **命令式 API + revision 乐观锁**（v2.0 现状） | ✅ 强化：所有 Topic / Thread / Agent 写动作走 `/api/.../commands` + expectedRevision |
| **SSE 通道 `/api/runtime/events/stream`**（v2.0 现状） | ✅ 强化：Agent 事件、Topic/Thread 事件全部走此通道；不另起 SSE |
| **BroadcastChannel 跨 Tab**（v2.0 现状） | ✅ 强化：Agent 状态变化也通过此机制广播 |
| **revision 防旧覆盖**（v2.0 现状） | ✅ 强化：snapshot 回灌时严格按 revision 比较 |
| **RuntimeEventBridge bootstrap 顺序**（v2.0 现状） | ✅ 严格遵守：bootstrapped && conversationHydrated 之后才连接 SSE |

### 7.2 工程取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| Event Sourcing vs 直接存状态 | Event Sourcing | 追溯和恢复要求决定 |
| 同步写事件 vs 异步批量 | 同步写、单条事务 | 异步崩溃会丢；KiKi 单用户吞吐够用 |
| 副作用前置 vs 后置 | start→执行→complete 三段式 | 让"执行到一半"可识别可恢复 |
| 幂等键策略 | hash(run_id + step_id + input) | 同输入必同 key，重放天然去重 |
| 消息投递语义 | At-least-once + 消费侧幂等 | 比 exactly-once 简单可靠 |
| Snapshot 频率 | 每 50 事件 + 关键节点 | 平衡存储和回放性能 |
| SQLite 是否够用 | 够用 | 单用户场景；WAL 模式；未来必要时切 Postgres |
| Topic 初始化多 Agent 通信 | SQLite agent_messages | 全链路留痕、可恢复 |
| Thread tick 内部通信 | 内存 EventEmitter | 单 tick 同进程、要快、不需落盘 |

---

## 第八部分：可观测性与运维

### 8.1 DevPanel "Agent 调试面板"

能力：
- Topic 总览：所有相关 Agent Run 时间线
- Agent Run 详情：完整事件流 + 因果链可视化
- Event 详情：当时的 Prompt / Tool 入参 / LLM 输出
- Replay 按钮：sandbox 模式重放，验证修复后逻辑
- Saga 进度：current_step、参与 Agent、补偿日志
- Message 流：跨 Agent 消息历史

### 8.2 常用 SQL 查询

```sql
-- 查一个 Topic 的所有 Agent 事件按时间排序
SELECT e.seq, r.agent_type, e.event_type, e.payload
FROM agent_events e
JOIN agent_runs r ON e.run_id = r.id
WHERE r.topic_id = ?
ORDER BY e.seq;

-- 追溯某事件的完整因果链（递归 CTE）
WITH RECURSIVE chain AS (
  SELECT * FROM agent_events WHERE seq = ?
  UNION ALL
  SELECT e.* FROM agent_events e
  JOIN chain c ON e.seq = c.caused_by_event_seq
)
SELECT * FROM chain ORDER BY seq;

-- 查找卡住的 Agent
SELECT * FROM agent_runs
WHERE status = 'paused' AND completed_at IS NULL
  AND datetime(started_at) < datetime('now', '-1 hour');

-- 查找待处理的 Agent 消息
SELECT * FROM agent_messages
WHERE status = 'pending' AND deliver_after <= datetime('now')
ORDER BY created_at;

-- 死信队列
SELECT * FROM agent_messages WHERE status = 'dead_letter';
```

### 8.3 监控指标

- Agent Run：每类 Agent 的运行数 / 失败率 / 平均耗时
- Event：写入速率 / 总条数 / 表大小
- Message：pending 堆积 / consumed 速率 / dead_letter 数
- Saga：成功率 / 平均步骤数 / 补偿触发次数
- Pre/Post Gate：通过率 / 拦截率 / 用户反馈关联误判率（⏸ P6 启用闸门后才有）

---

## 第九部分：最终目标总结

| 目标 | 实现机制 |
|---|---|
| **单 Agent 执行可追溯** | 每 step 写 step_started + step_completed 事件，包含输入、输出、副作用 ID |
| **单 Agent 可中断恢复** | 状态机 + 幂等键去重 + ResumeManager 自动扫描；崩溃后从最后一个事件继续 |
| **跨 Agent 通信可追溯每一步** | agent_messages 表 + caused_by_event_seq + caused_by_message_id 形成完整因果链 |
| **跨 Agent 可中断恢复** | Saga 模式 + saga_instances 表记录协作进度；At-least-once + 消费侧幂等 |
| **持续运转** | Daemon 接管 ThreadLoopWorker；不依赖浏览器生命周期 |
| **价值过滤** | ⏸ 本期暂沿用现有 notification 逻辑；P6 启用双闸门（Pre-Action + Post-Action）+ 用户参与度 L0-L4 |
| **行动空间不受限** | Capability Resolver 4 级策略（直接匹配 / 组合 / 创建 / fallback） |
| **多 Topic 多 Thread 并行** | 每个 Thread 独立 Worker Agent + Topic Coordinator 仲裁 |
| **知识积累** | Knowledge Pool 跨 Thread 共享 + 多种激活机制 |
| **可观测可调试** | DevPanel + 事件流回放 + SQL 直查 + 监控指标 |

---

## 第十部分：补充设计要点

### 10.1 静态规划 + 动态调度混合模型

Task 的调度并非纯动态，而是分两类：

| Task 类型 | 调度方式 | 落地位置 |
|---|---|---|
| 不依赖动态信号的 Task<br>（如"每周日 20:00 生成本周复盘"） | **静态时间规划** | 落到 `scheduleEvents` 表，Schedule 页可见 |
| 依赖动态信号的 Task<br>（如"NVDA 重大公告即时解读"） | **Thread 循环按需触发** | ThreadRunner.tick() 内动态生成 |
| 动态触发改变了静态规划 | 触发"用户确认"流程 | 本期按参与度规则决定是否打断；P6 启用后由 Pre-Gate 统一判定 |

**Schedule 页 UI** 需区分两类事件来源（静态计划 / 动态触发），并标注当前状态。

### 10.2 Step 显式建模的判定

**Step 不强制存在**，仅在以下场景显式建模：
- 需要持久化中间状态（断点恢复 step 级粒度）
- 需要向用户展示进度条
- 需要支持 step 级的回滚

否则 Task 直接作为执行黑盒，内部由 ReAct 循环或 Agent 内部状态机处理，**不写入 Step 表**。

事件溯源天然支持 step 级粒度（agent_events.step_id），即便不显式建 Step 实体也能追溯。

### 10.3 嵌套规则

| 实体 | 是否允许嵌套 | 上限 | 理由 |
|---|---|---|---|
| Topic | ❌ 不允许子 Topic | - | Topic 是顶层，平铺 |
| Thread | ❌ 不允许嵌套子 Thread | - | 嵌套会让循环调度复杂化，应该新建平级 Thread |
| Task | ✅ 允许 Subtask | 1 层 | 大型 Task 拆分需要；超过 1 层应升级为新 Thread |
| Step | ❌ 不允许子 Step | - | Step 已是最细粒度 |

### 10.4 会话与 Topic 的关系重定位

| 实体 | 当前 KiKi 角色 | 改造后角色 |
|---|---|---|
| Conversation | 目标澄清入口 + 普通对话；已是 projection-only + 命令式写入 | **Topic 的对话面板**——绑定 Topic 后，Topic 内所有 Thread 的产出汇聚到这里；写动作走 `/api/conversations/commands`（v2.0 现状沿用） |
| Inbox | 系统主动推送的承接；projection-only | 本期沿用现有 Inbox 写入逻辑（ThreadRunner 派发结果直接走命令式 API）；**P6 启用 Post-Gate 后**升级为"价值推送收件箱"——只有判定值得推送才进，通过通用 notificationWorker 写入 |
| Schedule | 任务自动生成的执行事件；projection-only | **静态规划 Task** 的时间面板，叠加 Thread 动态触发的关键事件 |

**绑定关系**：
- 一个 Conversation 可以绑定一个 Topic（多对一关系：Topic 可有多个对话窗口，每个对话窗口对应一个 Conversation）
- 普通对话（不绑定 Topic）仍保留，作为快速 Claude 对话入口
- 所有写动作严格走命令式 API + revision 乐观锁（沿用 v2.0 现状）

### 10.5 退场与归档机制

**完全由用户管理，系统不自动归档**：
- Topic 状态 `archived` 由用户主动触发
- Thread 状态 `archived` 由用户主动触发
- 归档后：
  - 不再进入 Thread Loop Worker 调度
  - 历史事件流保留（追溯能力不丢）
  - 可在"归档区"查看，可一键恢复为 active

**例外情况**（系统提示但仍需用户确认）：
- Topic 有 deadline，deadline 到期 → 提示用户是否归档
- Thread 连续 N 次 tick 无产出 → 提示用户是否暂停或归档

### 10.6 内存事件总线的精确使用范围

**仅在以下场景使用 Node EventEmitter**：

| 场景 | 范围 | 生命周期 |
|---|---|---|
| ThreadRunner 单次 tick 内部 | 采集→相关性→推理→Capability→执行→派发 流水线（P6 启用后增加 Pre/Post Gate 节点） | tick 开始创建，结束销毁 |
| 同进程 Agent 间的临时通知 | 如 Coordinator 同进程内通知 Thread | 进程内常驻 |

**绝对不使用内存总线的场景**：
- 跨进程通信（Web ↔ Daemon ↔ Worker）
- 跨 Agent Run 通信
- Saga 协作步骤间通信
- 任何需要"留痕 + 恢复"的通信

### 10.7 用户反馈学习链路

⏸ **本期不实现**：该链路依赖 Post-Gate 与 Knowledge Pool（P5），整体留到 P6 启用闸门后再做。本期 Inbox 仍只承载结果展示，不引入快捷反馈按钮与偏好学习回路。

P6 启用后规划（不变）：

```
Inbox 卡片
   ↓ 用户操作
   ├─ 点击查看 → 信号：value=high
   ├─ 忽略 → 信号：value=low
   ├─ 反问/吐槽 → 信号：value=low + noise=high
   ├─ 标记"以后不要" → 强信号：直接屏蔽此类
   └─ 标记"很有帮助" → 强信号：提升此类权重
   ↓
反馈写入 knowledge_items (kind='preference')
   ↓
下一次 Post-Gate 检索时纳入决策上下文
   ↓
推送质量逐步贴合用户偏好
```

**实现要点**（P6 启用时再落地）：
- Inbox UI 加快捷反馈按钮（👍 / 👎 / "以后不要"）
- 反馈事件作为 agent_events 写入，可追溯
- 反馈聚合作为 preference 类知识沉淀到 Knowledge Pool（P5）
- 若 P5 尚未上线，可用简单的规则学习（如 thumbs_down 次数 > 阈值则降权）

### 10.8 DevPanel 新增视图清单

P0 阶段新增基础视图：
1. **Agent Runs 列表页**：所有 Agent Run，按状态筛选
2. **Agent Run 详情页**：事件流时间线、当前状态、因果链可视化
3. **Event 详情侧栏**：Prompt / Tool 入参 / LLM 输出

P2 阶段新增：
4. **Saga 进度视图**：current_step、参与 Agent、补偿日志
5. **Message 流视图**：跨 Agent 消息历史，可按 Topic/Thread 筛选
6. **Topic 全景视图**：Topic 内所有 Thread 状态 + 事件汇总

P3 阶段新增：
7. **Capability Registry 浏览**：已注册能力列表
8. **Coordinator 仲裁日志**：跨 Thread 仲裁决策

P5 阶段新增：
9. **Knowledge Pool 浏览**：知识条目列表 + 检索测试

⏸ P6 阶段新增（本期不做）：
10. **Pre/Post Gate 决策回放**：选 Inbox 历史，看为什么被推送/被过滤

---

## 附录 A：术语对照表

| 旧术语 | 新术语 | 说明 |
|---|---|---|
| Goal | Topic | 顶层实体，deadline/quantifiable 变为可选 |
| SubGoal | Thread | 持续推进的活循环单元，取代静态拆解块 |
| /goal | /topic | 命令入口（/goal 保留为别名） |
| goalStore | topicStore | Zustand store（projection-only） |
| goalWorkflow | topicWorkflow | 编排状态机 |
| goalPlanning | topicPlanning | 服务端规划逻辑 |
| GoalSchedulerRuntime | SettingsHydrationProvider | 已是空壳（仅 hydrateSettings），重命名明确职责 |
| goalSchedulerEngine | schedulerEngine（通用化） | 支持 Topic/Thread/Task 三层 |
| goalNotificationWorker | 本期保留原名（仅做兼容性扩展）；P6 启用闸门后升级为通用 notificationWorker | 按 Post-Gate 决定 channel（P6 启用时生效） |
| goalTaskRunner | taskExecutor | 被 ThreadRunner.execute() 调用 |
| `conversation_event_log` / `goal_event_log` | 保留作为领域事件 + 新增通用 `agent_events` | 两者并存，互不替代 |
| `/api/goals/commands` | `/api/topics/commands` | 命令式 API 改名 |
| RuntimeStateBridge | RuntimeEventBridge（v2.0 现状已改造） | projection-only |
| ~~浏览器 Scheduler~~ | ~~已下线~~ | 不再讨论 |

## 附录 B：阶段交付物清单速查

### P0 交付物
- [ ] agent_runs / agent_events / agent_messages / saga_instances / agent_snapshots 五张表
- [ ] AgentExecutor 状态机驱动器
- [ ] MessageBus 跨 Agent 消息总线（基于 SQLite + 命令式 API + revision 乐观锁）
- [ ] SagaCoordinator
- [ ] ResumeManager（与 recoveryWorker 协作，daemon 启动时调用）
- [ ] StateProjector + SnapshotManager
- [ ] Agent 事件接入现有 `/api/runtime/events/stream`（扩展 event type 枚举）
- [ ] 前端 `agentRunStore`（projection-only）
- [ ] `/api/agents/runs/commands` 命令式写路径
- [ ] DevPanel Agent 调试面板（基础版）

### P1 交付物
- [ ] Topic / Thread 类型定义
- [ ] topicStore 替换 goalStore（projection-only）
- [ ] SQLite 表名 + 字段迁移（含 conversation_event_log / goal_event_log 改名为 topic_event_log）
- [ ] 数据迁移脚本（含备份）
- [ ] 路由 /goals → /topics
- [ ] UI 组件改名
- [ ] /topic 命令入口（/goal 保留为别名）
- [ ] `/api/goals/commands` → `/api/topics/commands` 改名
- [ ] RuntimeEventBridge 新增对 `topic.*` / `thread.*` 事件的 projection

### P2 交付物
- [ ] ThreadRunner（V4 Pipeline 实现，**两个 Gate 扩展点预留但不实现**）
- [ ] 5 个 Topic 初始化 Agent（Interviewer/Planner/Critic/Refiner/Presenter）
- [ ] TopicInitSaga 编排器
- [ ] 用户参与度 L0-L4 设置 UI（本期由参与度规则直接判定是否打断）
- [ ] threadLoopWorker（与现有 worker 并列）
- [ ] goalSchedulerEngine 升级为通用 schedulerEngine
- [ ] goalNotificationWorker 本期仅做兼容性扩展（接收 Thread 动态 Task 通知）；通用化升级延后到 P6
- [ ] taskDispatchWorker 增加 Thread 动态 Task 派发路径
- [ ] `GoalSchedulerRuntime.tsx` 重命名为 `SettingsHydrationProvider.tsx`
- ⏸ ~~Pre-Action Value Gate~~（后置到 P6）
- ⏸ ~~Post-Action Value Gate~~（后置到 P6）

### P3 交付物
- [ ] Capability Resolver 4 级策略
- [ ] Capability Registry
- [ ] RuntimeEnvironment Capability 扩展
- [ ] TopicCoordinator 跨 Thread 协调
- [ ] coordinator 走 MessageBus 进行仲裁

### P4' 交付物（替代原 P4）
- [ ] threadLoopWorker
- [ ] messageBusWorker
- [ ] sagaCoordinatorWorker
- [ ] daemon 启动序列扩展
- [ ] worker 间协作的日志规范统一

### P5 交付物
- [ ] knowledge_items 表
- [ ] Embedding 检索
- [ ] 4 种激活机制（采集检索 / 条件触发 / 跨关联触发 / 用户唤回）
- [ ] 知识池清理 Job

### ⏸ P6 交付物（本期不做，预留）
- [ ] Pre-Action Value Gate（含 PreGateResult 结构 + LLM Prompt + 参与度规则融合）
- [ ] Post-Action Value Gate（含 PostGateResult 结构 + channel 决策）
- [ ] ThreadRunner.tick() 接入两个 Gate 扩展点
- [ ] Task 模型扩展 `preGateDecision` / `postGateDecision` 字段
- [ ] goalNotificationWorker 升级为通用 notificationWorker（按 PostGate channel 分发）
- [ ] Inbox 写入路径改为按 `notifyChannel === 'inbox'` 才插入
- [ ] DevPanel Pre/Post Gate 决策回放视图
- [ ] 用户反馈学习链路（Inbox 反馈按钮 + 偏好聚合）
- [ ] （按需）Value Advocate / Noise Guardian / Judge 多角色辩论
