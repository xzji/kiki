# Topic / Thread 代码实现计划 v1

> **目的**：把《Topic_拆解需求对齐方案 v8》和《KiKi_改造方案 v1（v2.1）》两份产品/架构文档落到具体的代码改造路径上，让一个工程师拿到本文即可按章节顺序实施，不需要再做架构决策。
>
> **前置阅读**（读完本计划之前必须先翻过）：
>
> * [.trae/documents/Topic_拆解需求对齐方案.md](file:///Users/bytedance/Documents/trae/long_horizon_agent/.trae/documents/Topic_%E6%8B%86%E8%A7%A3%E9%9C%80%E6%B1%82%E5%AF%B9%E9%BD%90%E6%96%B9%E6%A1%88.md) — 产品需求 v8（含 Prompt 适配清单）
> * [docs/plans/KiKi_改造方案_v1.md](file:///Users/bytedance/Documents/trae/long_horizon_agent/docs/plans/KiKi_%E6%94%B9%E9%80%A0%E6%96%B9%E6%A1%88_v1.md) — 架构方案 v2.1
>
> **本计划只覆盖本期范围**（P0 → P2），P3+（Capability Resolver / Knowledge Pool / Pre-Post Value Gate）仅留接口预留。

---

## 一、Summary

### 1.1 目标
- 数据模型：Goal/SubGoal/Task → Topic/Thread/Task；deadline 变可选；新增 `loopInterval`、`completionCriteria`、`status`。
- 编排：新增 5 角色拆解 Saga（Interviewer→Planner→Critic⇄Refiner→Presenter）；新增 ThreadRunner.tick 单 prompt 流水线；现有 Task 执行链路（5 角色）保留不动。
- 调度：新增 ThreadLoopWorker，与现有 4 个 worker 并列；scheduler 升级为 Topic/Thread/Task 三层判定。
- 持久化：新增 5 张表（agent_runs / agent_events / agent_messages / saga_instances / agent_snapshots），事件 payload ≤ 8KB。
- Prompt：删除 `DEFAULT_DEADLINE` 兜底；所有新增 prompt 沿用决策/展示层拆分硬约束。
- 兼容：旧 `/api/goals/*` 别名保留 2 个版本；DB 迁移采用 dry-run + 自动备份 + 48h 代码冻结期。

### 1.2 不在本期范围
- Topic 会话 Agent（会话窗口仍是普通对话）
- Topic Coordinator（v6 已删除）
- 跨 Thread 事件订阅 / EventDispatcher
- 外部 webhook / RSS / 行情流接入
- Knowledge Pool / Pre-Post Value Gate

### 1.3 阶段划分

| 阶段 | 主题 | 核心交付 | 上线前置 |
| --- | --- | --- | --- |
| P0 | Event Sourcing 基础设施 | 5 张新表 + repositories + agentRuntime/ + RuntimeEventBridge 扩展 | DB migration v11 dry-run 通过 |
| P1 | 领域模型重构 | Topic/Thread 类型 + Store 重命名 + UI 路由迁移 + 老数据迁移 | DB migration v12 dry-run 通过 |
| P1.5 | Prompt 适配 | 5 角色拆解 Saga prompt + ThreadRunner.tick prompt + 删除 DEFAULT_DEADLINE | promptDuplicationGuardSpec 全绿 |
| P2 | 编排循环升级 | TopicInitSaga + ThreadRunner + ThreadLoopWorker | 端到端冒烟"持续跟踪 NVDA"通过 |

---

## 二、Current State Analysis

### 2.1 数据层现状

- 类型集中：[src/types/kiki.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts)
  - L362–L385 `Task`：`subGoalId` / `taskType:"repeat"|"one_shot"` / `triggerRule:string` / `deadline?` / `instances[]`
  - L387–L399 `SubGoal`：`goalId` / `tasks[]` / `successCriteria[]`
  - L410–L422 `Goal`：`deadline`（**当前必填**）/ `subGoals[]` / `kind?` / `workflow?`
- 多 Agent 编排类型：[src/types/agentOrchestration.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/agentOrchestration.ts)
  - `AgentRole = "coordinator" | "researcher" | "executor" | "reviewer" | "synthesizer"`（注意**没有** Interviewer/Planner/Critic/Refiner/Presenter）
  - 现有 5 角色服务于"单 Task 内的多角色协作"，**不**用于 Topic 拆解 Saga
- mocks：[src/mocks/goals.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/mocks/goals.ts) 与 [src/mocks/conversations.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/mocks/conversations.ts)

### 2.2 持久化层现状

- DB 引擎：better-sqlite3 + WAL，单例 [src/lib/server/db/client.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/db/client.ts)
- Schema：[src/lib/server/db/schema.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/db/schema.ts)，当前 `KIKI_DB_SCHEMA_VERSION = 10`，已有 9 张表。
- 写路径：command service（goalCommandService / conversationCommandService 等）+ runtimeService projections
- **当前完全没有**：agent_runs、agent_events、agent_messages、saga_instances、agent_snapshots
- **当前完全没有**：Topic / Thread / TopicInitSaga 相关 repository

### 2.3 Saga / 多 Agent 编排现状

- 现有目录：[src/lib/server/agentOrchestration/](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/agentOrchestration/)
  - `MultiAgentOrchestrator.ts`（L108–L191 `runRole` / L193–L315 `runMultiAgentOrchestration`）
  - `prompts.ts`（L62–L264，5 角色 prompt builder）
  - `strategy.ts` / `handoff.ts` / `review.ts`
- 拆解 Saga 当前实质实现：[src/lib/server/goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts)（约 2400 行）
  - L163 `DEFAULT_DEADLINE = "2026-06-30T23:59:59+08:00"`（**必须删除**）
  - L361–L381 `buildGoalClarificationPrompt`
  - L383–L417 `buildGoalFollowUpQuestionsPrompt`
  - L450–L532 `buildDecomposePrompt`
  - L592–L630 `buildPlanPresentationPrompt`
  - L1415–L1516 `reviewTaskDraftsWithClaude`（决策层）
  - L1525–L1591 `generateTaskReviewExplanation`（异步展示层 fire-and-forget）
  - L1665–L2166 `generateGoalPlanWithClaude`（主入口，有 checkpoint）
- Block 协议：[src/lib/server/goalPlanning/taskDraftPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftPrompt.ts) + [taskDraftReview.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts) + [blockProtocol.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/blockProtocol.ts) + [taskCompiler.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskCompiler.ts)

### 2.4 调度系统现状

- 4 个 worker（[src/lib/server/worker/](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/)）
  - `goalSchedulerEngine.ts` L78–L132：tick 循环；每次最多 50 个任务
  - `taskDispatchWorker.ts` L44–L253：抢占 1 个 queued job → renewLease(30s) → runGoalTask
  - `goalNotificationWorker.ts` L61–L92 / L94–L179 / L181–L236
  - `recoveryWorker.ts`：releaseExpiredRuntimeJobLeases
- triggerRule 解析：[src/lib/taskTriggerTime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskTriggerTime.ts) L8–L16 + L177–L219
- Daemon 入口：[src/bin/kiki-runtime-daemon.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/bin/kiki-runtime-daemon.ts) → [src/lib/daemon/daemonRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/daemon/daemonRunner.ts)
- **当前完全没有** Thread 级 tick 概念

### 2.5 UI 层现状

- 已迁移：[src/components/goal/GoalPlanContent.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/goal/GoalPlanContent.tsx) 已移除圆环，meta 分两行（仅 deadline 存在时渲染）。
- 待重命名：`src/components/goal/`（11 个文件）→ `src/components/topic/`
- 待重命名：`src/app/goals/[goalId]/` → `src/app/topics/[topicId]/`
- 状态投影：[src/components/providers/RuntimeEventBridge.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeEventBridge.tsx) 需识别新事件
- Stores：[src/stores/goalStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/goalStore.ts) → `topicStore.ts`

### 2.6 测试现状

- **不**用 vitest / jest；走 `pnpm test:planning` → [scripts/run-planning-specs.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/scripts/run-planning-specs.ts)，每个 spec 文件 export `run*Specs()`，需手动注册。
- 现有 spec 同层放置（不在 `__tests__/`），断言用 `node:assert`。

---

## 三、Proposed Changes

### 3.0 总体原则

| 原则 | 落实方式 |
| --- | --- |
| 决策/展示层拆分 | 所有新增 prompt 都要拆 `decisionPrompt` + `presentationPrompt`，参照 [taskDraftReview.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts) 模式 |
| 事件 payload ≤ 8KB | 写入 `agent_events` 前先 `Buffer.byteLength`，超限走外部文件存储并保留 `payloadRef` |
| revision + idempotencyKey 乐观锁 | 所有新 command service 沿用 [goalCommandService.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/services/goalCommandService.ts) L1–L120 的范式 |
| 兼容别名保留 2 版本 | 旧 `/api/goals/*` route 改为内部转发到 `/api/topics/*`，并打 `Deprecation: true` header |
| migration dry-run | DB migration 必须先在 SQLite 临时副本上 `BEGIN` → 跑迁移 → `ROLLBACK` 通过后再真跑 |

### 3.1 P0：Event Sourcing 基础设施

#### 3.1.1 新增 DB 表（migration v11）

**文件**：[src/lib/server/db/schema.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/db/schema.ts)

- `KIKI_DB_SCHEMA_VERSION` 从 10 改为 11
- `KIKI_DB_MIGRATIONS` 数组追加一条 v11，DDL 严格按 [KiKi_改造方案_v1.md L321–L471](file:///Users/bytedance/Documents/trae/long_horizon_agent/docs/plans/KiKi_%E6%94%B9%E9%80%A0%E6%96%B9%E6%A1%88_v1.md) 落地：

```sql
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  topic_id TEXT,
  thread_id TEXT,
  task_id TEXT,
  saga_instance_id TEXT,
  role TEXT NOT NULL,            -- interviewer/planner/critic/refiner/presenter/thread_runner
  status TEXT NOT NULL,           -- pending/running/completed/failed/paused
  started_at TEXT NOT NULL,
  finished_at TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT
);
CREATE INDEX agent_runs_topic_idx ON agent_runs(topic_id);
CREATE INDEX agent_runs_saga_idx ON agent_runs(saga_instance_id);

CREATE TABLE agent_events (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,             -- llm.request / llm.response / decision / dispatch / message / error
  payload TEXT NOT NULL,          -- JSON ≤ 8KB
  payload_ref TEXT,               -- 超限时引用外部文件路径
  created_at TEXT NOT NULL,
  UNIQUE(agent_run_id, seq)
);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  saga_instance_id TEXT NOT NULL,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  kind TEXT NOT NULL,             -- handoff / review / refinement
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE saga_instances (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  type TEXT NOT NULL,             -- topic_init / thread_loop
  status TEXT NOT NULL,
  current_step TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE agent_snapshots (
  agent_run_id TEXT PRIMARY KEY,
  last_event_seq INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**dry-run 验证步骤**：
1. 复制 prod DB 到临时路径
2. 跑迁移 → 检查表结构、索引
3. ROLLBACK + 删临时文件
4. 真跑前自动 `cp prod.db prod.db.backup-$(date +%s)`

#### 3.1.2 新增 Repositories

**新建目录**：`src/lib/server/repositories/agentRuntime/`

| 新文件 | 关键 export | 参照 |
| --- | --- | --- |
| `agentRunsRepository.ts` | `createAgentRun` / `updateAgentRunStatus` / `findAgentRunById` / `listAgentRunsBySaga` | [goalEventLogRepository.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/repositories/goalEventLogRepository.ts) 幂等键模式 |
| `agentEventsRepository.ts` | `appendAgentEvent(runId, seq, type, payload)` / `listAgentEvents(runId, fromSeq?)` | 同上 |
| `agentMessagesRepository.ts` | `appendAgentMessage` / `listMessagesBySaga` | 同上 |
| `sagaInstancesRepository.ts` | `createSagaInstance` / `updateSagaStatus` / `incrementRetry` | 同上 |
| `agentSnapshotsRepository.ts` | `upsertAgentSnapshot` / `loadAgentSnapshot` | 同上 |

#### 3.1.3 新增类型

**新文件**：`src/types/agentRuntime.ts`

```typescript
export type AgentRunStatus = "pending" | "running" | "completed" | "failed" | "paused";
export type AgentEventType =
  | "llm.request" | "llm.response"
  | "decision" | "dispatch" | "message" | "error" | "snapshot";

export type AgentEvent = {
  id: string;
  agentRunId: string;
  seq: number;
  type: AgentEventType;
  payload: Record<string, unknown>;
  payloadRef?: string;
  createdAt: string;
};

export type SagaType = "topic_init" | "thread_loop";
export type SagaStatus = "pending" | "running" | "awaiting_user" | "completed" | "failed";

export type SagaInstance = {
  id: string;
  topicId: string;
  type: SagaType;
  status: SagaStatus;
  currentStep?: string;
  retryCount: number;
  revision: number;
  startedAt: string;
  finishedAt?: string;
};
```

#### 3.1.4 新增 agentRuntime/ 通用层

**新建目录**：`src/lib/server/agentRuntime/`（与现有 `agentOrchestration/` **并列**，**不**合并 — 两者职责不同）

| 新文件 | 职责 |
| --- | --- |
| `agentExecutor.ts` | 通用执行器：`run(role, prompt, ctx) → AgentEvent[]`；负责 LLM 调用 + 写 agent_events；payload 超限自动外置 |
| `sagaCoordinator.ts` | Saga 状态机：步骤转移 / 失败兜底 / 重启续接（基于 last_event_seq） |
| `messageBus.ts` | 角色间结构化消息传递（写 agent_messages）；本期为内存传递 + 持久化日志 |
| `resumeManager.ts` | daemon 重启时扫 `saga_instances.status = "running"`，按 last_event_seq + snapshot 恢复 |
| `payloadGuard.ts` | `assertPayloadSize(payload) → { inline, ref? }`，超 8KB 写文件保留引用 |

#### 3.1.5 新增命令式 API

**新文件**：`src/app/api/agents/runs/commands/route.ts`

支持的 command：`pause` / `resume` / `cancel` / `retry`，沿用 revision 乐观锁。

#### 3.1.6 RuntimeEventBridge 扩展

**改文件**：[src/components/providers/RuntimeEventBridge.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeEventBridge.tsx)

新增事件 projection：`agent.run.started` / `agent.run.event` / `agent.run.completed` / `saga.step.advanced`，分别落到对应 store。

#### 3.1.7 Spec 注册

**新建**：
- `src/lib/server/agentRuntime/agentExecutor.spec.ts` → `runAgentExecutorSpecs()`
- `src/lib/server/agentRuntime/payloadGuard.spec.ts` → `runPayloadGuardSpecs()`
- `src/lib/server/agentRuntime/resumeManager.spec.ts` → `runResumeManagerSpecs()`

**改文件**：[scripts/run-planning-specs.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/scripts/run-planning-specs.ts) 注册以上 3 个入口。

---

### 3.2 P1：领域模型重构

#### 3.2.1 新增类型

**新文件**：`src/types/topic.ts`

```typescript
export type ThreadLoopInterval =
  | "realtime" | "hourly" | "daily" | "weekly"
  | { kind: "cron"; expr: string }
  | "one_shot";

export type ThreadStatus = "active" | "paused" | "archived";
export type TopicStatus = "collecting_info" | "active" | "paused" | "archived";

export type Thread = {
  id: string;
  topicId: string;
  title: string;
  intent: string;
  loopInterval: ThreadLoopInterval;
  status: ThreadStatus;
  lastTickAt?: string;
  nextTickAt?: string;
  /** Thread 共享 memory 池；payload ≤ 8KB */
  memory: Record<string, unknown>;
  /** 连续无产出次数（silent 累计），仅用于 UI 提示，不影响状态 */
  silentCount: number;
  /** 连续 tick 失败次数，达 5 自动 paused */
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type Topic = {
  id: string;
  conversationId?: string;
  title: string;
  summary: string;
  /** 可选 — 仅当用户显式给出时填写 */
  deadline?: string;
  /** 可选 — 仅当用户显式给出时填写 */
  completionCriteria?: string;
  threads: Thread[];
  status: TopicStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
};
```

**改文件**：[src/types/kiki.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts)
- L362–L385 `Task`：`subGoalId` → `threadId`（保留 `subGoalId` 作为 deprecated alias 1 版本）
- L387–L399 `SubGoal`：标记 `@deprecated`，类型别名指向 `Thread`，但**不再被新代码引用**
- L410–L422 `Goal`：标记 `@deprecated`，类型别名指向 `Topic`
- L401 `GoalKind`：暂保留（迁移到 `Topic.kind` 由后续补丁处理）

#### 3.2.2 DB Migration v12

**改文件**：[src/lib/server/db/schema.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/db/schema.ts)

- `KIKI_DB_SCHEMA_VERSION` 从 11 改为 12
- 老 `runtime_state_snapshots.snapshot.goals[]` 中的 Goal/SubGoal/Task 数据**就地物理重命名**：
  - `Goal.deadline` 没值的设为 `null`（**禁止用 `2026-06-30` 兜底**）
  - `Goal` → `Topic`（`status` 默认 `active`，`completionCriteria` 默认 `null`）
  - `SubGoal[]` → `Thread[]`（`loopInterval` 默认 `daily`，`status` 默认 `active`，`memory: {}`，`silentCount: 0`，`failureCount: 0`）
  - `Task.subGoalId` → `Task.threadId`（值保持不变，因为 SubGoal id 直接复用为 Thread id）
- 物理迁移前自动 `cp` 备份；上线后 48h 代码冻结期。

#### 3.2.3 命令服务重命名

| 旧文件 | 新文件 | 改动 |
| --- | --- | --- |
| [goalCommandService.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/services/goalCommandService.ts) | `topicCommandService.ts` | command 类型重命名：`create_goal` → `create_topic`；`create_sub_goal` → `create_thread`；保留 `goalCommandService.ts` 一个版本作为 thin wrapper 转发到新服务 |
| [goalRuntimeService.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/services/goalRuntimeService.ts) | `topicRuntimeService.ts` | `writeGoalsProjection` → `writeTopicsProjection`，同样保留 wrapper |

#### 3.2.4 Stores 重命名

| 旧文件 | 新文件 | 字段映射 |
| --- | --- | --- |
| [src/stores/goalStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/goalStore.ts) | `topicStore.ts` | `goals` → `topics`；保留 `goalStore.ts` 别名重导出 |
| [src/stores/conversationStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/conversationStore.ts) | 同名编辑 | `goalId` → `topicId`；`goalInfoCollection` → `topicInfoCollection` |

#### 3.2.5 API 路由

**新建**：`src/app/api/topics/[topicId]/route.ts` + `commands/route.ts`
**保留**：`src/app/api/goals/[goalId]/route.ts` 作为 thin proxy，加 `Deprecation` header；2 个版本后删除。

#### 3.2.6 页面重命名

| 旧路径 | 新路径 |
| --- | --- |
| [src/app/goals/[goalId]/page.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/goals/) | `src/app/topics/[topicId]/page.tsx` |
| `src/app/goals/[goalId]/tasks/[taskId]/page.tsx` | `src/app/topics/[topicId]/tasks/[taskId]/page.tsx` |
| `src/app/goals/[goalId]/deliverable/page.tsx` | `src/app/topics/[topicId]/deliverable/page.tsx` |

旧路径保留为 server-side redirect（HTTP 308）2 个版本。

#### 3.2.7 组件重命名

整个目录 `src/components/goal/` → `src/components/topic/`（11 个文件）：
- `GoalPlanContent.tsx` → `TopicPlanContent.tsx`
- `GoalPlanBreadcrumb` → `TopicPlanBreadcrumb`
- `SubGoalBlock.tsx` → `ThreadBlock.tsx`
- `SubGoalCreateDrawer.tsx` → `ThreadCreateDrawer.tsx`
- 其余按字面映射

**新增 UI 行为**（GoalPlanContent.tsx 已落地的两条不动）：
- meta 第一行：`Threads N · Tasks M`
- meta 第二行：仅当 `topic.deadline` 非空时显示 `截止 X · 剩余 Y 天`

**手动添加 Task 入口**（[Topic_拆解需求对齐方案 7.1](file:///Users/bytedance/Documents/trae/long_horizon_agent/.trae/documents/Topic_%E6%8B%86%E8%A7%A3%E9%9C%80%E6%B1%82%E5%AF%B9%E9%BD%90%E6%96%B9%E6%A1%88.md)）：必须显示 Thread 选择下拉，**禁止**允许"无 Thread 归属"提交。

#### 3.2.8 Mocks 同步

[src/mocks/goals.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/mocks/goals.ts) → `src/mocks/topics.ts`，按新类型重新写一份；保留旧文件 1 个版本作为转换器。

---

### 3.3 P1.5：Prompt 适配

#### 3.3.1 新建 Topic 拆解 Saga prompt 目录

**新建**：`src/lib/server/topicSaga/prompts/`

| 新文件 | 决策层 export | 展示层 export |
| --- | --- | --- |
| `interviewerPrompt.ts` | `buildInterviewerDecisionPrompt` | `buildInterviewerPresentationPrompt` |
| `plannerPrompt.ts` | `buildPlannerDecisionPrompt` | `buildPlannerPresentationPrompt` |
| `criticPrompt.ts` | `buildCriticDecisionPrompt` | `buildCriticPresentationPrompt` |
| `refinerPrompt.ts` | `buildRefinerDecisionPrompt` | （无展示层，refiner 直接复用 planner 的展示模板） |
| `presenterPrompt.ts` | `buildTopicPresenterPrompt`（有 deadline / 无 deadline 两套措辞） | — |

**关键约束**（每个 prompt 都要写进系统提示）：
- 决策层强制 `{ … }` 单 JSON，禁止 markdown / 代码块；明确"≤ N 行 ≤ X 字符"
- `deadline` / `completionCriteria` 缺失合法，输出 `null`，**禁止任何 DEFAULT_DEADLINE 兜底**
- Planner 输出契约改为 `topic.threads[].seedTasks[]`，不再产出 SubGoal[]
- Critic 6 视角 + 不把"无 deadline"判为缺陷 + 财务/交易类 Task 必须至少 `agent_with_user_confirmation`
- 沿用 `collaborationMode` 4 档；禁止 `participationLevel` / `topicKind` / `quantifiable` 字段

#### 3.3.2 拆解主入口迁移

**新文件**：`src/lib/server/topicPlanning.ts`

- 把 [goalPlanning.ts L1665–L2166 generateGoalPlanWithClaude](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L1665) 重命名为 `generateTopicPlanWithClaude`，内部步骤改为：
  1. Interviewer（信息收集）—— 复用 [L361 buildGoalClarificationPrompt](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L361) 改造而来的 `buildInterviewerDecisionPrompt`，并加"必问字段覆盖率"判定（必问 3 项至少覆盖 2 项即可结束；首条消息含 80% 字段直接跳过）
  2. Planner（拆解出 Threads + 种子 Tasks）
  3. Critic ⇄ Refiner（最大 3 轮）
  4. Presenter（展示层异步 fire-and-forget）
- 主链路落 `agent_events` + `saga_instances`
- 旧 `goalPlanning.ts` 保留 thin wrapper 转发到 `topicPlanning.ts`，1 个版本后删除

**删除**：[goalPlanning.ts L163 DEFAULT_DEADLINE](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L163) 常量
**删除**：[goalPlanning.ts L620](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts#L620) Presenter prompt 第 4 条 deadline 兜底语义

#### 3.3.3 Task Draft Block 协议改造

**改文件**：[src/lib/server/goalPlanning/taskDraftPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftPrompt.ts)
- 新增上下文：当前 Thread 的 `loopInterval`
- 新增约束：种子 Task 默认 `taskType:one_shot`；**仅当种子 Task 自身频率 ≠ Thread.loopInterval 时**才允许 `repeat`
- prompt 中明确写出"避免与 Thread tick 同频造成双重重复触发"

**改文件**：[src/lib/server/goalPlanning/taskDraftReview.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts) — 已是决策/展示层拆分先例，不改结构，仅更新 prompt 文本与 Topic 上下文一致。

#### 3.3.4 ThreadRunner.tick prompt（新增）

**新文件**：`src/lib/server/thread/threadRunnerPrompt.ts`

```typescript
export function buildThreadRunnerDecisionPrompt(input: {
  topic: Topic;
  thread: Thread;
  recentTaskInstances: TaskInstance[];   // 该 Thread 最近 7 天，由 collect 步骤注入
  threadMemory: Record<string, unknown>;
  lastTickOutput?: ThreadTickOutput;
}): string;
```

**8 条必备约束（写进 system prompt）**：
1. 决策/展示层拆分：仅返回 `{ actions: [...] }` 结构化 JSON，不允许 markdown 解释
2. collect 数据源仅来自 ① Thread memory ② 上次 tick 产出 ③ 最近 7 天 Task instances；明确告诉模型**不接外部源**
3. 输出 3 类动作可叠加：`dispatch_task` / `post_message` / `silent`；仅当无任何 `post_message`/`dispatch_task` 时才 `silent`
4. 判断规则一句话写进 prompt："能在本次 tick 一段话讲完的 → `post_message`；要再起一次完整执行流程的 → `dispatch_task`"
5. `dispatch_task` 默认 `taskType: "one_shot"`
6. `post_message` 同时写会话流 + Inbox（prompt 不需要让模型决定渠道，固定双写）
7. 所有 `dispatch_task` 必须填 `threadId`（绑定当前 Thread）
8. payload ≤ 8KB 硬约束

**Action 输出契约**：

```typescript
type ThreadTickAction =
  | { kind: "dispatch_task"; threadId: string; taskDraft: TaskDraft; reason: string }
  | { kind: "post_message"; threadId: string; text: string; severity: "info" | "warning" | "important" }
  | { kind: "silent"; reason: string };

type ThreadTickOutput = {
  actions: ThreadTickAction[];
  /** 用于下一次 tick 的累积上下文，可写回 Thread.memory */
  memoryDelta?: Record<string, unknown>;
};
```

#### 3.3.5 promptDuplicationGuardSpec 扩展

**改文件**：[src/lib/planning/specs/promptDuplicationGuardSpec.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/planning/specs/promptDuplicationGuardSpec.ts)

新增断言：
- Interviewer / Planner / Critic / Refiner / Presenter 5 个 prompt builder 输出中**禁止**出现 `2026-06-30` / `DEFAULT_DEADLINE` / `participationLevel` / `topicKind` / `quantifiable` 字面量
- ThreadRunner prompt 输出中**必须**包含 8 条必备约束的关键字（用 substring 校验）

---

### 3.4 P2：编排循环升级 + 多 Agent 协作

#### 3.4.1 TopicInitSaga（拆解 Saga）

**新文件**：`src/lib/server/topicSaga/topicInitSaga.ts`

```typescript
export class TopicInitSaga {
  constructor(private deps: { sagaRepo, runRepo, eventRepo, executor, messageBus });

  async start(input: { topicId, userInput, conversationId }): Promise<void>;
  async resume(sagaId: string): Promise<void>;  // 基于 last_event_seq 续接

  // 步骤定义（线性，非并行）
  private async stepInterviewer(...): Promise<InterviewerOutput>;
  private async stepPlanner(...): Promise<PlannerOutput>;
  private async stepCritic(...): Promise<CriticOutput>;        // ⇄ Refiner，最大 3 轮
  private async stepRefiner(...): Promise<PlannerOutput>;
  private async stepPresenter(...): Promise<void>;             // fire-and-forget 展示层
}
```

每一步：
1. 写 `agent_runs.status = "running"` + `saga_instances.current_step`
2. 调 `executor.run(role, prompt, ctx)` → 内部写 `agent_events`
3. 写 `agent_runs.status = "completed"` + 把输出投递给下一步（messageBus）
4. 任一步失败 → `saga_instances.status = "failed"` + 落幂等键防重复

#### 3.4.2 ThreadRunner（运行期 tick）

**新文件**：`src/lib/server/thread/threadRunner.ts`

```typescript
export async function runThreadTick(input: {
  topic: Topic;
  thread: Thread;
  now: Date;
  deps: { taskInstanceRepo, agentRunRepo, eventRepo, executor, threadRepo, conversationRepo, inboxRepo };
}): Promise<{ actions: ThreadTickAction[]; nextTickAt: string }> {
  // 1. collect：拉取 Thread.memory + 上次 tick 输出 + 最近 7 天 Task instances
  // 2. （内部由 prompt 完成 filterRelevance + reasonNextActions）
  // 3. 调用 executor.run("thread_runner", prompt, ctx) → 解析 ThreadTickOutput
  // 4. dispatchActions：
  //    - dispatch_task → 写入 task 表 + runtime_jobs 队列（默认 taskType:one_shot）
  //    - post_message → 同步写 conversation_messages + inbox
  //    - silent → 仅累计 thread.silentCount
  // 5. 计算 nextTickAt = lastTickAt + interval（按 thread.loopInterval）
  // 6. 写回 thread.memory（合并 memoryDelta）+ 累加 silentCount/failureCount
  // 7. failureCount ≥ 5 → 自动 paused
}
```

**首次 tick 时机**（[Topic_拆解需求对齐方案 5.2](file:///Users/bytedance/Documents/trae/long_horizon_agent/.trae/documents/Topic_%E6%8B%86%E8%A7%A3%E9%9C%80%E6%B1%82%E5%AF%B9%E9%BD%90%E6%96%B9%E6%A1%88.md)）：
- 拆解 Saga `Presenter` 完成后，立即 enqueue 一次首跑（`runtime_jobs.kind = "thread_tick"`）
- 后续按 `loopInterval` 由 ThreadLoopWorker 触发

#### 3.4.3 ThreadLoopWorker

**新文件**：`src/lib/server/worker/threadLoopWorker.ts`

```typescript
export async function runThreadLoopWorker(leaseOwner: string): Promise<void> {
  // 1. claimQueuedRuntimeJobs(kind: "thread_tick", limit: 50)
  // 2. renewRuntimeJobLease(30s) 周期续租
  // 3. 调 runThreadTick
  // 4. 完成后 schedule next tick：写 runtime_jobs 一条延时任务（lastTickAt + interval）
  // 5. 异常 → thread.failureCount++；连续 5 次 → status = "paused"
}
```

**改文件**：[src/lib/daemon/daemonRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/daemon/daemonRunner.ts)
- 新增 `runThreadLoopWorker` 与现有 4 个 worker 同级调度（轮询 + lease）

#### 3.4.4 SchedulerEngine 升级

**改文件**：[src/lib/server/worker/goalSchedulerEngine.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalSchedulerEngine.ts) → 重命名为 `topicSchedulerEngine.ts`

- L78–L132 入口扩展：扫所有 `Topic.status = "active"` → 对每个 Thread 检查 `nextTickAt ≤ now` 决定是否 enqueue `thread_tick` job；同时对每个 Thread 的 Task 沿用现有 [taskTriggerTime.ts isTaskTriggerDue](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskTriggerTime.ts#L177) 判定是否 enqueue task job
- 旧 `goalSchedulerEngine.ts` 保留 thin proxy

#### 3.4.5 triggerRule 解析扩展

**改文件**：[src/lib/taskTriggerTime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskTriggerTime.ts)

新增：

```typescript
export type ParsedThreadLoopInterval =
  | { kind: "realtime"; intervalMs: 60_000 }       // 每分钟一次（占位实现，本期不真实启用 realtime）
  | { kind: "hourly"; intervalMs: 3_600_000 }
  | { kind: "daily"; intervalMs: 86_400_000 }
  | { kind: "weekly"; intervalMs: 604_800_000 }
  | { kind: "cron"; expr: string }
  | { kind: "one_shot" };

export function parseThreadLoopInterval(li: ThreadLoopInterval): ParsedThreadLoopInterval;
export function computeNextTickAt(thread: Thread, now: Date): Date | null;
```

#### 3.4.6 通知链路（沿用现有）

[goalNotificationWorker.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalNotificationWorker.ts) + [resultNotificationJudge.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/resultNotificationJudge.ts) **不动**。`post_message` 直接写 `conversation_messages` + `inbox`，不走 `resultNotificationJudge`（仅 Task 完成时才走）。

#### 3.4.7 Provider 重命名

[src/components/providers/GoalSchedulerRuntime.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/GoalSchedulerRuntime.tsx)（已是空壳）→ `SettingsHydrationProvider.tsx`

#### 3.4.8 DevPanel 增加 Agent 调试 Tab

**改文件**：[src/components/layout/DevPanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/layout/DevPanel.tsx)

新增 Tab "Agent Runs"：
- 列出 saga_instances 时间线
- 每条 saga 展开后展示 agent_runs 下的 agent_events 流（JSON 折叠）
- 提供 "Pause / Resume / Cancel" 按钮调 `/api/agents/runs/commands`

---

### 3.5 文件级改动清单（汇总）

#### 新增（共 30 个）

```
src/types/agentRuntime.ts
src/types/topic.ts
src/lib/server/repositories/agentRuntime/agentRunsRepository.ts
src/lib/server/repositories/agentRuntime/agentEventsRepository.ts
src/lib/server/repositories/agentRuntime/agentMessagesRepository.ts
src/lib/server/repositories/agentRuntime/sagaInstancesRepository.ts
src/lib/server/repositories/agentRuntime/agentSnapshotsRepository.ts
src/lib/server/agentRuntime/agentExecutor.ts
src/lib/server/agentRuntime/sagaCoordinator.ts
src/lib/server/agentRuntime/messageBus.ts
src/lib/server/agentRuntime/resumeManager.ts
src/lib/server/agentRuntime/payloadGuard.ts
src/lib/server/agentRuntime/agentExecutor.spec.ts
src/lib/server/agentRuntime/payloadGuard.spec.ts
src/lib/server/agentRuntime/resumeManager.spec.ts
src/lib/server/topicSaga/topicInitSaga.ts
src/lib/server/topicSaga/prompts/interviewerPrompt.ts
src/lib/server/topicSaga/prompts/plannerPrompt.ts
src/lib/server/topicSaga/prompts/criticPrompt.ts
src/lib/server/topicSaga/prompts/refinerPrompt.ts
src/lib/server/topicSaga/prompts/presenterPrompt.ts
src/lib/server/topicPlanning.ts
src/lib/server/thread/threadRunner.ts
src/lib/server/thread/threadRunnerPrompt.ts
src/lib/server/worker/threadLoopWorker.ts
src/lib/server/services/topicCommandService.ts
src/lib/server/services/topicRuntimeService.ts
src/app/api/agents/runs/commands/route.ts
src/app/api/topics/[topicId]/route.ts
src/app/api/topics/[topicId]/commands/route.ts
src/stores/topicStore.ts
```

#### 改动

| 文件 | 改动要点 |
| --- | --- |
| [src/lib/server/db/schema.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/db/schema.ts) | 版本 10→11→12；追加 v11/v12 migration |
| [src/types/kiki.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/kiki.ts) | Task.subGoalId → threadId；SubGoal/Goal 标 deprecated 别名 |
| [src/components/providers/RuntimeEventBridge.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeEventBridge.tsx) | 新增 `agent.*` / `saga.*` / `topic.*` / `thread.*` projection |
| [src/lib/server/worker/goalSchedulerEngine.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalSchedulerEngine.ts) | 改名为 topicSchedulerEngine.ts；扫 Topic + Thread 两层 |
| [src/lib/daemon/daemonRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/daemon/daemonRunner.ts) | 注册 ThreadLoopWorker |
| [src/lib/taskTriggerTime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskTriggerTime.ts) | 新增 `parseThreadLoopInterval` / `computeNextTickAt` |
| [src/lib/server/goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts) | **删除 L163 DEFAULT_DEADLINE**；改为转发到 topicPlanning.ts；删除 L620 第 4 条 deadline 兜底 |
| [src/lib/server/goalPlanning/taskDraftPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftPrompt.ts) | prompt 加 Thread.loopInterval 上下文 + repeat/one_shot 边界 |
| [src/lib/planning/specs/promptDuplicationGuardSpec.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/planning/specs/promptDuplicationGuardSpec.ts) | 加新 prompt 断言 |
| [scripts/run-planning-specs.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/scripts/run-planning-specs.ts) | 注册 3 个新 spec 入口 |
| [src/components/layout/DevPanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/layout/DevPanel.tsx) | 新增 Agent Runs Tab |
| [src/components/providers/GoalSchedulerRuntime.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/GoalSchedulerRuntime.tsx) | 重命名 SettingsHydrationProvider.tsx |
| [src/stores/conversationStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/conversationStore.ts) | goalId → topicId 字段重命名 |

#### 重命名（保留 thin wrapper 1 版本）

| 旧 | 新 |
| --- | --- |
| `src/components/goal/*` (11 文件) | `src/components/topic/*` |
| `src/app/goals/[goalId]/*` (3 文件) | `src/app/topics/[topicId]/*` |
| `src/app/api/goals/*` | `src/app/api/topics/*` |
| `src/lib/server/services/goalCommandService.ts` | `topicCommandService.ts` |
| `src/lib/server/services/goalRuntimeService.ts` | `topicRuntimeService.ts` |
| `src/stores/goalStore.ts` | `topicStore.ts` |
| `src/mocks/goals.ts` | `src/mocks/topics.ts` |

---

## 四、Assumptions & Decisions

| 编号 | 决策 | 来源 |
| --- | --- | --- |
| A1 | `agentRuntime/` 与 `agentOrchestration/` 并列，不合并（前者通用 Saga 基础设施，后者单 Task 多角色协作） | 调研报告 §3.1 + 用户确认 |
| A2 | DB migration 拆为 v11（5 张新表）和 v12（Goal→Topic 重命名）两次提交 | KiKi_改造方案_v1.md 风险控制 |
| A3 | 旧 `/api/goals/*` 路径保留 thin proxy 2 个版本，HTTP 308 redirect | project_memory `[convention]` |
| A4 | Thread tick 是单 prompt 实现（不拆 4 次 LLM 调用） | Topic_拆解需求对齐方案 11.4 |
| A5 | 现有 Task 执行链路（5 角色）**不动**，dispatch_task 派发的 Task 走老链路 | Topic_拆解需求对齐方案 §11.5 |
| A6 | post_message 不走 resultNotificationJudge，直接双写 conversation + inbox | Topic_拆解需求对齐方案 5.4 |
| A7 | silent 输出保持 active；仅 tick 异常累计 failureCount，5 次 paused | Topic_拆解需求对齐方案 5.3 + 6.2 |
| A8 | 测试沿用 `pnpm test:planning` + `run*Specs()` 模式，不引入 vitest | 调研报告 §8 |
| A9 | 删除 `DEFAULT_DEADLINE = "2026-06-30"`；prompt 输出 `null` | Topic_拆解需求对齐方案 11.7 + 用户确认 |
| A10 | Thread.loopInterval 本期不开放运行期编辑，需重新拆解 | Topic_拆解需求对齐方案 7.1 |
| A11 | 手动添加 Task 必须显式选 Thread，禁止孤儿 | Topic_拆解需求对齐方案 7.1 |
| A12 | dispatch_task 永远 `taskType: "one_shot"`；种子 Task 仅在频率 ≠ Thread.loopInterval 时才允许 `repeat` | Topic_拆解需求对齐方案 4.5 |
| A13 | tick 单次输出可叠加多动作；仅完全无动作时用 silent | Topic_拆解需求对齐方案 5.1.1 |
| A14 | Topic 会话 Agent / Topic Coordinator 本期不实现 | Topic_拆解需求对齐方案 §9 |

---

## 五、Verification Steps

### 5.1 P0 验收

- `pnpm test:planning` 全绿（含新增 3 个 spec）
- 手动执行 SQL 检查 5 张新表已存在 + 索引正确
- `kill -9 $(pgrep daemon)` → 重启后 `saga_instances.status="running"` 的实例能从 last_event_seq 继续
- payload > 8KB 的事件自动外置到文件 + `payloadRef` 字段填充

### 5.2 P1 验收

- 老数据迁移 dry-run：snapshot 中没有 `goals[]`，全部变为 `topics[]`
- 旧 `/goals/[id]` 自动 308 跳转 `/topics/[id]`
- `pnpm test:planning` 全绿
- 旧 API 调用打 `Deprecation: true` header

### 5.3 P1.5 验收

- promptDuplicationGuardSpec 通过：所有 prompt 输出**不**含 `2026-06-30` / `DEFAULT_DEADLINE`
- 单元测试：用户输入"持续跟踪 NVDA"（无 deadline）→ Planner 输出 `topic.deadline: null`，不报错
- Critic 单测：用户没给量化目标时不打回为缺陷

### 5.4 P2 验收（端到端冒烟）

1. 创建 Topic："持续跟踪 NVDA 投资机会"（无 deadline）
2. Saga 走完 Interviewer→Planner→Critic→Refiner→Presenter，产出 2-4 条 Thread
3. Presenter 展示卡片用"持续帮你跟踪"措辞，**不**显示截止日期
4. 拆解完成后立即首跑一次 tick；tick 输出 ≥1 条 `dispatch_task` 或 `post_message`
5. ThreadLoopWorker 按 loopInterval 定期重跑
6. DevPanel "Agent Runs" Tab 能看到完整因果链
7. `kill daemon` → 重启后所有 active Thread 继续 tick；正在执行的 Task 续接

---

## 六、风险与回滚

| 风险 | 缓解 |
| --- | --- |
| migration v11/v12 数据丢失 | 自动 `cp prod.db prod.db.backup-$(date +%s)`；dry-run 通过后再真跑；48h 代码冻结期 |
| 旧 `/api/goals/*` 调用方未升级 | 保留 thin proxy 2 个版本 + Deprecation header + 监控日志告警 |
| Thread tick LLM 成本失控 | hourly 上限 1 Topic ≤ 4 Thread；DevPanel 显示 token 消耗 |
| ThreadLoopWorker 死循环 | failureCount ≥ 5 自动 paused；lease 30s 续租 |
| dispatch_task 写入与 Thread 状态机竞态 | 沿用 `goalCommandService` revision + idempotencyKey 模式 |
| prompt 截断 | 沿用 [jsonRepair.ts autoCloseTruncatedJson](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/claude/jsonRepair.ts) 兜底 + 决策层 ≤ 50 行 ≤ 2000 字符硬约束 |

---

## 七、不做项（明确范围）

| 项 | 不做的原因 |
| --- | --- |
| Topic Coordinator 独立角色 | v6 已删除 |
| Topic 会话 Agent | 延后到下一版 |
| EventDispatcher / 跨 Thread 事件订阅 | v5 已删除 |
| 外部 webhook / RSS / 行情流 | 受 capability resolver 未上线限制 |
| Knowledge Pool | P5 |
| Pre-Post Value Gate | P6 |
| Thread.loopInterval 运行期编辑 UI | 下一版补 |
| `runtime_state_snapshots` 之外的额外迁移 | 当前所有数据都聚在 snapshot，无需独立 task 表迁移 |

---

## 八、与现有方案的对齐关系

| 文档 | 关系 |
| --- | --- |
| [Topic_拆解需求对齐方案 v8](file:///Users/bytedance/Documents/trae/long_horizon_agent/.trae/documents/Topic_%E6%8B%86%E8%A7%A3%E9%9C%80%E6%B1%82%E5%AF%B9%E9%BD%90%E6%96%B9%E6%A1%88.md) | 产品行为契约 — 本计划落地的"做什么" |
| [KiKi_改造方案_v1（v2.1）](file:///Users/bytedance/Documents/trae/long_horizon_agent/docs/plans/KiKi_%E6%94%B9%E9%80%A0%E6%96%B9%E6%A1%88_v1.md) | 架构骨架 — 本计划落地的"用什么架构做"（DDL / saga / 阶段划分） |
| 本计划 | 文件级实施清单 — "改哪个文件、按什么顺序、怎么验证" |

---

**实施顺序建议**（提交粒度）：

1. PR1：P0.1 + P0.2（migration v11 + 5 个 repository）
2. PR2：P0.3 + P0.4 + P0.5（agentRuntime/ + 类型 + payloadGuard）
3. PR3：P0.6 + P0.7（API + RuntimeEventBridge + spec）
4. PR4：P1.1（types/topic.ts + kiki.ts deprecated）
5. PR5：P1.2（migration v12 + 数据迁移 dry-run 脚本）
6. PR6：P1.3 + P1.4（命令服务 + Stores 重命名 + thin wrapper）
7. PR7：P1.5 + P1.6（API 路由 + 页面重命名）
8. PR8：P1.7（组件目录重命名）
9. PR9：P1.5（Prompt 适配 — 5 角色 prompt）
10. PR10：P1.5（topicPlanning.ts + 删除 DEFAULT_DEADLINE）
11. PR11：P2.1（TopicInitSaga）
12. PR12：P2.2 + P2.3（ThreadRunner + ThreadLoopWorker）
13. PR13：P2.4 + P2.5（SchedulerEngine 升级 + triggerRule 解析）
14. PR14：P2.6 + P2.7 + P2.8（DevPanel + Provider 重命名）

> 每个 PR 必须单独通过 `pnpm test:planning`，PR11 起需要附端到端冒烟视频。

---

## 九、v1 自检补丁（v1.1 增量修订）

> 本节是对 v1 主体的逻辑一致性自检结果。**v1 主体是基线**，本节是必须额外执行的修订点；二者冲突时**以本节为准**。

### 9.1 数据契约闭环（Critical）

**问题 1：`runtime_jobs` 当前没有 thread 维度**

[src/lib/server/db/schema.ts L9–L35](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/db/schema.ts#L9-L35) 现有列：`task_instance_id / task_id / goal_id / conversation_id`。新增 `thread_tick` job 时，没有列承载 `thread_id`，scheduler 也没法按 Thread 索引去重。

**修订**：v11 migration **同时扩展 runtime_jobs**：

```sql
ALTER TABLE runtime_jobs ADD COLUMN topic_id TEXT;
ALTER TABLE runtime_jobs ADD COLUMN thread_id TEXT;
ALTER TABLE runtime_jobs ADD COLUMN saga_instance_id TEXT;
CREATE INDEX IF NOT EXISTS idx_runtime_jobs_thread ON runtime_jobs(thread_id, status);
```

并在 v12 中把 `goal_id` 改为 `topic_id` 的别名读取（保留 `goal_id` 列 1 个版本作为镜像）。

**问题 2：runtime_jobs.kind 必须新增枚举值**

[runtimeJobsRepository.ts L255](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/repositories/runtimeJobsRepository.ts#L255) 当前只有 `"goal_task"`。

**修订**：扩展 `kind` 字符串字面量联合：`"goal_task" | "thread_tick" | "topic_init_saga"`；在 [src/types/runtime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/runtime.ts) 集中定义；同步改 `runtimeJobsRepository.claimQueuedRuntimeJobs` 接受 `kind` 过滤参数（防止 ThreadLoopWorker 抢 goal_task）。

**问题 3：`agent_runs` 缺 `thread_id` 索引但有列名 — schema 一致性**

v1 已写 `thread_id TEXT` 列，但**漏建索引**；ThreadRunner.tick 启动时要按 thread_id 反查最近 run。

**修订**：

```sql
CREATE INDEX agent_runs_thread_idx ON agent_runs(thread_id, started_at DESC);
```

**问题 4：`saga_instances` 缺幂等键**

v1 schema 没有 `idempotency_key`，但 `topicInitSaga.start` 必须用幂等键防"用户连点 2 次"导致双 Saga。

**修订**：

```sql
ALTER TABLE saga_instances ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX saga_instances_idem_unique ON saga_instances(idempotency_key) WHERE idempotency_key IS NOT NULL;
```

**问题 5：`agent_events.payload_ref` 路径未定义**

v1 仅写"超限走外部文件"，没说存哪。

**修订**：在 `payloadGuard.ts` 明确 `payload_ref` 格式为相对路径 `agent-payloads/${agent_run_id}/${seq}.json`，物理根目录沿用 [src/lib/server/storage/](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/storage/) 现有 artifact 存储根；新增清理策略：`agent_runs.status="failed"` 7 天后或 `completed` 30 天后批量清除引用文件（recoveryWorker 加任务）。

### 9.2 Saga 状态机缺口（High）

**问题 6：Interviewer 步骤的"awaiting_user"状态未在 SagaStatus 中体现完整流程**

v1 `SagaStatus` 含 `awaiting_user`，但 `topicInitSaga.start` 步骤定义里没说 Interviewer 多轮追问怎么挂起/恢复。

**修订**：

- `stepInterviewer` 返回类型扩展为 `{ kind: "complete"; output } | { kind: "needs_user_input"; questions: string[] }`
- `kind === "needs_user_input"` 时：写 `saga_instances.status = "awaiting_user"`、`current_step = "interviewer"`，并写一条 agent_event `type:"awaiting_user"` 触发 UI 提问卡片
- 用户回答后通过 `/api/agents/runs/commands { kind: "resume", input: {...} }` 续接，executor 在续接事件中读 `last_event_seq` + 用户输入继续

**问题 7：Critic ⇄ Refiner 死循环兜底**

v1 写"最大 3 轮"但没有失败兜底语义。

**修订**：3 轮后仍有红线问题 → `saga_instances.status = "failed"`；3 轮后只剩黄线问题 → 强制接受最后一版 Planner 输出，写 agent_event `type:"forced_accept"`，Presenter 卡片中提示"此方案存在 N 项次要风险待人工复核"。

**问题 8：Presenter fire-and-forget 失败时主链路状态**

v1 沿用 [taskDraftReview.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning/taskDraftReview.ts) 模式，但没明确：Presenter 异步失败 ≠ Saga 失败。

**修订**：`stepPresenter` 内部 try/catch 不冒泡；失败时 saga 仍标 `completed`，但写 `agent_event type:"presentation_failed"`，UI 降级显示纯结构化数据（沿用现有 jsonRepair 兜底）。

### 9.3 ThreadRunner 调度细节（High）

**问题 9：首次 tick 时机的精确触发点**

v1 §3.4.2 写"Presenter 完成后立即 enqueue"，但 Presenter 是 fire-and-forget 异步，可能比 Saga 主链路晚完成。

**修订**：首跑 enqueue 由 **`stepRefiner` 完成后 / Presenter 启动前**触发（即 Saga 主链路认定方案已固化时），而非等 Presenter；这样即使 Presenter 异步失败也不影响 ThreadLoopWorker 启动。

**问题 10：Thread 内并发 tick 防重**

v1 没说同一个 Thread 已有 `runtime_jobs.kind="thread_tick" status IN ("queued","leased")` 时是否还能再 enqueue。

**修订**：scheduler enqueue 前先 `SELECT 1 FROM runtime_jobs WHERE thread_id=? AND kind="thread_tick" AND status IN ('queued','leased') LIMIT 1`，存在则跳过；防止 hourly Thread 因 worker 抢占慢导致堆积。

**问题 11：computeNextTickAt 边界 — `realtime` / `one_shot` / `cron`**

v1 给了 `parseThreadLoopInterval` 但没说 `one_shot`、`cron`、`realtime` 的边界规则。

**修订**：

- `one_shot`：首跑后 `nextTickAt = null`，Thread 自动转 `archived`
- `realtime`：本期降级为 `intervalMs = 60_000`（占位），并在 prompt 注释和 UI 提示"暂未真实启用"
- `cron`：本期**不**实现，传入时 `parseThreadLoopInterval` 抛错；UI 表单暂时禁用 cron 选项

**问题 12：`silentCount` / `failureCount` 阈值与 paused 触发的对齐**

v1 §3.4.3 写"failureCount ≥ 5 → paused"，但 project_memory 约定的"silent 自适应阈值（hourly 24 次/7 天，daily 7 次/30 天）"没落到代码层。

**修订**：

- `failureCount ≥ 5`（连续 tick 异常）→ Thread.status = `paused`，写一条 inbox 告警
- `silentCount` 不影响 status，但触发**自适应告警**：在 ThreadLoopWorker 每次 tick 后检查 `silentCount` 是否超过阈值表（hourly: 24×7=168 / daily: 7×4=28 / weekly: 4 / one_shot: 不适用），超过时写一条 inbox 提示"是否继续保留此 Thread"，**不**自动 paused

### 9.4 类型与兼容层（Medium）

**问题 13：`SubGoal → Thread` 别名字段不兼容**

v1 §3.2.1 说 `SubGoal` 标 deprecated 别名指向 `Thread`，但 `SubGoal` 现有字段 `successCriteria[]` / `tasks[]` 在新 `Thread` 上不存在 — 旧代码 `subGoal.successCriteria` 访问会报错。

**修订**：`SubGoal` 不能直接 type alias 为 `Thread`；改为：

- 保留 `SubGoal` 旧 type 定义 1 个版本（不动结构）
- 新增 `legacySubGoalToThread(sub: SubGoal): Thread` 工具函数
- 新代码不再 import `SubGoal`，老 import 通过 ESLint 规则告警 1 版本后删除

`Goal → Topic` 同理：`Goal.subGoals[]` 与 `Topic.threads[]` 字段不同，**不能** type alias，必须显式转换函数 `legacyGoalToTopic(goal: Goal): Topic`。

**问题 14：旧 `goal_id` 字段在 runtime_jobs / inbox / conversation_messages 中的清理时机**

20 个文件含 `goalId` 引用（见上文 Grep），全部 1 个版本内迁移到 `topicId` 风险大。

**修订**：分两批：

- **批 1（P1 范围）**：服务层、API 层、stores（已在 v1 §3.2.3-3.2.5 覆盖）
- **批 2（P1 后置补丁）**：UI 组件 + inbox 引用 + history 页面，作为 PR15（独立 PR），不阻塞 P1 release

**问题 15：`/api/goals/*` thin proxy 实现细节**

v1 说"HTTP 308 redirect"，但实际 Next.js App Router 的 `route.ts` 用 `redirect()` 会丢失 POST body。

**修订**：thin proxy 改为**内部转发**而非 redirect — 在旧 route 文件里直接调用新 handler 的导出函数，附加 `Deprecation: true` + `Sunset: <2 versions later>` header；GET 可保留 308 redirect，POST/PATCH/DELETE 必须内部转发。

### 9.5 Prompt 与决策契约（Medium）

**问题 16：`taskDraftReview.ts` 决策/展示拆分先例的确切沿用方式**

v1 §3.3.4 ThreadRunner 写"决策/展示层拆分"，但 ThreadRunner 单 tick 输出主要是 actions，不是长解释，是否真需要展示层？

**修订**：明确 ThreadRunner **只有决策层 prompt**，不强制拆展示层。理由：tick 输出 ≤ 8KB，actions 内的 `text`（post_message 文本）已经是给用户看的文案，由模型直接产出即可；只在 `post_message.text` 长度 > 500 字时，触发后置 `presentationPrompt` 异步润色（与 P2 的 message 推送解耦）。补丁更新 §3.3.4 第 1 条约束改为"返回 `{ actions }` 单 JSON，单条 post_message.text ≤ 500 字"。

**问题 17：Critic prompt 必须显式禁止"deadline 缺失即缺陷"**

v1 §3.3.1 第 4 条提到"不把无 deadline 判为缺陷"，但 `criticPrompt.ts` builder 必须在系统提示首段就写明，否则模型容易因训练数据偏置仍把它列为风险。

**修订**：补 §3.3.1 表格下方一条"Critic prompt 系统首段必须显式包含：'Topic.deadline 为可选属性，缺失不构成方案缺陷'"。

**问题 18：promptDuplicationGuardSpec 误杀风险**

v1 §3.3.5 禁止 prompt 中出现 `2026-06-30`，但调研数据/示例中可能合法包含此日期串。

**修订**：断言改为对**正则** `/DEFAULT_DEADLINE|FALLBACK_DEADLINE|"deadline"\s*:\s*"2026/`，避免误杀业务数据中的日期字符串。

### 9.6 测试与回归（Medium）

**问题 19：v11 / v12 migration 缺往返测试**

v1 §3.1.1 仅说 dry-run，没有 spec 防回归。

**修订**：新增 `src/lib/server/db/schema.spec.ts`：

- 用 `:memory:` SQLite 跑 v10→v11→v12 完整链
- 断言每步的 `KIKI_DB_SCHEMA_VERSION` 与表/列存在
- 注册到 `scripts/run-planning-specs.ts`

**问题 20：daemon 重启续接的 spec 缺失**

v1 §3.1.4 写了 `resumeManager.ts` 但 §5.1 的"kill -9 daemon"只是手测。

**修订**：`resumeManager.spec.ts` 必须包含三种场景：

- saga `running` + agent_run `running` + 末尾 event 是 `llm.request`（无 response）→ 续接重发
- saga `awaiting_user` → 续接保持 `awaiting_user`，等用户 resume 命令
- saga `running` + 末尾 event 是 `dispatch` → 续接跳过已派发，直接进入下一步

### 9.7 文件级清单增补

新增（在 v1 §3.5 基础上追加）：

```
src/lib/server/db/schema.spec.ts                       # 9.6 问题 19
src/lib/migration/legacyGoalToTopic.ts                 # 9.4 问题 13
src/lib/migration/legacySubGoalToThread.ts             # 9.4 问题 13
src/lib/migration/legacyGoalToTopic.spec.ts
```

改动（在 v1 §3.5 基础上追加）：

| 文件 | 改动要点 |
| --- | --- |
| [src/lib/server/repositories/runtimeJobsRepository.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/repositories/runtimeJobsRepository.ts) | `kind` 联合扩展 + `claimQueuedRuntimeJobs` 加 `kind` 过滤 + 新 `topic_id/thread_id/saga_instance_id` 列读写 |
| [src/types/runtime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/runtime.ts) | `RuntimeJobKind` 字面量集中定义 |

### 9.8 PR 序列调整

在 v1 14 个 PR 基础上：

- **PR1 拆分为 PR1a（v11 schema + runtime_jobs 列扩展）+ PR1b（5 个 agentRuntime repository）**：原 PR1 太大
- **新增 PR15（goalId → topicId UI/inbox/history 后置批量清理）**：不阻塞 P1 release

### 9.9 验收补充

在 v1 §5 基础上追加：

- **5.1 P0 验收追加**：runtime_jobs 新列 + 索引存在；schema.spec 全绿；payload 外置文件命名符合 `agent-payloads/${runId}/${seq}.json`
- **5.4 P2 验收追加**：构造"hourly Thread 故意 LLM 异常"场景，验证 5 次失败后 status = paused 且 inbox 告警；构造"daily Thread 28 天无 dispatch"场景，验证只告警不 paused
- **5.4 端到端冒烟追加**：Interviewer needs_user_input → 用户回答 → resume → 流程继续；Critic 3 轮后强制接受 → Presenter 卡片显示"次要风险待复核"

---

**v1.1 自检结论**：v1 在阶段划分、文件清单、Prompt 约束层面已经 decision-complete，但在数据契约（runtime_jobs 缺 thread 维度 / saga 缺幂等键 / payload_ref 路径未定义）、状态机缺口（awaiting_user 续接 / Critic 死循环兜底 / Presenter 异步失败）、兼容层细节（type alias 不能直接做 / 308 redirect 丢 POST body）三类共 20 个点存在遗漏，已在 §9 中逐项补完。**实施时以 v1 主体 + §9 修订为最终基线。**

---

## 十、v1.2 二次自检（基于 §9 之上的再次复核）

> 在 §9 完成后，重新对 v1 主体 + §9 修订做一次穿透式复核，识别出 7 个未覆盖的逻辑缺口与隐患。**最终基线 = v1 主体 + §9 + §10**；三者冲突时以 §10 为准。

### 10.1 KIKI_DB_BOOTSTRAP_SQL 与 schema_version=11 不一致（Critical）

**问题 21**：[src/lib/server/db/schema.ts L1](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/db/schema.ts#L1) 已把 `KIKI_DB_SCHEMA_VERSION` 提到 11，但 `KIKI_DB_BOOTSTRAP_SQL`（L3–L42 范围内的 `runtime_jobs`）仍是 v10 内容，没有 `topic_id / thread_id / saga_instance_id` 列，也没有 5 张新表。新建库走 `client.ts bootstrap()` → exec(BOOTSTRAP_SQL) 后，meta.schema_version 为空（视作 0），随后 runMigrations 必须跑 0→11 全链才会补全；但若任何 migration 在新建库上幂等性不足（例如缺 `IF NOT EXISTS`），新建库与升级库行为会分裂。

**修订**：

- v11 migration 中所有 DDL **强制使用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN`**（ALTER 无法 IF NOT EXISTS，需要 `PRAGMA table_info` 预检后跳过）
- 在 `schema.spec.ts`（§9.6 问题 19 已规划）增一个用例：用 `:memory:` 跑两条路径并断言最终 schema 完全等价
  - 路径 A：BOOTSTRAP_SQL → runMigrations(0→11)
  - 路径 B：仅 runMigrations(0→11)（不跑 BOOTSTRAP_SQL）
- 后续 v12 migration 如果再次扩列，仍按相同模式

### 10.2 ALTER TABLE ADD COLUMN 在 SQLite 上的幂等性（Critical）

**问题 22**：§9.1 问题 1 给的 SQL `ALTER TABLE runtime_jobs ADD COLUMN topic_id TEXT;` 在 SQLite 上**没有 IF NOT EXISTS 语法**；如果 migration 因任何原因被重跑（如 dry-run 阶段误用同一 DB），会抛 `duplicate column name`。

**修订**：在 v11 migration 内统一用 helper：

```typescript
function addColumnIfMissing(db: Database, table: string, column: string, ddl: string) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c: any) => c.name === column);
  if (!exists) db.exec(ddl);
}
addColumnIfMissing(db, "runtime_jobs", "topic_id", "ALTER TABLE runtime_jobs ADD COLUMN topic_id TEXT");
addColumnIfMissing(db, "runtime_jobs", "thread_id", "ALTER TABLE runtime_jobs ADD COLUMN thread_id TEXT");
addColumnIfMissing(db, "runtime_jobs", "saga_instance_id", "ALTER TABLE runtime_jobs ADD COLUMN saga_instance_id TEXT");
```

`schema.spec.ts` 必须额外断言"对同一 :memory: DB 重跑 v11 migration 不抛异常"（重入安全）。

### 10.3 BOOTSTRAP_SQL 必须与最终 schema 同步演进（High）

**问题 23**：§9 仅说"扩展 runtime_jobs / 新增 5 张表"走 v11 migration，但漏了一个工程约定：`KIKI_DB_BOOTSTRAP_SQL` 长期看必须代表"最新基线"，否则新装机走完 BOOTSTRAP_SQL 仍要跑全部历史 migration，越积越长且有不一致风险。

**修订**：本期约定如下（写入 [docs/plans/KiKi_改造方案_v1.md](file:///Users/bytedance/Documents/trae/long_horizon_agent/docs/plans/KiKi_%E6%94%B9%E9%80%A0%E6%96%B9%E6%A1%88_v1.md) 工程约定章节作为补丁）：

- v11 / v12 实施合并后，**同步更新** BOOTSTRAP_SQL 反映 v12 后的状态（含 5 张新表 + runtime_jobs 全列 + 索引）
- 但每个版本在 commit 时仍**先**仅改 migration，CR 通过后再单独提一个"BOOTSTRAP_SQL 同步"的 PR（可在 PR15 之前作为 PR14.5 提交，避免合并冲突）
- 该约定列入 PR1a 的 Definition of Done：要求作者明确提及"BOOTSTRAP_SQL 同步将随 PR14.5 一并提交"

### 10.4 runtime_jobs 旧 `goal_id` 字段在 P1 后的语义（High）

**问题 24**：§9.4 问题 14 把 `goalId` 清理拆为 P1 内（服务/API/store）+ PR15（UI/inbox/history）两批，但**漏了 runtime_jobs.goal_id 列本身的处理**。schema.ts L13 现有 `goal_id TEXT`，§9.1 问题 1 又新增 `topic_id TEXT`，两者同时存在期：

- 写路径：新代码应写 `topic_id`，但旧 `goal_task` 的 worker 链路仍读 `goal_id`
- 读路径：scheduler 既要按 `topic_id` 取新任务，又要按 `goal_id` 取老任务

**修订**：

- v11 migration 不删 `goal_id` 列（保留 1 个版本）
- v11 migration 追加 `UPDATE runtime_jobs SET topic_id = goal_id WHERE topic_id IS NULL AND goal_id IS NOT NULL`（一次性回填）
- 写新 job 时**双写** `topic_id` 与 `goal_id`（goal_id = topic_id），1 个版本后在 v12 删除 goal_id 列
- runtimeJobsRepository 的 `RuntimeJobRecord` 类型在本期保留 `goalId?` 字段，但所有新读路径优先读 `topicId`

### 10.5 stateSnapshot.ts `goals` key 与 `topics` key 共存期（High）

**问题 25**：[src/lib/server/runtime/stateSnapshot.ts L8](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtime/stateSnapshot.ts#L8) 定义 `SnapshotKey = "goals" | "runtimeEnvironments" | "scheduleEvents"`。§9 / v1 §3.2.2 说在 v12 物理迁移时把 `goals[]` 的内容 **就地** 改写为 Topic/Thread 形态，但 **key 名仍叫 `"goals"`**，会导致服务层既要读 `goals` key 又要按新结构解析，语义不清。

**修订**：

- v12 migration 同时把 `runtime_state_snapshots` 中 `key="goals"` 的行复制为 `key="topics"`，**保留** `key="goals"` 行 1 个版本（双写期）
- `stateSnapshot.ts` 的 `SnapshotKey` 联合扩展为 `"goals" | "topics" | "runtimeEnvironments" | "scheduleEvents"`
- 新代码全部读写 `"topics"`；老代码读 `"goals"` 作为兜底
- v12 上线 1 版本后再发一个 PR（PR16）删除 `"goals"` 行 + 从 `SnapshotKey` 中移除字面量

注：[src/lib/server/runtime/stateSnapshot.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtime/stateSnapshot.ts) 当前包装层是基于 envelope `{ value, revision, updatedAt }`，写法上 `topics` 完全可以独立 envelope，不影响乐观锁。

### 10.6 RuntimeEventBridge 投影分支扩展遗漏（Medium）

**问题 26**：[RuntimeEventBridge.tsx L154–L167](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/providers/RuntimeEventBridge.tsx#L154-L167) 现有 switch 已枚举状态字面量（pending/in_progress/completed/awaiting_user/paused/error/queued/running/failed/cancelled），都对应 Task/Job 状态。§9 的 RuntimeEventBridge 扩展（v1 §3.1.6）只描述新事件 projection 名（`agent.run.*` / `saga.step.advanced`），没说**新事件类型如何在现有 reducer 里被识别**。

**修订**：

- v1 §3.1.6 的"扩展事件 projection"明确为：在 RuntimeEventBridge 现有 `eventStreamReducer`（实际命名以代码为准，本期 PR3 内确定）中增加新分支：
  - `case "agent.run.started" | "agent.run.event" | "agent.run.completed":` → 转交给 `agentRunsStore.applyEvent`
  - `case "saga.step.advanced":` → 转交给 `sagaInstancesStore.advance`
  - `case "topic.created" | "topic.updated":` → 转交 `topicStore`
  - `case "thread.tick.started" | "thread.tick.completed":` → 转交 `threadStore`
- 新增两个 store：`src/stores/agentRunsStore.ts`、`src/stores/sagaInstancesStore.ts`（追加到 §3.5 新增清单）
- 老的 Task 状态分支保持不变；不破坏 default fallthrough

### 10.7 5 角色命名与现有 agentOrchestration AgentRole 冲突（Medium）

**问题 27**：[src/types/agentOrchestration.ts L1](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/agentOrchestration.ts#L1) 现有 `AgentRole = "coordinator" | "researcher" | "executor" | "reviewer" | "synthesizer"`，是单 Task 内多角色协作用的。新拆解 Saga 的 5 角色（interviewer/planner/critic/refiner/presenter）+ ThreadRunner 的 1 角色（thread_runner）类型集中在 [src/types/agentRuntime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/agentRuntime.ts) 的 `AgentRunRole`，**字面量集合互不重叠但同名概念分裂**，DevPanel 渲染时容易混。

**修订**：

- 不合并两套角色枚举（A1 决策不变）
- 但在 DevPanel "Agent Runs" Tab 显示时，**强制按命名空间前缀分组**：
  - `topic_saga::interviewer` / `topic_saga::planner` / ...
  - `thread::thread_runner`
  - `task_orchestration::coordinator` / `task_orchestration::researcher` / ...
- 该前缀仅在 UI 展示层加，不进 DB 字段
- v1 §3.4.8（DevPanel）补充该规则；agentExecutor 新增工具函数 `formatRoleDisplay(scope, role)`，集中渲染

### 10.8 文件级清单增补（基于 §10）

新增（在 v1 §3.5 + §9.7 基础上追加）：

```
src/stores/agentRunsStore.ts                  # 10.6 问题 26
src/stores/sagaInstancesStore.ts              # 10.6 问题 26
```

改动（在 v1 §3.5 + §9.7 基础上追加）：

| 文件 | 改动要点 |
| --- | --- |
| [src/lib/server/runtime/stateSnapshot.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtime/stateSnapshot.ts) | `SnapshotKey` 联合扩展 + 双写期兜底 |
| [src/lib/server/db/schema.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/db/schema.ts) | v11 migration 补 `addColumnIfMissing` helper + UPDATE 回填 + 重入安全断言 |

### 10.9 PR 序列调整（基于 §10）

在 §9.8 的基础上：

- **新增 PR14.5**：BOOTSTRAP_SQL 与 v12 后状态同步（在 PR14 完成、P1+P2 全绿后单独提）
- **新增 PR16**：移除 `"goals"` snapshot key 与 `goal_id` runtime_jobs 列（本期不上线，仅留计划）
- **PR1a 范围加 1 项**：实现 `addColumnIfMissing` + v11 migration 重入安全 + UPDATE 回填 goal_id→topic_id

### 10.10 验收补充（基于 §10）

- **5.1 P0 验收追加**：
  - 重跑 v11 migration 不抛 `duplicate column name`
  - 路径 A 与路径 B 的 schema 完全等价（PRAGMA table_info diff 为空）
  - 老 runtime_jobs.goal_id 已被回填到 topic_id 列
- **5.2 P1 验收追加**：
  - `runtime_state_snapshots` 同时存在 `goals` 与 `topics` 两条 key，内容等价
- **5.4 P2 验收追加**：
  - DevPanel "Agent Runs" Tab 渲染按 `topic_saga::*` / `thread::*` / `task_orchestration::*` 三组展示，无角色冲突

---

**v1.2 二次自检结论**：在 §9 完成后，本轮重点核查"BOOTSTRAP 与 migration 一致性、ALTER 重入安全、双写期兜底、事件投影扩展、角色命名空间"5 类共 7 个点；这些是 §9 关注"功能完备性"之外的"演进/重入/共存期"细节。**最终实施基线 = v1 主体 + §9 + §10；三者冲突时以 §10 为准。**

实施时建议在 PR1a 完成代码（schema 已改到 v11、5 个 repository 已创建）后，立即追加 §10.2 的 `addColumnIfMissing` helper 与 §10.4 的 `UPDATE goal_id→topic_id` 语句到 v11 migration（影响范围最小、风险最低）；其他 §10 修订项分散到对应 PR 中。

---

## 十一、实施进度交接（2026-05-31 末态快照）

> 本节用于**跨会话交接**：记录当前已落地范围、已知 TODO 列表与下一步入口。
> 后续会话恢复时只需先读本节即可对齐当前坐标，不必从 §三重新阅读全部 PR 列表。
>
> **基线**：v1 主体 + §9 + §10（三者冲突时以 §10 为准）
> **当前 commit 状态**：已通过 `pnpm exec tsc --noEmit` + `pnpm test:planning`

### 11.1 已完成的 PR

| PR | 范围 | 状态 | 关键产物 |
|---|---|---|---|
| PR1a | Schema v11 + addColumnIfMissing helper + goal_id→topic_id 回填 | ✅ | `src/lib/server/db/schema.ts` v11 |
| PR1b | 5 个 agentRuntime repositories（runs / events / messages / snapshots / saga_instances） | ✅ | `src/lib/server/repositories/agentRuntime/*` |
| PR2 | 双写 GoalRepository / TopicRepository | ✅ | stateSnapshot `topics` / `goals` 双 envelope |
| PR3 | agentRunCommandService（pause/resume/cancel/retry + revision 乐观锁 + 幂等扫描）+ event 投影 store | ✅ | `agentRunsStore` / `sagaInstancesStore` |
| PR4 | Topic / Thread 类型 + 旧版 kiki.ts 适配器 | ✅ | `src/types/topic.ts` |
| PR5 | RuntimeEventBridge + GoalEventKind 扩展（topic.* / thread.tick.*） | ✅ | `src/components/RuntimeEventBridge.tsx` |
| PR6 | TopicCommandService 映射层 | ✅ | `src/lib/server/services/topicCommandService.ts` |
| PR7 | TopicStore alias + API 薄代理 | ✅ | `src/mocks/topics.ts` |
| PR8 | UI thin wrapper：components/topic + app/topics 4 个 redirect 页 | ✅ | encodeURIComponent / searchParams 数组分支已修 |
| PR9a | 删除 DEFAULT_DEADLINE 兜底（§9.5 问题 18） | ✅ | normalizeDeadline 签名改为 string⇒string\|undefined |
| PR9b | 5 角色 prompt 锚点拆分（agents/*） | ✅ | `goalPlanning/agents/{interviewer,planner,critic,refiner,presenter}Prompt.ts` |
| PR9c | claudeJsonInvoke + topicInitSaga + 5 场景 spec | ✅ | `claudeJsonInvoke.ts` / `topicInitSaga.ts` |
| PR9d | promptDuplicationGuardSpec 扩展（5 角色 + ThreadRunner 13 关键字 + 5 禁止字面量） | ✅ | `promptDuplicationGuardSpec.ts` |
| PR10 | topicPlanning.ts thin wrapper（5 函数 + 4 type alias） | ✅ | `src/lib/server/topicPlanning.ts` |

### 11.2 §3.3.4 + §3.4.2/3/4/5 已落地的"纯函数层"

> 这些不是独立 PR，而是 PR12/PR13 的子组件。**全部为纯函数 / 依赖注入**，不接 IO；
> PR14 接入仓库层时只需把仓库方法绑成 callback 即可。

| 组件 | 文件 | 职责 |
|---|---|---|
| ThreadRunner prompt | `src/lib/server/thread/threadRunnerPrompt.ts` | 单 prompt 决策层 + 8 条必备约束 |
| ThreadTickOutput schema | `src/lib/server/thread/threadTickOutputSchema.ts` | 11 个 error code 校验 §3.3.4 全部约束 |
| ThreadRunner 编排核心 | `src/lib/server/thread/threadRunner.ts` | runThreadTick：prompt → invoke → parse → patch |
| dispatchActions 派发器 | `src/lib/server/thread/dispatchActions.ts` | dispatch_task → post_message → silent，taskType 强制 one_shot |
| ThreadLoopScheduler 选择器 | `src/lib/server/thread/threadLoopScheduler.ts` | selectDueThreads / isThreadDue 纯函数 |
| ThreadLoopWorker frame 编排 | `src/lib/server/thread/threadLoopWorker.ts` | runThreadLoopFrame：collect→select→tick→dispatch→persist→record |
| Thread loopInterval 解析 | `src/lib/taskTriggerTime.ts` L235-L316 | parseThreadLoopInterval / computeNextTickAt |

每个组件都有同名 `*.spec.ts`，已注册到 `scripts/run-planning-specs.ts`。

### 11.3 待完成 PR / 模块清单

> 下一会话从这里继续。**所有"纯函数 / pure logic"层已就位**；剩余工作 = "接线 + 守护进程 + UI"。

#### PR11：TopicInitSaga 接入命令路由（独立 PR，无依赖）

- 在 `topicCommandService` 创建 Topic 命令路径中，把 `generateTopicPlanWithClaude`（当前 wrapper）替换为 `runTopicInitSaga`：
  - 注入 5 个 `LlmInvoke`：interviewer/planner/critic/refiner/presenter（用 `createClaudeJsonInvoke` 工厂）
  - prompts 走 `goalPlanning/agents/*` 锚点
  - sagaInstanceId 由 `createSagaInstance({ topicId, type: "topic_init" })` 提供
  - awaiting_user 状态需对接前端轮询/SSE（通过 `agentRunsStore` 已有投影）
- 旧 `goalPlanning.generateGoalPlanWithClaude` 转 thin wrapper 转发到 `topicPlanning.ts` 后再到 `runTopicInitSaga`
- DoD：创建一个新 Topic 能完整跑完 5 角色 saga，并在 DevPanel（PR15）/`agent_events` 中可见 5 段轨迹

#### PR12 收尾：仓库层接入（依赖 PR14 仓库实现）

- 不立 PR12 独立 wire，而是与 PR14 一起完成（仓库刚建好就 wire 进 dispatchActions / threadLoopWorker）

#### PR13 守护进程外壳：ThreadLoopWorker daemon

- 新建 `src/lib/server/scheduler/threadLoopDaemon.ts`：
  - `setInterval(60_000)` 调 `runThreadLoopFrame(now=new Date())`
  - cron loopInterval 通过 `cron-parser`（已在依赖中？需检查）二次过滤 `cron_passthrough` 候选
  - 与现有 `goalSchedulerEngine` 共存：建议在 `src/app/api/runtime/start/route.ts` 或等价 bootstrap 处一起拉起
  - 提供 stop / restart 入口，便于测试
- DoD：Active topic 下创建 daily Thread → 等待一帧（注入虚拟时钟）→ 看到 dispatch_task / post_message 在数据库出现

#### PR14：仓库层落地 + 全链路 wire

> **当前最大的单元**。需要新建 5 个仓库 + wire 4 个 callback。

##### 14.1 新增仓库

| 仓库 | 表 / 数据源 | 关键方法 |
|---|---|---|
| `threadsRepository.ts` | 当前 stateSnapshot 嵌在 `topics` envelope；建议**新建独立 `threads` 表**（v12 扩 + addColumnIfMissing），或用 envelope 内嵌路径访问 | `findById` / `update(patch, baseRevision)` / `listByTopicStatus("active")` / `markPaused` |
| `taskInstancesRepository.listRecentByThreadId` | 现有 `task_instances` 表 | `(threadId, limit=12, sinceDays=7) => TaskInstance[]` |
| `inboxRepository.append` 或复用 | 现有 inbox 数据源 | `append({ topicId, threadId, text, severity })` |
| `conversationMessagesRepository.appendThreadMessage` | 现有 conversation_messages | `(topicId, threadId, text, severity) => { conversationMessageId }` |
| `dispatchTask` 服务方法 | 现有 task command service | 接受 `DispatchTaskRequest`（已定义在 dispatchActions.ts），返回 `{ taskId, instanceId? }` |

##### 14.2 wire 点

- 在 PR13 daemon 中：
  - `collectActiveThreads` ⇒ 读 `topics` envelope filter 出 active topic + active thread
  - `collectRecentTaskInstances` ⇒ `taskInstancesRepository.listRecentByThreadId`
  - `prepareAgentRun` ⇒ `createAgentRun({ topicId, threadId, role: "thread_runner", idempotencyKey: \`thread-tick-\${threadId}-\${now.toISOString()}\` })`
  - `persistThreadPatch` ⇒ `threadsRepository.update(patch, baseRevision=thread.revision)`
  - `recordTickOutcome` ⇒ `appendAgentEvent` 写 `thread.tick.output` / `thread.tick.dispatch_partial_failure` / `thread.tick.failed`
  - `dispatchTask` ⇒ 调 task command service
  - `sendThreadMessage` ⇒ 双写 `conversationMessagesRepository` + `inboxRepository`

##### 14.3 §3.4.5 调度器升级

- 复用 `parseThreadLoopInterval` + `computeNextTickAt`
- 现有 `goalSchedulerEngine` 不动；ThreadLoopWorker daemon 与之并存独立 tick

#### PR14.5：BOOTSTRAP_SQL 同步

- `KIKI_DB_BOOTSTRAP_SQL`（在 schema.ts）补齐到 v12 终态：
  - topics / threads / agent_runs / agent_events / agent_messages / agent_snapshots / saga_instances 全部 CREATE TABLE
  - runtime_jobs.topic_id 列
  - runtime_state_snapshots `"topics"` envelope key
- DoD：删除本地 DB 文件后 `pnpm dev` 启动能跑通端到端，无需依赖 migration 累计应用

#### PR15：DevPanel（运行流可视化）

- 新页面 `src/app/dev/runtime/page.tsx`：
  - 左：实时 saga_instances 列表（按 status 分组）
  - 右：选中 saga 的 agent_runs 时间线 + 因果链树（agent_events 按 sequence 渲染）
  - 数据源：`agentRunsStore` / `sagaInstancesStore`（已在 PR3 投影）
  - 增加按 topicId / threadId 过滤
- DoD：能可视化 1 次 TopicInitSaga 5 段流 + 1 次 Thread tick 的全部事件

#### PR16：UI 全量重命名

- 删除 `src/components/topic/*` thin wrapper，把所有引用改为直接从 `topic` 目录导入
- 删除 `src/app/goals/*` 旧路由，把 redirect 反转为 `/goals/* → /topics/*`
- 把 `src/components/goal/*` 实质内容迁到 `src/components/topic/*`，原目录改为反向 thin wrapper（如有外部引用）
- 同步 inbox / history 页面的 `goalId` → `topicId` 文案与导航
- DoD：grep `\\bgoal\\b` 在 src/components 与 src/app 应趋近 0（除 stateSnapshot 双写期 key）

### 11.4 已知技术债 / 待复核项

- [ ] `runtime_jobs.goal_id` 列在 v12 上线 1 版本后再发独立 PR 删除（v1.2 §10.5 问题 25 后续 PR16 计划）
- [ ] `conversationMessagesRepository.appendThreadMessage` 是否真有该方法？需在 PR14 阶段 grep 确认；不存在则按现有 conversation_messages append 接口扩参
- [ ] `cron-parser` 包是否已在依赖中？PR13 daemon 拉起前 `pnpm ls cron-parser` 验证
- [ ] PR9c 的 awaiting_user 暂停后恢复路径只在 spec 中验证；PR11 wire 后需端到端验证（用户回填 collectedInfo 后能继续 plan 阶段）
- [ ] §3.3.5 ThreadRunner prompt 8 条约束断言已加，但断言文本"决策/展示层拆分"等关键字与 prompt 文案是 1:1 同步关系；后续修改 prompt 文案时需同步更新 spec

### 11.5 跨会话恢复指南

新会话开局推荐顺序：
1. 读本节（§十一）对齐进度
2. `pnpm test:planning` 一遍确认基线绿
3. 选定下一个 PR（推荐顺序：**PR11 → PR14 → PR13 → PR14.5 → PR15 → PR16**；PR11 / PR14 可并行）
4. 严格遵守现有约束：
   - `generic_result` 类型 + 决策/展示拆分 + payload ≤ 8KB
   - DB 迁移走 `addColumnIfMissing`
   - 命令 API 必带 `Idempotency-Key`
   - Agent Run 状态机走 `revision` 乐观锁
   - 新代码必须有 `*.spec.ts` 注册到 `run-planning-specs.ts`

**预计剩余工作量**：5 个 PR；当前所有"纯函数 / 决策层"已就位，剩下都是 IO 接线 + UI。

---

## 十二、后续 PR 详细设计（PR11 → PR16）

> 本节把 §11.3 的清单展开为可直接照抄的实施细节。每个子节包含：依赖关系、改动点、关键代码骨架、测试要求、Definition of Done。
> **基线**：v1 主体 + §9 + §10 + §11；冲突时本节为准。

### 12.1 PR11：TopicInitSaga 接入命令路由

**依赖**：PR9c（topicInitSaga 编排）+ PR9b（5 角色 prompt）+ PR3（agentRunCommandService）

#### 12.1.1 改动点

| 文件 | 改动 |
| --- | --- |
| [src/lib/server/services/topicCommandService.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/services/topicCommandService.ts) | `create_topic` 命令分支：替换 `generateTopicPlanWithClaude` 直接调用为 `runTopicInitSaga`；包装 5 个 `LlmInvoke` 与 `sagaInstanceId` 注入 |
| [src/lib/server/topicSaga/topicInitSaga.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/topicSaga/topicInitSaga.ts) | 暴露 `runTopicInitSaga(input, deps)`；deps 含 `{ sagaRepo, runRepo, eventRepo, llmInvokes: { interviewer, planner, critic, refiner, presenter }, prompts }` |
| [src/lib/server/topicPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/topicPlanning.ts) | thin wrapper：内部转发到 `runTopicInitSaga` 而非旧 `generateGoalPlanWithClaude` |
| [src/lib/server/goalPlanning.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalPlanning.ts) | `generateGoalPlanWithClaude` 改为 `topicPlanning` 转发；保留 1 版本后删 |

#### 12.1.2 LlmInvoke 注入约定

```typescript
// topicCommandService.ts 接入点
const llmInvokes = {
  interviewer: createClaudeJsonInvoke({ role: "topic_saga::interviewer", maxTokens: 1500 }),
  planner: createClaudeJsonInvoke({ role: "topic_saga::planner", maxTokens: 4000 }),
  critic: createClaudeJsonInvoke({ role: "topic_saga::critic", maxTokens: 2000 }),
  refiner: createClaudeJsonInvoke({ role: "topic_saga::refiner", maxTokens: 4000 }),
  presenter: createClaudeJsonInvoke({ role: "topic_saga::presenter", maxTokens: 2500, async: true }),
};
const sagaInstance = await sagaInstancesRepository.createSagaInstance({
  topicId,
  type: "topic_init",
  idempotencyKey: `topic-init-${topicId}-${conversationId}`,
});
await runTopicInitSaga({ topicId, userInput, conversationId, sagaInstanceId: sagaInstance.id }, { ...deps, llmInvokes });
```

#### 12.1.3 awaiting_user 续接

- Interviewer 输出 `kind: "needs_user_input"` → 写 `agent_event type:"awaiting_user"` + saga.status=`awaiting_user`
- 前端 `agentRunsStore` 投影到 UI 提问卡片
- 用户回答 → `POST /api/agents/runs/commands { kind: "resume", input: { collectedInfo } }`
- `agentRunCommandService.resume` 读 `last_event_seq` 后调 `runTopicInitSaga.resume(sagaId, input)`，executor 跳过已写事件直接进 Planner

#### 12.1.4 Spec 要求

- 复用 PR9c 5 场景 spec（happy path / awaiting_user / critic 3 轮 / refiner 强制接受 / presenter 异步失败）
- 新增 1 个集成 spec：`topicCommandService.spec.ts` 中跑 happy path，断言：
  - `agent_runs` 写入 5 条（interviewer/planner/critic/refiner/presenter）
  - `saga_instances.status = "completed"`
  - `topics` envelope 含 ≥1 个 Thread

#### 12.1.5 Definition of Done

- [ ] `pnpm test:planning` 全绿
- [ ] 手动创建 Topic："持续跟踪 NVDA 投资机会"（无 deadline）→ DevPanel 看到 5 段轨迹 + Topic.deadline=null
- [ ] Interviewer needs_user_input 场景：UI 卡片显示问题 → 用户回答 → resume 继续

---

### 12.2 PR13：ThreadLoopWorker daemon 外壳

**依赖**：PR12 纯函数层（已落地）+ PR14 仓库层（建议先做 PR14.1 仓库再做 PR13）

#### 12.2.1 新文件骨架

**新文件**：`src/lib/server/scheduler/threadLoopDaemon.ts`

```typescript
export interface ThreadLoopDaemonConfig {
  tickIntervalMs: number;            // 默认 60_000
  clock?: () => Date;                // 可注入虚拟时钟
  onError?: (err: unknown) => void;
}

export interface ThreadLoopDaemon {
  start(): void;
  stop(): Promise<void>;
  restart(): Promise<void>;
  isRunning(): boolean;
}

export function createThreadLoopDaemon(deps: ThreadLoopFrameDeps, config?: ThreadLoopDaemonConfig): ThreadLoopDaemon;
```

#### 12.2.2 关键行为

1. `start()`：`setInterval(tickIntervalMs)` 内调 `runThreadLoopFrame({ now: clock() }, deps)`
2. cron loopInterval：`runThreadLoopFrame` 返回的 candidate 中 `cron_passthrough` 类的，daemon 二次过滤后才 dispatch（用 `cron-parser.parseExpression(expr).next()` 判断是否 ≤ now）
3. 同 thread 并发防重：`runThreadLoopFrame` 之前 `SELECT 1 FROM runtime_jobs WHERE thread_id=? AND kind='thread_tick' AND status IN ('queued','leased')`，存在则跳过（§9.3 问题 10）
4. 重启策略：`stop()` 清 interval + 等待 in-flight tick 结束（最多 30s）；`restart()` 等价 `stop().then(start)`

#### 12.2.3 接入点

**改文件**：[src/lib/daemon/daemonRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/daemon/daemonRunner.ts)

- 与现有 4 个 worker（goalScheduler / taskDispatch / goalNotification / recovery）并列拉起 `threadLoopDaemon`
- 现有 `goalSchedulerEngine` 不动；ThreadLoopWorker daemon 独立 tick

#### 12.2.4 依赖检查

- PR13 启动前必须执行：`pnpm ls cron-parser`；如不存在 → `pnpm add cron-parser` 单独提交（与 daemon PR 解耦）
- 兜底：`parseThreadLoopInterval` 在 cron 解析失败时降级为 `one_shot`（已实现）

#### 12.2.5 Spec 要求

- `threadLoopDaemon.spec.ts`：
  - 注入虚拟时钟 + 1 个 active daily Thread → 跑一帧 → 断言 `runtime_jobs` 出现 1 条 `kind="thread_tick"` 任务
  - `stop()` 后 setInterval 不再触发
  - 同 thread 已有 queued job → 跳过 enqueue

#### 12.2.6 Definition of Done

- [ ] `pnpm test:planning` 全绿
- [ ] 本地 `pnpm dev` 启动后日志看到 `threadLoopDaemon: started`
- [ ] kill -9 daemon 后重启，active Thread 自动续 tick

---

### 12.3 PR14：仓库层 + 全链路 wire（最大单元）

**依赖**：PR4（Topic/Thread 类型）+ PR1a（schema v11 已扩 thread_id 列）

#### 12.3.1 5 个仓库设计

##### 12.3.1.1 `threadsRepository.ts`

存储策略：**复用 `runtime_state_snapshots.topics` envelope 内嵌路径访问**（不新建 `threads` 表，避免 v12 再次扩 schema）；仅在 envelope 中按 `topicId` 索引出 `threads[]` 子数组。

```typescript
export interface ThreadsRepository {
  findById(threadId: string): Promise<Thread | null>;
  update(threadId: string, patch: Partial<Thread>, baseRevision: number): Promise<Thread>;  // 乐观锁
  listByTopicStatus(topicStatus: TopicStatus): Promise<Thread[]>;
  markPaused(threadId: string, reason: string): Promise<void>;
}
```

并发控制：`update` 走 envelope 整体 revision + 内嵌 `thread.revision` 双重校验；版本不匹配抛 `ThreadRevisionMismatchError`。

##### 12.3.1.2 `taskInstancesRepository.listRecentByThreadId`

```typescript
export function listRecentByThreadId(
  threadId: string,
  opts: { limit?: number; sinceDays?: number } = {}
): Promise<TaskInstance[]>;
// 默认 limit=12, sinceDays=7
// 走现有 task_instances 表，新增 WHERE thread_id=? AND created_at >= ? ORDER BY created_at DESC LIMIT ?
```

##### 12.3.1.3 `inboxRepository.append`

确认现有 inbox 数据源；若已有 `appendInboxMessage` 直接复用；否则新增：

```typescript
export function appendInboxMessage(input: {
  topicId: string;
  threadId?: string;
  text: string;
  severity: "info" | "warning" | "important";
  source: "thread_tick" | "thread_paused" | "saga_failed";
}): Promise<{ inboxMessageId: string }>;
```

##### 12.3.1.4 `conversationMessagesRepository.appendThreadMessage`

**待复核**（§11.4 技术债）：先 grep 现有 `conversationMessagesRepository.ts` 是否已有等价方法；不存在则按现有 `append` 接口扩参（加 `threadId?` 与 `severity?`）。

```typescript
export function appendThreadMessage(input: {
  topicId: string;
  threadId: string;
  text: string;
  severity: "info" | "warning" | "important";
}): Promise<{ conversationMessageId: string }>;
```

##### 12.3.1.5 `dispatchTask` 服务方法

复用现有 task command service；提供薄包装：

```typescript
export async function dispatchTaskFromThread(
  request: DispatchTaskRequest,  // 已定义在 dispatchActions.ts
  deps: { taskCommandService }
): Promise<{ taskId: string; instanceId?: string }>;
// 强制 taskType="one_shot" + 校验 threadId 必填
```

#### 12.3.2 7 个 callback 绑定点（全列出）

在 PR13 daemon `runThreadLoopFrame` 调用处装配：

| Callback | 绑定 |
| --- | --- |
| `collectActiveThreads` | `threadsRepository.listByTopicStatus("active")` filter `thread.status === "active"` |
| `collectRecentTaskInstances` | `taskInstancesRepository.listRecentByThreadId(threadId, { limit: 12, sinceDays: 7 })` |
| `prepareAgentRun` | `agentRunsRepository.createAgentRun({ topicId, threadId, role: "thread_runner", idempotencyKey: \`thread-tick-\${threadId}-\${frameStartedAt.toISOString()}\` })` |
| `persistThreadPatch` | `threadsRepository.update(threadId, patch, baseRevision=thread.revision)` |
| `recordTickOutcome` | `agentEventsRepository.appendAgentEvent` 写 `thread.tick.output` / `thread.tick.dispatch_partial_failure` / `thread.tick.failed` |
| `dispatchTask` | `dispatchTaskFromThread(request, { taskCommandService })` |
| `sendThreadMessage` | 双写：`conversationMessagesRepository.appendThreadMessage` + `inboxRepository.appendInboxMessage`（事务/幂等：用同一 `traceId` 写两端，失败回滚 conversation 写） |

#### 12.3.3 §3.4.5 调度器升级

- `parseThreadLoopInterval` + `computeNextTickAt`（已落地）→ 在 `runThreadLoopFrame` 中决定下一 tick 时刻
- 旧 `goalSchedulerEngine` 不动；ThreadLoopWorker daemon 独立运行
- `goalSchedulerEngine.ts` 重命名为 `topicSchedulerEngine.ts`（v1 §3.4.4）推迟到 PR16；PR14 期不动

#### 12.3.4 Spec 要求

- 每个仓库都有 `*.spec.ts` 走 `:memory:` SQLite + envelope mock
- `threadsRepository.update` 必测：版本不匹配抛错
- `dispatchTaskFromThread` 必测：taskType 强制 one_shot；缺 threadId 报错

#### 12.3.5 Definition of Done

- [ ] `pnpm test:planning` 全绿
- [ ] 端到端：创建 Topic → daemon 跑一帧 → DB 中出现 task / inbox / conversation_messages 三处写入
- [ ] 并发：手动同时跑 2 帧（虚拟时钟相同 now）→ 第二帧 skip（§9.3 问题 10 验证）

---

### 12.4 PR14.5：BOOTSTRAP_SQL 同步终态

**依赖**：PR1a（v11 schema）+ PR2（v12 schema 双写）

#### 12.4.1 改动点

**改文件**：[src/lib/server/db/schema.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/db/schema.ts)

- `KIKI_DB_BOOTSTRAP_SQL` 增加：
  - 5 张新表：`agent_runs / agent_events / agent_messages / saga_instances / agent_snapshots`（含全部索引）
  - `runtime_jobs` 新列：`topic_id / thread_id / saga_instance_id` + 相应索引
  - `runtime_state_snapshots` envelope key `"topics"` 文档说明（comment）

#### 12.4.2 关键约束

- BOOTSTRAP_SQL 的语义 = "v12 终态"；新装机 → BOOTSTRAP → schema_version 写为 12 → 跳过所有 migration
- 所有 DDL 用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`（保证重入安全）
- 不动 v11/v12 migration 本身（迁移路径仍然有效）

#### 12.4.3 验证

- `schema.spec.ts` 增加路径 C：仅 BOOTSTRAP_SQL（不跑 migration）→ schema 与路径 B（仅 migration）等价
- 路径 A / B / C 三者 PRAGMA table_info diff 为空

#### 12.4.4 Definition of Done

- [ ] 删除本地 `db/kiki.db` 后 `pnpm dev` 启动能跑通端到端
- [ ] `schema.spec.ts` 三路径全绿
- [ ] CI 中 fresh DB 跑 `pnpm test:planning` 全绿

---

### 12.5 PR15：DevPanel 数据源 + 渲染要点

**依赖**：PR3（agentRunsStore / sagaInstancesStore 投影）+ PR11（5 段轨迹数据）+ PR13（thread tick 数据）

#### 12.5.1 新页面骨架

**新文件**：`src/app/dev/runtime/page.tsx`

```tsx
export default function DevRuntimePage() {
  return (
    <DevRuntimeLayout>
      <SagaInstancesList />          {/* 左栏：按 status 分组列表 */}
      <SagaRunsTimeline />            {/* 右上：选中 saga 的 agent_runs 时间线 */}
      <CausationTree />               {/* 右下：因果链树（agent_events 按 sequence） */}
    </DevRuntimeLayout>
  );
}
```

#### 12.5.2 数据源

| 组件 | 数据源 | 投影 hook |
| --- | --- | --- |
| `SagaInstancesList` | `sagaInstancesStore` | `useSagaInstances({ status?, type? })` |
| `SagaRunsTimeline` | `agentRunsStore` | `useAgentRunsBySaga(sagaId)` |
| `CausationTree` | `agentRunsStore` + `agentEventsStore`（PR15 新增） | `useAgentEventsByRun(runId, { fromSeq? })` |

#### 12.5.3 角色命名空间分组（§10.7 问题 27）

```typescript
function formatRoleDisplay(role: string): { scope: string; label: string } {
  if (["interviewer","planner","critic","refiner","presenter"].includes(role))
    return { scope: "topic_saga", label: role };
  if (role === "thread_runner")
    return { scope: "thread", label: role };
  return { scope: "task_orchestration", label: role };
}
```

UI 按 scope 三栏分组渲染；不进 DB 字段。

#### 12.5.4 控制按钮

- saga 行右侧：Pause / Resume / Cancel / Retry → 调 `/api/agents/runs/commands`
- agent_run 行：仅展示，不允许操作（避免越权）

#### 12.5.5 过滤器

- 顶部：topicId / threadId / 时间范围（默认最近 24h）
- 性能：列表分页 50 条 / 因果链按需展开

#### 12.5.6 Definition of Done

- [ ] 完整可视化 1 次 TopicInitSaga 5 段流（interviewer/planner/critic/refiner/presenter）
- [ ] 完整可视化 1 次 Thread tick 的 agent_events 流
- [ ] Pause / Resume 按钮对一个 awaiting_user saga 真实生效

---

### 12.6 PR16：UI 全量重命名 + redirect 反转

**依赖**：PR8（thin wrapper 已落地）+ PR15（DevPanel 自带 topic 路径）

#### 12.6.1 重命名步骤（按顺序）

1. **物理迁移**：`src/components/goal/*` 内容移到 `src/components/topic/*`（已重命名的保留；未重命名的真实迁移）
2. **反向 wrapper**：`src/components/goal/*` 改为反向 thin wrapper 重导出 `topic/*`（防外部引用断裂）
3. **路由反转**：
   - 删除 `src/app/goals/[goalId]/*` 旧路由实质内容
   - `app/goals/*` 改为 308 redirect → `app/topics/*`（GET）+ 内部转发（POST/PATCH/DELETE，§9.4 问题 15）
   - `app/topics/*` 是实质实现
4. **inbox / history 文案与导航**：所有 `goalId` → `topicId`，所有 "目标" 文案 → "主题"（保留旧文案 1 版本作为 i18n alias）

#### 12.6.2 grep 验收

```bash
# 应趋近 0（除 stateSnapshot 双写期 key + legacy migration 工具）
grep -rn "\\bgoalId\\b" src/components src/app | grep -v "stateSnapshot\|legacyGoal\|migration"
grep -rn "\\bGoal\\b" src/components src/app | grep -v "type alias\|deprecated"
```

允许保留：
- `stateSnapshot.ts` 的 `"goals"` envelope key（双写期）
- `src/lib/migration/legacy*` 工具
- `src/types/kiki.ts` 中标 `@deprecated` 的 type alias

#### 12.6.3 同步处理

- `runtime_jobs.goal_id` 列**不**在 PR16 删除（独立 PR 在 v12 上线 1 版本后发；§10.4 问题 24）
- `runtime_state_snapshots.goals` envelope key **不**在 PR16 删除（独立 PR；§10.5 问题 25）

#### 12.6.4 Definition of Done

- [ ] grep `\\bgoal\\b` 在 src/components 与 src/app 趋近 0（白名单除外）
- [ ] 老 URL `/goals/<id>` 浏览器输入 → 自动 308 → `/topics/<id>`
- [ ] inbox / history 页面所有"目标"文案改为"主题"
- [ ] `pnpm test:planning` 全绿

---

## 十三、端到端冒烟与上线门禁

> 本节定义 P2 完成后必须通过的端到端验证场景与上线门禁清单。
> **基线**：v1 §5 验收 + 本节追加。
> **顺序**：13.1 → 13.2 → 13.3（功能冒烟）→ 13.4（门禁）→ 13.5（回滚预案）。

### 13.1 冒烟场景一：持续跟踪 NVDA（无 deadline 全链路）

**前置**：PR11 + PR13 + PR14 + PR14.5 全部 merged；本地 DB 删除后 fresh 启动。

**步骤**：
1. 用户在会话中输入"持续跟踪 NVDA 投资机会"（无任何 deadline 字眼）
2. Interviewer 第一次输出：本期信息覆盖率 ≥ 80%，**直接跳过追问**进入 Planner
3. Planner 产出 2-4 个 Thread + 每个 Thread 的种子 Tasks（默认 `taskType="one_shot"`）
4. Critic ⇄ Refiner 收敛（≤ 3 轮）
5. Presenter 异步 fire-and-forget 产出展示卡片，措辞含"持续帮你跟踪"，**不**显示截止日期
6. Saga 完成后立即 enqueue 一次 thread_tick（在 stepRefiner 完成后即触发，§9.3 问题 9）
7. ThreadLoopWorker daemon 跑一帧 → ≥1 条 `dispatch_task` 或 `post_message`
8. 等待 daily Thread 第二天再跑（注入虚拟时钟跳 24h）→ 复跑成功

**断言**：
- `topics` envelope 中 `topic.deadline === null`
- `agent_events` 中**不**含字符串 `"2026-06-30"` / `"DEFAULT_DEADLINE"`
- DevPanel "Agent Runs" Tab 显示完整 5 段 saga 轨迹 + N 段 thread tick 轨迹
- inbox 中出现 ≥1 条 thread tick 产生的提示

### 13.2 冒烟场景二：Interviewer awaiting_user 中断/恢复

**步骤**：
1. 用户输入"帮我研究下美股投资"（信息覆盖率 < 80%）
2. Interviewer 输出 `kind: "needs_user_input"` + 3 个问题
3. saga.status → `awaiting_user`；UI 显示提问卡片
4. **kill -9 daemon** → 等 5s → 重启
5. 用户回答 3 个问题 → POST `/api/agents/runs/commands { kind: "resume" }`
6. Saga 从 last_event_seq 续接，进入 Planner

**断言**：
- 重启前后 `saga_instances.status` 保持 `awaiting_user`
- resume 后 `agent_events` 续写不重复（同 seq 唯一约束生效）
- 前端 `agentRunsStore` 投影正确刷新

### 13.3 冒烟场景三：daemon 重启续接 + 失败累计

**步骤**：
1. 创建 Topic → 5 段 saga 完成 → 2 个 hourly Thread 进入活跃
2. 注入"hourly Thread 故意 LLM 异常"5 次
3. 第 5 次后 thread.status = `paused`，inbox 出现告警
4. **kill -9 daemon** → 重启
5. 已 paused Thread 不再 tick；其他 active Thread 继续

**断言**：
- `runtime_jobs` 中无重复 `kind="thread_tick"` 任务（§9.3 问题 10）
- `failureCount` 单调递增到 5 后 paused
- `agent_events` 末尾有一条 `type:"error"` + 一条 `type:"thread_paused"`

### 13.4 上线门禁清单

> 本节是合并到 main 前**必须全部通过**的硬性检查项。任何一项 FAIL 阻塞上线。

#### 13.4.1 数据层门禁

- [ ] v11 / v12 migration 在 prod DB 副本上 dry-run 全绿
- [ ] BOOTSTRAP_SQL 与 v12 终态一致（`schema.spec.ts` 三路径等价）
- [ ] `addColumnIfMissing` 重入安全（同一 :memory: 重跑 migration 不抛 `duplicate column name`）
- [ ] `runtime_jobs.goal_id` → `topic_id` 一次性回填生效（`SELECT COUNT(*) FROM runtime_jobs WHERE topic_id IS NULL AND goal_id IS NOT NULL` = 0）
- [ ] `runtime_state_snapshots` 同时存在 `goals` 与 `topics` 两 key，内容等价

#### 13.4.2 测试层门禁

- [ ] `pnpm test:planning` 全绿（含新增的 saga / thread / migration / repository spec）
- [ ] `pnpm exec tsc --noEmit` 无错
- [ ] `promptDuplicationGuardSpec` 5 角色 prompt + ThreadRunner 13 关键字断言全绿
- [ ] `resumeManager.spec.ts` 三场景（running/awaiting_user/dispatch 末尾）全绿

#### 13.4.3 Prompt 与决策门禁

- [ ] grep `DEFAULT_DEADLINE` / `FALLBACK_DEADLINE` 在 src 中为 0
- [ ] grep `"deadline"\\s*:\\s*"2026` 在 src 中为 0（业务数据除外）
- [ ] 所有新增 prompt 沿用决策/展示拆分（决策层单 JSON ≤ 50 行 ≤ 2000 字符）

#### 13.4.4 兼容层门禁

- [ ] `/api/goals/*` thin proxy 携带 `Deprecation: true` + `Sunset` header
- [ ] POST/PATCH/DELETE 走内部转发而非 redirect（§9.4 问题 15）
- [ ] 老 URL `/goals/<id>` 浏览器访问 → 308 → `/topics/<id>` 正确解码 / 转义 / searchParams 保留

#### 13.4.5 运行时门禁

- [ ] daemon 启动后日志看到 `threadLoopDaemon: started`
- [ ] kill -9 daemon 后重启，所有 active Thread 自动续 tick
- [ ] payload > 8KB 自动外置到 `agent-payloads/${runId}/${seq}.json` 并填 `payloadRef`
- [ ] DevPanel "Agent Runs" Tab 三组（topic_saga / thread / task_orchestration）渲染无冲突

### 13.5 回滚预案

| 场景 | 触发条件 | 回滚步骤 | RTO |
| --- | --- | --- | --- |
| migration v11 失败 | dry-run FAIL 或线上 ALTER 抛错 | `cp prod.db.backup-* prod.db` + revert PR1a | < 5 min |
| migration v12 数据丢失 | snapshot `topics` envelope 缺字段 | 切回 `goals` envelope 读路径（双写期保留） + revert PR2 | < 10 min |
| TopicInitSaga 大面积失败 | 错误率 > 5% | feature flag `USE_TOPIC_INIT_SAGA=false` 走 thin wrapper 退回 `generateGoalPlanWithClaude` | < 1 min |
| ThreadLoopWorker 死循环 | failureCount 阈值失效 | daemon `stop()` + 把所有 `runtime_jobs.kind="thread_tick"` 状态置为 `cancelled` | < 5 min |
| DevPanel 性能问题 | 首屏 > 3s | 关闭 `/dev/runtime` 路由（feature flag） | < 1 min |
| 旧 `/api/goals/*` 调用方 4xx 暴增 | proxy 转发 bug | 把 thin proxy 切回 308 redirect（仅 GET） + 公告 24h 内修复 | < 5 min |

#### 13.5.1 数据备份策略

- migration 真跑前自动 `cp prod.db prod.db.backup-$(date +%s)`
- 上线后 48h 代码冻结期不删 backup
- 48h 后开始按"3-2-1"策略归档（3 份副本、2 种介质、1 份异地）

#### 13.5.2 Feature flag 清单

| Flag | 默认 | 用途 |
| --- | --- | --- |
| `USE_TOPIC_INIT_SAGA` | true | 关闭后退回旧 `generateGoalPlanWithClaude` |
| `USE_THREAD_LOOP_DAEMON` | true | 关闭后停止 thread tick；不影响 saga |
| `USE_DEV_RUNTIME_PANEL` | true（dev/staging）/ false（prod） | DevPanel 路由开关 |
| `USE_LEGACY_GOAL_REDIRECT` | true | 关闭后老 `/goals/*` 直接 404（仅在所有调用方升级后开启） |

---

**v1 实施计划完结线**：§一 → §十三 共 13 节，覆盖 16 个 PR（PR1a/1b → PR16）+ 3 轮自检（v1.1 §九、v1.2 §十、§十一末态快照）+ 端到端冒烟与上线门禁。

**最终基线优先级**：§十三（运行门禁） > §十二（PR 详细设计） > §十一（末态交接） > §十（v1.2 自检） > §九（v1.1 自检） > §一~§八（v1 主体）。冲突时高优先级胜出。


