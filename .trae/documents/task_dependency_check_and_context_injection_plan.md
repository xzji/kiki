# 任务执行上下文（TaskExecutionContext）领域设计方案 v3

## Summary
不要再"打补丁"。当前调度、执行、prompt、readiness、UI 都在各自重复回答同一个问题——"这个任务现在到底能不能跑、上游给了什么、缺什么"。每处实现都不完整，所以 task-2 这种"上游已经完成、下游仍然问城市"的断点在任意层都可能发生。

正确做法是把"任务能否执行 + 任务执行时拥有的上下文"抽象成一等领域对象，由唯一 Resolver 统一构造，作为执行链路所有下游组件（scheduler / runner / prompt / readiness / telemetry / UI）的**唯一输入**。这样：

- 依赖检查、依赖结果消费、依赖错误引导是同一份事实的不同视图。
- 旧的零散依赖逻辑被删除而不是叠加，避免双轨并行。
- 后续要扩展（会话上下文 / 用户档案 / 资源约束）时，只在 Context schema 与 Resolver 上演进。

v3 在 v2 基础上落实 7 项关键修订（domain 漏 subGoal、conversationId 来源、admit 不能跑 LLM、instance 创建顺序、前端 409 处理、existing-job runtime job API、digest 字段路径标注）+ 3 项小修订（admit gate 契约测试、fixture 注释、telemetry 噪音控制）。

## Domain Model

引入两个领域对象 + 一个分阶段的 Resolver 接口：

```
TaskExecutionContext
├── identity         { conversationId, goalId, subGoalId, taskId, instanceId?, requestId? }
├── readiness        { state: "ready" | "blocked", blockers: ContextBlocker[] }
├── dependencies     DependencyView[]            // 上游任务在当前任务视角的投影
├── inputs           { conversation, goal, subGoal, task, instance? }
│                                              // subGoal 必填：prompt / telemetry / Presenter 都需要 subGoal.id / title
│                                              // instance 仅 execution 阶段存在
├── workspace?       { taskWorkspaceDir, dependenciesDir, artifactsDir } // 仅 execution 阶段填充
└── budget           { maxPromptBytes, maxKeyPoints, maxArtifacts }

DependencyView
├── ref              { taskId, title, expectedOutcome }
├── status           "completed" | "awaiting_user" | "in_progress"
│                  | "not_started" | "failed" | "missing"   // missing = 配置错误
├── digest?          DependencyDigest                       // 仅 status === "completed" 时存在
└── blocker?         { reason: string, hint: string }       // 其它状态用于错误引导

DependencyDigest（字段路径以实施时 src/types/kiki.ts 中 TaskInstance.result schema 为准，下列为意图描述）
├── summary          string
├── userDecision?    string
├── keyPoints        string[]                               // 抽自 taskResult.blocks
├── tableRows?       Array<Record<string, string>>          // 来自 comparison_table，最多 N 行
├── keyValues?       Array<{ key: string; value: string }>  // 来自 key_value
├── lists?           Array<{ heading?: string; items: string[] }> // 来自 list
├── artifacts        Array<{ id, label, localPath? }>
└── resultPointer    { kind: "fs", relativePath: string }   // 当前任务工作目录中的相对路径

ContextBlocker
├── kind             "dependency" | "missing_user_input" | "cycle" | "config"
├── severity         "block" | "soft_wait"
├── source           "user" | "agent" | "system"            // 沿用 ReadinessInfoItem 语义
├── id               string                                 // 与 ReadinessInfoItem.id 一致或 dep:{taskId}
├── label            string
├── message          string                                 // 面向 UI 的人类语言
├── reason           string                                 // 面向 telemetry/日志
├── value?           string                                 // 透传 ReadinessInfoItem.value
├── options?         string[]                               // 透传 ReadinessInfoItem.options
├── optionQuestion?  string                                 // 透传，UI 必需
├── inputPlaceholder?string                                 // 透传，UI 必需
└── suggestedActions ContextSuggestedAction[]

ContextSuggestedAction
├── label            string
└── kind             "free_text" | "navigate_task"          // navigate_task 时附 taskId
```

`ContextBlocker` 字段对齐 [`TaskReadinessInfoItem`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskReadinessPolicy.ts#L5-L16)，确保 UI 现有 `optionQuestion / options / inputPlaceholder / value` 渲染不丢字段。

`ContextSuggestedAction.kind = "navigate_task"` 是显式约定的扩展点：UI 暂时按纯文案渲染，后续小步迭代加跳转能力，不在本方案范围内强行实现。

**字段路径权威性**：`DependencyDigest` 抽取规则中提到的 `interactionSubmission / awaitingUser / taskResult.blocks` 等具体字段，以实施时 `src/types/kiki.ts` 的 `TaskInstance.result` schema 为准。本方案仅规约抽取意图（要拿到 userDecision / keyPoints / tableRows 等），具体字段映射在 `dependencyDigest.ts` 实施时对齐当前 schema。

## Resolver Interface（拆成两个入口，避免造假 instance）

```ts
// 调度器 / 执行入口 admit gate 用：
//  - 不需要 instance、不物化 workspace
//  - 仅同步路径，绝不调用 LLM / OpenAI / Claude 客户端
export function resolveAdmitDecision(input: {
  conversationId: string;            // 由调用方显式传入；Goal 类型上不存在 conversationId
  goal: Goal;
  subGoal: SubGoal;                  // prompt / telemetry / multi-agent 都需要
  task: Task;
}): TaskExecutionContext;

// Runner 真正执行前用：
//  - 必须有 instance、强制物化 workspace
//  - 可在 ready 之后再跑 LLM-based readiness judge（见 §4）
export function resolveExecutionContext(input: {
  conversationId: string;
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  requestId: string;
}): TaskExecutionContext;
```

**关键约束**

- `conversationId` 一律由调用方传入，不从 `goal` 派生（Goal 类型上没有 `conversationId`）。
- `subGoal` 必填：`buildGoalTaskRunnerPrompt`、Presenter prompt、telemetry 都需要 `subGoal.id / subGoal.title`。
- 两个入口共用相同的 dependency graph / digest / blocker 计算，只在"是否需要 instance"和"是否物化"上有区别。
- **admit 路径绝对同步**：scheduler 主循环、`POST /execute` 都依赖 admit gate 的同步性。如果 admit gate 调 LLM，会引发主循环阻塞和不可预期的并发问题。

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│             TaskExecutionContextResolver                            │
│  resolveAdmitDecision   ─── scheduler & POST /execute（同步、无 LLM）│
│  resolveExecutionContext ─── worker pickup → runGoalTask            │
│                                                                     │
│   1. buildTaskGraph(goal) + detectCycle                             │
│   2. 构造 DependencyView[]（含 digest 抽取与裁剪）                   │
│   3. 计算 readiness（dependency blockers + 同步 user-input policy）  │
│   4. (仅 execution) materialize workspace                          │
│   5. (仅 execution，且仅在 readiness=ready 之后) 可选 LLM judge      │
└──────────────┬──────────────────────────────────────────────┬───────┘
               │                                              │
   used by     ▼                                              ▼  used by
   Scheduler.getReadyTasks                              GoalTaskRunner.runGoalTask
   POST /api/goals/tasks/execute (admit gate)           buildGoalTaskRunnerPrompt
                                                        buildTaskReadinessCheckWithJudge
                                                        agentOrchestration/prompts.ts
                                                          (Presenter prompt 也接 Context)
```

**关键设计取舍**
- Resolver 只读：不调用 LLM、不写 SQLite、不修改 task 状态。
- 物化只发生在 Runner 真正执行前；admit gate（scheduler / route）一律 `materialize=false`，避免 awaiting / 重复请求残留垃圾文件。
- `dependencies/` 是 Context 在文件系统上的镜像，仅 Runner 阶段写入；prompt 中始终引用其相对路径以保证 token 预算可控。
- LLM-based readiness judge 仅在 Runner 进入 ready 分支后调用，可以把任务再退回 awaiting，但不破坏 admit gate 的同步性。

## Current State Mapping

| 现有零散逻辑 | 处理方式 |
| --- | --- |
| [`dependenciesMet`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalSchedulerEngine.ts#L65-L74) | **删除**，scheduler 改读 `resolveAdmitDecision(...).readiness`。 |
| [`formatTaskDependencies`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts#L6-L16) | **删除**，prompt 改为渲染 `DependencyView[]`。 |
| `goalTaskRunner` 内对依赖的零散读取 | **替换**为 `resolveExecutionContext` 一次性输出。 |
| [`taskReadinessPolicy.buildTaskReadinessCheck`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskReadinessPolicy.ts#L97-L149) | 保留为 **policy 子模块**（同步），通过 readinessAdapter 合流到 `context.readiness.blockers`，确保 `optionQuestion / options / inputPlaceholder / value` 字段透传。 |
| `buildTaskReadinessCheckWithJudge`（LLM 路径） | 移出 admit 阶段；只在 Runner ready 分支内调用，可以把任务再退回 awaiting。 |
| [`POST /api/goals/tasks/execute`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/tasks/execute/route.ts) | **加 admit gate**，gate 必须先于 instance 创建 / workspace 创建 / prompt 写入 / runtime job 创建等一切副作用。 |
| `prompt.md` 写入 | 改为同时写 `context.json`（机器可读快照）+ `prompt.md`。 |
| Multi-agent Presenter prompt 调用 [`prompts.ts:L220-L228`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/agentOrchestration/prompts.ts#L220-L228) | **同步切换**到 Context 入参，避免多 agent 路径绕过依赖摘要。 |
| `goalPlanning.ts` 的 `autoRunDisabled` 散点赋值 | 新增 [`setTaskAutoRunDisabled`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtime/goalStateSnapshot.ts) helper，scheduler 写入 cycle / 永久失败 blocker 时调用，不绕过 snapshot 层。 |
| runtime job 状态切换缺少标准 helper | 若现状无 `markRuntimeJobAwaiting(jobId, blocker)` 这样的写入函数，本方案在 `runtimeJobsRepository` 中补齐；不允许内联手写 SQL。 |

## Proposed Changes

### 1. 新模块 `src/lib/server/taskExecution/`
- `taskExecution/types.ts`：`TaskExecutionContext / DependencyView / DependencyDigest / ContextBlocker / ContextSuggestedAction` 类型。
- `taskExecution/dependencyGraph.ts`：`buildTaskGraph(goal)` 与 `detectCycle(graph, taskId)` 纯函数。
- `taskExecution/dependencyDigest.ts`：从 `TaskInstance.result` 与持久化 `result.json` 抽取 digest。
  - 必须支持的 block 类型：`heading / paragraph / list / key_value / callout / comparison_table`。
  - `comparison_table` 抽取规则：取 `title` + `headers` + 前 K 行，转成 `tableRows: Array<Record<string, string>>`，K 由 budget 控制。
  - `list` 抽取：保留 `heading + items`（最多 8 项 / 每项 200 字）。
  - `key_value` 抽取：保留全部键值对，超 budget 时按出现顺序裁剪。
  - `userDecision` 抽取：意图是合并"用户提交字段 + 等待用户原因 + agent 总结"。具体字段路径以实施时 `src/types/kiki.ts` 的 `TaskInstance.result` schema 为准；不作为字段权威。
- `taskExecution/readinessAdapter.ts`：包装 [`buildTaskReadinessCheck`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskReadinessPolicy.ts#L97-L149)（**同步、无 LLM**），把 `TaskReadinessInfoItem` 转成 `ContextBlocker`，逐字段透传。
- `taskExecution/contextResolver.ts`：导出 `resolveAdmitDecision` / `resolveExecutionContext` 双入口。
  - **强约束**：`contextResolver.ts` 中明确禁止 import OpenAI / Claude / 任何 LLM 客户端；通过 lint 规则或测试断言保证。
- `taskExecution/contextWorkspace.ts`：仅在 `resolveExecutionContext` 内部调用，写 `context.json` 和 `dependencies/{depTaskId}/{summary.md, result.json}`。
- `taskExecution/contextRenderer.ts`：把 `DependencyView[]` 渲染成 prompt 段落，prompt builder 调用。
- 单测目录 `taskExecution/__tests__`，覆盖 graph / digest / readiness adapter / resolver。

### 2. Prompt Builder 收敛（含 multi-agent 路径）
**文件**：
- [`src/lib/server/goalTaskPrompt.ts`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts)
- [`src/lib/server/agentOrchestration/prompts.ts`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/agentOrchestration/prompts.ts#L220-L228)

`buildGoalTaskRunnerPrompt` 入参改为 `{ context: TaskExecutionContext, resumeContext?, initialTrajectory?, webAppInteractionContext? }`：

- 删除 `formatTaskDependencies`。
- "Dynamic Context" 区块由 `contextRenderer.renderDependencySection(context)` 输出。当任意 `context.dependencies[i].digest` 存在时，区块标题写为"依赖任务结论（必须直接复用）"，逐依赖渲染 summary / userDecision / keyPoints / tableRows / keyValues / lists / artifacts / resultPointer。
- "执行约束"小节追加（**仅当存在 digest 时附加**）："如果依赖任务结论中已经给出某关键事实（含用户决策），必须直接复用，不得重复检索或再次询问"。
- "建议工作目录"区块同时输出 `context.workspace.dependenciesDir` 的相对路径。

`agentOrchestration/prompts.ts` 中的 Presenter prompt 同步改造：把现有 `buildGoalTaskRunnerPrompt({ goal, subGoal, task, instance, ... })` 调用替换成 `buildGoalTaskRunnerPrompt({ context, ... })`，保证 multi-agent 模式下 Presenter 也读到依赖摘要。

### 3. Scheduler 收敛
**文件**：[`src/lib/server/worker/goalSchedulerEngine.ts`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/worker/goalSchedulerEngine.ts)

```ts
const decision = resolveAdmitDecision({
  conversationId: input.conversationId,         // 来自 scheduler tick 的输入
  goal,
  subGoal,
  task,
});
if (decision.readiness.state !== "ready") {
  recordBlockerTelemetry(decision);
  if (decision.readiness.blockers.some(b =>
    b.kind === "cycle" ||
    (b.kind === "dependency" && b.severity === "block")
  )) {
    upsertGoalsSnapshot(setTaskAutoRunDisabled(readGoalsSnapshot(input.goals), task.id, true));
  }
  continue;
}
```

- `recordBlockerTelemetry` 通过 [`appendGoalLog`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTelemetry.ts) 输出固定 message 模板（不新增枚举字段）：`[task_admit] / [task_deferred] / [task_blocked_by_dependency] / [task_blocked_by_user_input] / [task_blocked_by_cycle]`。
- **噪音控制**：`[task_admit]` 默认不写入（成功路径会刷量），仅在 debug 标志（如 env `GOAL_LOG_ADMIT=1`）打开时输出；`[task_blocked_by_*]` / `[task_deferred]` 默认开。
- `setTaskAutoRunDisabled(goals, taskId, value)` 是新增的 snapshot helper，与 [`addGeneratedInstanceToGoalsSnapshot / markGoalInstanceRunStarted`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtime/goalStateSnapshot.ts) 同层级。

### 4. Runner 收敛（admit 同步 + LLM judge 在 ready 之后）
**文件**：[`src/lib/server/goalTaskRunner.ts`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts)

```ts
const context = resolveExecutionContext({
  conversationId, goal, subGoal, task, instance, requestId,
});
if (context.readiness.state === "blocked") {
  return buildReadinessBlockedResultFromContext(context);
}

// ready 之后再跑 LLM-based judge（可选地把任务再退回 awaiting）
const judged = await buildTaskReadinessCheckWithJudge({ context });
if (judged.state === "blocked") {
  return buildReadinessBlockedResultFromContext({ ...context, readiness: judged });
}

// 进入正式执行
```

- `buildReadinessBlockedResultFromContext` 在 `goalTaskRunner` 内部基于 `context.readiness.blockers` 生成与现有 awaiting 链路兼容的 `TaskReadinessCheck`（保留 `items / missingUserInfo / availableInfo` 数组），让现有 [`buildReadinessBlockedResult`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L283) 的下游渲染零改动。
- ready 时把 `context` 透传给 `buildGoalTaskRunnerPrompt` / `buildTaskReadinessCheckWithJudge` / multi-agent Presenter / `writeTaskPromptFile`。
- `buildTaskReadinessCheckWithJudge` 内部不再独立扫描 dependencies，仅在 user input 维度补充 judge 行为；它**只**被 Runner ready 分支调用，绝不会出现在 admit gate 里。

### 5. 执行入口收敛（含 instance 创建顺序与 existing-job 短路）
**文件**：[`src/app/api/goals/tasks/execute/route.ts`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/tasks/execute/route.ts)

新顺序（**admit gate 先于一切副作用**）：

1. 参数 / runtimeEnv / conversationId 校验（保持不变）。
2. `const decision = resolveAdmitDecision({ conversationId, goal: body.goal, subGoal: body.subGoal, task: body.task });`
3. **若 `decision.readiness.state === "blocked"`**：
   - **不**调用 `addGeneratedInstanceToGoalsSnapshot`（不创建 instance）。
   - **不** `ensureTaskWorkspace`（不创建 task workspace）。
   - **不** `buildGoalTaskRunnerPrompt` / `writeTaskPromptFile`（不写 prompt）。
   - **不** `createQueuedRuntimeJob`（不入队）。
   - 若已有 existing runtime job 处于 `queued / running / awaiting_user`：调用 `markRuntimeJobAwaiting(jobId, blocker)` 把它打成 `awaiting_user` 并写 blocker（避免脏 queued）。
   - 返回 `409 { readiness: decision.readiness, blockers: decision.readiness.blockers }`。
4. **若 ready**：依次执行
   1. `addGeneratedInstanceToGoalsSnapshot`
   2. `ensureConversationWorkspace / ensureTaskWorkspace`
   3. `buildGoalTaskRunnerPrompt({ context: decision })` → `writeTaskPromptFile`
   4. existing-job 短路（如已有 job 则复用并按现有逻辑更新）
   5. `createQueuedRuntimeJob`
5. worker pickup 时再次 `resolveExecutionContext`，并以 Runner 视角的 Context 重写 `context.json` 与 `prompt.md`（保证 dependencies digest 是 worker pickup 时刻的最新值）。

**runtime job 写入函数**：若现状 `runtimeJobsRepository` 中没有 `markRuntimeJobAwaiting(jobId, blocker)`，本方案在该仓库新增；不允许在 route 内内联手写 SQL。

这样 admit gate / runner / scheduler 三处行为同源；admit blocked 路径不会污染 instance / prompt / runtime job。

### 6. Workspace 物化（仅 Runner 阶段）
**文件**：`src/lib/server/taskExecution/contextWorkspace.ts`（新增）

- `tasks/{taskId}/{instanceId}/context.json`：完整 `TaskExecutionContext`，便于排障/重放。
- `tasks/{taskId}/{instanceId}/dependencies/{depTaskId}/summary.md`：基于 digest 渲染。
- `tasks/{taskId}/{instanceId}/dependencies/{depTaskId}/result.json`：用 `fs.copyFileSync` 从源任务 workspace 拷贝，保证 agent 不需要跨任务路径访问。
- `conversationWorkspace.ts` 不新增 helpers，仅复用 `ensureTaskWorkspace`。
- 调度器与 route 路径**绝不**调用此模块。

### 7. Telemetry / UI 收敛
- `appendGoalLog` 调用方按统一 message 前缀输出（不新增枚举字段，避免对现有 telemetry 表造成 schema 漂移）：
  - `[task_admit] ...`（默认关闭，受 debug 标志控制）
  - `[task_deferred] ...`
  - `[task_blocked_by_dependency] taskId={} dep={} status={}`
  - `[task_blocked_by_user_input] taskId={} fields={}`
  - `[task_blocked_by_cycle] path={A->B->A}`
- `awaitingUser.reason` 文案模板（由 ContextBlocker.message 派生）：
  - dependency / not_started: `等待上游任务「{title}」启动后再继续。`
  - dependency / in_progress: `等待上游任务「{title}」完成后再继续。`
  - dependency / awaiting_user: `上游任务「{title}」需要你先回答后才能继续。`
  - dependency / failed: `上游任务「{title}」未达标，请先处理后再继续。`
  - cycle: `任务依赖出现循环：{path}，已暂停自动运行。`
  - missing_user_input: 沿用现有 readiness 文案（透传）。
- `awaitingUser.suggestedActions` 允许两种形态：
  - 现有纯字符串数组（不破坏现有 UI）。
  - `ContextSuggestedAction[]`，UI 当前先按 `label` 渲染纯文案，`navigate_task` 跳转能力作为后续增量小步落地（**非本方案范围**）。
- **前端 409 处理（必须在本方案落地）**：调用 `/api/goals/tasks/execute` 的前端逻辑（如 `useTaskExecution / Composer 触发动作 / 任务卡片"重试"按钮等调用点）需识别 `status === 409` 且 body 含 `readiness`，将其作为 awaiting 渲染分支的输入，复用现有 awaiting UI。如果该次落地无法及时改前端，则保持现有 toast 兜底但必须显示 `readiness.blockers[0].message`，避免出现"点击执行 → 静默失败"的体验黑洞。

### 8. Snapshot 层补齐
**文件**：[`src/lib/server/runtime/goalStateSnapshot.ts`](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/runtime/goalStateSnapshot.ts)

新增：

```ts
export function setTaskAutoRunDisabled(goals: Goal[], taskId: string, value: boolean): Goal[];
```

- 与现有 `addGeneratedInstanceToGoalsSnapshot / markGoalInstanceRunStarted / upsertGoalTaskInstanceSnapshot` 同层级。
- 实现：深拷贝 goals，找到对应 task 设 `autoRunDisabled = value`，找不到时原样返回。
- 仅 scheduler / Runner 在 cycle / 永久失败时调用；UI 与 planning 现有调用点不动。

### 9. 测试与回归
**单测**（`taskExecution/__tests__`）：
- `dependencyGraph.detectCycle` 命中 / 未命中 / 自环。
- `dependencyDigest.extract` 覆盖 `heading / paragraph / list / key_value / callout / comparison_table`，含 budget 触发裁剪。
- `readinessAdapter` 把 `TaskReadinessInfoItem` 转换后 `optionQuestion / options / inputPlaceholder / value` 完整保留。
- `resolveAdmitDecision` 不接受 instance；`resolveExecutionContext` 必须有 instance。
- **契约测试**：`resolveAdmitDecision` 调用栈中不应出现任何 LLM 客户端调用（mock OpenAI/Claude SDK 并断言未被调用），确保 admit gate 同步性。

**集成验证**：
1. 用 `conv-new-1779009317391` 的 task-2 重放：context.dependencies[0].digest.userDecision 含上海等已确认城市；新 prompt.md 含"依赖任务结论"区块；执行后 task-2 不再 awaiting_user。**注**：若该 conversation fixture 已被清理，需在执行前替换为同等结构的新 fixture。
2. 上游 `failed` 时 scheduler 调一次 `setTaskAutoRunDisabled(true)`，下一轮 scheduler tick 不再尝试，[task_blocked_by_dependency] 仅出现一次。
3. 构造 `task-A → task-B → task-A` 闭环：`detectCycle` 命中后两个 task 都被禁用，[task_blocked_by_cycle] 仅出现一次，循环不再打日志。
4. **Multi-agent 回归**：在多 agent 路径下执行 task-2，Presenter prompt 同样含"依赖任务结论"区块。
5. **Route 重复入队回归**：依次 POST `/api/goals/tasks/execute` 两次（第一次 admit blocked、第二次依赖已就绪），第一次返回 409 且不写入 instance / prompt.md / runtime job；第二次正常 queued。
6. **existing-job 短路回归**：当 existing job 处于 `queued` 而 admit blocked 时，runtime job 经 `markRuntimeJobAwaiting` 被打成 `awaiting_user` 并带 blocker，避免脏 queued。
7. **前端 409 处理回归**：UI 触发依赖未就绪的执行，看到 awaiting 渲染或至少 toast 显示 `blockers[0].message`，**不**出现"点击 → 静默失败"。
8. **回归无依赖任务**：prompt 输出"无依赖任务"，文件系统不创建 `dependencies/`。
9. `pnpm lint`、`pnpm build`、现有 e2e 测试通过。

## Why this is architecturally right

1. **单一事实源**：scheduler / route / runner / prompt / multi-agent presenter / UI 全部读 `TaskExecutionContext`。
2. **领域内聚**：依赖图、digest 抽取、readiness adapter、blocker 文案、workspace 物化集中在 `taskExecution/` 一个模块。
3. **去掉旧路径而不是叠加**：删除 `dependenciesMet`、`formatTaskDependencies`，禁止双轨。
4. **Admit / Execution 分层**：admit 同步无 LLM，execution 才允许 LLM judge，避免 scheduler 主循环阻塞。
5. **Token 预算可控**：digest 抽取支持 `comparison_table / list / key_value`，避免上游"城市对比"主信息丢失。
6. **可扩展**：未来要把"会话已收集偏好 / runtime 资源约束 / 用户档案"接入执行链路，只需扩 Context schema。
7. **可调试**：Runner 阶段每次都落盘 `context.json`，重放和排障不再依赖反推 prompt。
8. **不假装零改动**：UI 跳转能力作为后续增量明示，不在本方案隐式承诺；前端 409 处理作为本方案必交付项明确列出。

## Assumptions & Decisions

- 不引入 SQLite schema 变更：Context 即时计算 + 文件物化。
- Resolver 不把 trajectory 塞进 prompt：默认只暴露 digest 与 `resultPointer`。
- 依赖配置缺失（id 找不到任何任务） → `missing` blocker，severity=block，立即 fail-fast 而不是 defer。
- `resolveAdmitDecision` 与 `resolveExecutionContext` 在 dependencies / readiness 部分必须语义等价，靠共用底层函数保证。
- `conversationId` 一律由调用方传入；Goal 类型上没有 `conversationId`，方案不假设其存在。
- `subGoal` 在两个 Resolver 入参中均为必填，prompt / Presenter / telemetry 都依赖 `subGoal.id / subGoal.title`。
- `setTaskAutoRunDisabled` 是 scheduler 唯一允许写入 `autoRunDisabled` 的入口；其它路径不改动。
- `markRuntimeJobAwaiting(jobId, blocker)` 是 runtime job 写入 awaiting 状态的唯一入口；如果当前仓库没有该函数，本方案补齐，不允许内联手写 SQL。
- Telemetry 仅以 message 前缀分类，不引入新枚举字段，避免对现有日志表 schema 漂移；`[task_admit]` 默认关闭，避免成功路径噪音。
- `DependencyDigest` 字段路径以实施时 `src/types/kiki.ts` 中 `TaskInstance.result` schema 为准，方案仅规约抽取意图。
- 集成测试中 `conv-new-1779009317391` fixture 若被清理，需替换为同等结构的新 fixture。
- UI 跳转能力（`navigate_task`）作为后续增量小步落地，不在本方案实现；前端 409 处理（识别并渲染 awaiting / toast 显示 blocker message）是本方案必交付项。

## Verification Steps

见 §9 Tests，按顺序执行：单测（含 admit 无 LLM 契约测试） → conv-new-1779009317391 task-2 重放 → multi-agent 回归 → route 重复入队 / existing-job 短路 → 前端 409 处理 → cycle / failed 回归 → 无依赖任务回归 → lint/build。
