# 任务内容规格（Task Spec）生成 — 技术方案（P0）

> 配套 PRD：`docs/plans/task-execution-brief-enrichment-prd.md`
> 本文把 PRD 落到具体文件、函数签名、改造行与测试。所有“现状”行号/签名基于当前代码核对。

## 0. 设计总览

一句话：新增唯一执行单元 `runSpecWriter`（草稿 → 任务规格 Markdown），被**规划 Saga 第 6 步**与 **tick 增量**两条路径共用；规格作为 `taskSpec` 字段挂在 task 对象上随对象贯穿落库；执行期 `goalTaskPrompt` 注入已落库的规格，不再触发 LLM。

数据流：

```
规划路径：
  runTopicInitSaga
    interview → plan → (critic↔refine) → [spec ★新增] → present
                                            │ runSpecWriter(tasks=定稿plan全部)
                                            ▼ artifacts.specs[compositeKey] = content
  adaptTopicInitSagaToGoalDraft
    normalizeSubGoals/normalizeTask  ──(同 compositeKey join)──► draft.task.taskSpec ★
  用户确认 → commitGoalDraftToStores → buildGoalFromDraft
    taskItem.taskSpec ──透传──► Task.taskSpec ★
    → createGoalCommand 落库

tick 路径：
  ThreadRunner.tick → dispatchTask 回调
    buildDispatchTask(frameStartedAt, invoke ★) → dispatchTaskFromThread(request, {idempotencyKey, invoke ★})
      runSpecWriter(tasks=[单条]) → TaskCommandInput.taskSpec ★
      → applyTopicCommand(create_task) → goalCommandService.createTask 透传 ★ → Task.taskSpec

执行路径：
  buildGoalTaskRunnerPrompt → Dynamic Context 注入 `## 任务内容规格`（读 task.taskSpec.content）
```

## 1. 数据模型改造（`src/types/kiki.ts`）

### 1.1 新增 `TaskSpec`

在 `Task` 定义（L367）前新增：

```ts
export type TaskSpec = {
  /** 任务内容规格 Markdown 正文 */
  content: string;
  /** 生成时间 ISO */
  generatedAt: string;
  /** 基于哪一版任务定义生成（稳定哈希），用于判定 stale */
  sourceRevision: string;
  /** 任务定义被 amend 后置 true，P0 仅标记 */
  stale?: boolean;
};
```

### 1.2 `Task` 增字段（L390 后）

```ts
  collaboration?: TaskCollaborationRequirements;
  taskSpec?: TaskSpec;   // ★新增
```

### 1.3 `GoalBreakdownDraft.subGoals[].tasks[]` 增字段（L642 后）

```ts
      collaboration?: TaskCollaborationRequirements;
      taskSpec?: TaskSpec;   // ★新增（规划路径透传载体）
```

### 1.4 `AgentRunRole` 增枚举（`src/types/agentRuntime.ts` L12-19）

```ts
export type AgentRunRole =
  | "interviewer" | "planner" | "critic" | "refiner"
  | "presenter" | "thread_runner" | "goal_task"
  | "spec_writer";   // ★新增
```

> `agent_runs` 表 schema 无需迁移：`role` 列存字符串，`sagaInstanceId`/`threadId`/`taskId` 已是可空独立列（`CreateAgentRunInput` L53-64 已全可选）。

## 2. Prompt 构造器（新增 `src/lib/server/taskExecution/taskSpecPrompt.ts`）

职责：把一批 task 草稿 + 目标上下文，构造成一段要求 LLM 逐个产出规格的 prompt，输出契约 `{ specs: [{taskId, content}] }`。

```ts
export type SpecWriterTaskInput = {
  taskId: string;          // 本批结果对齐键（非最终 Task.id）
  title: string;
  description: string;
  expectedOutcome: string;
  taskType: "repeat" | "one_shot";
  triggerRule?: string;
  expectedResult?: TaskExpectedResult;
  collaboration?: TaskCollaborationRequirements;
};

export type SpecWriterGoalContext = {
  goalTitle: string;
  goalSummary?: string;
  subGoalTitle?: string;
};

export function buildTaskSpecPrompt(
  tasks: SpecWriterTaskInput[],
  goalContext: SpecWriterGoalContext,
): string;
```

实现要点：

- 外层固定指令：「你将收到一个任务列表，对每个任务产出一份《任务内容规格》。仅输出 JSON：`{"specs":[{"taskId":"...","content":"<Markdown 规格正文>"}]}`，禁止 Markdown 代码块包裹整体 JSON。」
- 每个任务渲染 `{{TOPIC}}`（title+description+expectedOutcome）与 `{{CONTEXT}}`（taskType / triggerRule / `expectedResult.completionCriteria` / `expectedResult.requiredBlocks` / `expectedResult.surfaces`+`presentation` / `collaboration.mode`+需用户字段 / goalContext）。任一子项为空则整段省略，不留空占位行。
- 内嵌 PRD §6 的“任务规格设计师”角色正文（角色/工作步骤/输出格式/硬性规则），约束 4 条系统适配（验收对齐 SSOT、交付物服从系统声明、协作不替假设、适配周期任务）。
- 篇幅约束：每条 content ≤ 800 字、全中文。

> 单条（tick）与批量（saga）共用此构造器：tick 传 `tasks.length===1`，是批量的特例，不另写 prompt。

## 3. 执行单元（新增 `src/lib/server/taskExecution/runSpecWriter.ts`）

唯一实现。复用现有 `createAgentRun` + `executeAgentRun` + `LlmInvoke`（与 saga 各角色同构）。

```ts
import { createAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { executeAgentRun, type LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";

export type RunSpecWriterInput = {
  tasks: SpecWriterTaskInput[];
  goalContext: SpecWriterGoalContext;
  attribution: { topicId: string; sagaInstanceId?: string; threadId?: string; taskId?: string };
  invoke: LlmInvoke;
};

export type RunSpecWriterResult = {
  specs: Array<{ taskId: string; content: string }>;
  degraded: boolean;
};

export async function runSpecWriter(input: RunSpecWriterInput): Promise<RunSpecWriterResult>;
```

实现逻辑：

1. `tasks` 为空 → 直接返回 `{ specs: [], degraded: false }`（不建 agent_run）。
2. `const run = createAgentRun({ role: "spec_writer", topicId, sagaInstanceId, threadId, taskId })`（attribution 透传；缺省字段不传）。
3. `const prompt = buildTaskSpecPrompt(tasks, goalContext)`。
4. `const result = await executeAgentRun({ agentRunId: run.id, prompt, context: { role: "spec_writer", ...attribution }, invoke })`。
5. 解析 `result.parsed?.specs`：
   - 过滤出 `{ taskId: string, content: 非空 string }`，且 `taskId` 命中入参集合。
   - 部分缺失 → 仅返回命中的，`degraded` 取决于是否全部命中（缺任意一条置 `degraded:true`，让调用方知晓有降级）。
6. `executeAgentRun` 抛错（invoke 失败）→ `try/catch` 兜底返回 `{ specs: [], degraded: true }`（executeAgentRun 内部已 append error event 并 markFailed，此处不重复抛）。

> 与 saga `runRole`（topicInitSaga.ts L128-147）保持同构：同样是 `createAgentRun` → `executeAgentRun`，差异仅是 role 与 attribution。

## 4. 规划路径接入

### 4.1 Saga 第 6 步（`src/lib/server/goalPlanning/topicInitSaga.ts`）

改动点：

1. `TopicInitSagaStep`（L33-39）增 `"spec"`：
   ```ts
   export type TopicInitSagaStep =
     | "interview" | "plan" | "critic" | "refine" | "spec" | "present" | "completed";
   ```
2. **只在 `invokes`（L69-75）增 `spec: LlmInvoke`，`prompts` 不增 spec**：
   ```ts
   invokes: { interview; plan; critic; refine; spec: LlmInvoke; present };
   ```
   > 理由：spec 步不走 `runRole`（topicInitSaga.ts L128-147），而是在编排器里直接调 `runSpecWriter`——它自己建 agent_run、自己用 `buildTaskSpecPrompt` 构造 prompt。因此 prompt 不需要由 `prompts.spec` 注入，只需把 `LlmInvoke` 通过 `invokes.spec` 透传给 `runSpecWriter`。编排器从定稿 plan 自行抽 task 列表（见 4.2）。
3. `TopicInitSagaResult.artifacts`（L85-91）增：
   ```ts
   specs?: Record<string, string>;   // compositeKey -> content
   ```
4. 编排器在 Presenter（L269）**之前**插入 spec 步：
   ```ts
   // --- 5b. Spec Writer（定稿后、展示前）---
   try {
     advanceSaga({ sagaInstanceId, toStep: "spec" });
     const specTasks = extractSpecTasksFromPlan(currentPlan); // 见 4.2
     if (specTasks.length > 0) {
       const specResult = await runSpecWriter({
         tasks: specTasks,
         goalContext: { goalTitle: ..., goalSummary: ..., subGoalTitle: undefined },
         attribution: { topicId: input.topicId, sagaInstanceId: input.sagaInstanceId },
         invoke: input.invokes.spec,
       });
       artifacts.specs = Object.fromEntries(specResult.specs.map(s => [s.taskId, s.content]));
     }
   } catch {
     // 规格是增强项：失败仅告警降级，不 failSaga，继续走 Presenter
   }
   ```
   关键：**spec 步包在独立 try 内，catch 不调用 `failSaga`**（区别于其他 5 步）——规格失败不能阻断规划主干。

### 4.2 复合键与 task 抽取（`extractSpecTasksFromPlan`，topicInitSaga.ts 内私有函数）

`currentPlan`（定稿 plan，形如 `{ subGoals: [{ id, tasks: [{id, title, ...}] }] }`）拍平为 `SpecWriterTaskInput[]`：

- **复合键** `taskId = ${subGoalId}#${taskRawId}`，其中 `subGoalId = String(record.id ?? subIndex+1)`、`taskRawId = String(task.id ?? task.index ?? taskIndex+1)`，与 `sagaDraftAdapter` 的 id 规则**严格同形**（见 4.3 改造）。
- 字段映射对齐 `normalizeTask`（sagaDraftAdapter.ts L65-91）的取值逻辑：`title/description/expectedOutcome/taskType/triggerRule`，使 spec 看到的内容与最终落库内容一致。

> 复合键解决跨子目标 task index 碰撞（裸 index 在不同子目标都从 1 开始）。

### 4.3 join 到草稿（`src/lib/server/goalPlanning/sagaDraftAdapter.ts`）

`normalizeTask`（L65-91）与 `normalizeSubGoals`（L93-125）改造：把 `specs`（复合键 → content）与 subGoalId 透传进 `normalizeTask`，按**同形复合键**取 content 组 `TaskSpec`：

```ts
function normalizeTask(
  value: unknown,
  index: number,
  ctx: { subGoalId: string; specs?: Record<string, string> },   // ★新增 ctx
): GoalBreakdownDraft["subGoals"][number]["tasks"][number] {
  const record = asRecord(value) ?? {};
  const rawId = String(record.id ?? record.index ?? index + 1);  // 与现状 L79 一致
  const compositeKey = `${ctx.subGoalId}#${rawId}`;
  const specContent = ctx.specs?.[compositeKey];
  // ...现有字段...
  return {
    id: rawId,
    // ...现有字段...
    taskSpec: specContent
      ? { content: specContent, generatedAt: new Date().toISOString(), sourceRevision: computeSourceRevision(record) }
      : undefined,
  };
}
```

- `normalizeSubGoals` 在 `rawTasks.map` 时把 `{ subGoalId: id, specs }` 传入（`id` 即 L105 的 `String(record.id ?? index+1)`，与 4.2 同形）。
- `adaptTopicInitSagaToGoalDraft`（L131）从 `input.result.artifacts.specs` 取 specs，向下透传给 `normalizeSubGoals`。
- `computeSourceRevision(record)`：对 title/description/expectedOutcome/triggerRule 等定义字段做稳定哈希（复用 `createHash` 思路，与 goalCommandService 一致）。

### 4.4 透传到最终 Task（`src/lib/goalFactory.ts`）

`buildGoalFromDraft` 的 task map（L173-214）在 return 对象增：

```ts
        collaboration: taskItem.collaboration ?? collaborationFor(...),
        taskSpec: taskItem.taskSpec,   // ★透传（id 在此被 createOpaqueId 重写，taskSpec 随对象不受影响）
```

> 这是规划路径“随对象贯穿”的关键：join 发生在 id 仍一致的 `normalizeTask`，此后只透传，不再按 id 关联。

### 4.5 默认 wiring（`src/lib/server/goalPlanning/runTopicInitSagaDefaults.ts`）

- `createDefaultTopicInitSagaInvokes`（L210）的返回对象增 `spec`：
  ```ts
  const spec = createClaudeJsonInvoke({
    ...baseConfig,
    validator: passthroughValidator,
    degradedFallback: () => ({ specs: [] }),   // 截断/解析失败 → 空规格降级
  });
  return { interview, plan, critic, refine, present, spec };
  ```
- `buildDefaultTopicInitSagaPrompts`：**不新增** spec prompt（按 4.1 决策，spec 的 prompt 由 runSpecWriter 内部 `buildTaskSpecPrompt` 构造）。`runTopicInitSaga` 调用处（L357）不变（invokes 已含 spec）。
- `createDefaultTopicInitSagaInvokes` 已持有 `cwd`/`runtimeEnv`（L211 入参），plan route（route.ts L46-47）已传入，无需额外改 route。

## 5. tick 路径接入

### 5.1 invoke 透传链（4 处签名改造）

| 文件 | 现状 | 改为 |
|---|---|---|
| `dispatchTaskFromThread.ts` L113 | `dispatchTaskFromThread(request, { idempotencyKey })` | `(request, { idempotencyKey, invoke })`，`invoke` 可选 |
| `threadLoopCallbacks.ts` L204 | `buildDispatchTask(frameStartedAt)` | `buildDispatchTask(frameStartedAt, invoke?)`，闭包捕获并透传 |
| `threadLoopCallbacks.ts` L279 | `buildThreadLoopFrameCallbacks(frameStartedAt)` | `buildThreadLoopFrameCallbacks(frameStartedAt, invoke?)`，传给 buildDispatchTask |
| `threadLoopDaemon.ts` L42/L77 | `buildCallbacks(now)` | `buildCallbacks(now, deps.invoke)`；`ThreadLoopDaemonConfig.buildCallbacks` 签名加第二参 |

- `daemonRunner.ts` L108 已经 `createThreadLoopDaemon({ invoke: buildThreadRunnerInvoke() })`，`deps.invoke` 现成，下沉即可，**无需新建 invoke**。
- `invoke` 全链路设为**可选**：测试用 `buildCallbacks` 默认实现/不传 invoke 时，dispatch 走“无规格降级”，保持现有 spec 测试不破。

### 5.2 dispatchTaskFromThread 生成规格（`dispatchTaskFromThread.ts` L113-155）

在 `buildTaskCommandInput(request.taskDraft)`（L129）前插入：

```ts
let taskSpec: TaskSpec | undefined;
if (options.invoke) {
  const draft = request.taskDraft;
  const timing = inferTaskTiming(draft);
  const specResult = await runSpecWriter({
    tasks: [{
      taskId: "0",
      title: draft.title || "未命名任务",
      description: descriptionFromDraft(draft, draft.title),
      expectedOutcome: draft.deliverable || draft.title,
      taskType: timing.taskType,
      triggerRule: timing.triggerRule,
    }],
    goalContext: { goalTitle: <由 topicId 反查或用 draft 兜底> },
    attribution: { topicId: request.topicId, threadId: request.threadId },
    invoke: options.invoke,
  });
  const content = specResult.specs[0]?.content;
  if (content) {
    taskSpec = { content, generatedAt: new Date().toISOString(), sourceRevision: computeSourceRevisionFromDraft(draft) };
  }
}
```

把 `taskSpec` 挂到 `buildTaskCommandInput` 的返回（见 5.3），再随 `create_task` 落库。`degraded`/空 → `taskSpec` 留空，不阻断派发。

> goalContext.goalTitle：tick 上下文当前只有 topicId/threadId。P0 用轻量反查（已有 snapshot 读取）或退化为 draft.title 兜底，不为此引入重查链路。

### 5.3 TaskCommandInput 增 taskSpec（命令链 3 处）

`taskSpec` 需穿过命令层：

| 文件 | 改造 |
|---|---|
| `topicCommandService.ts` L31-40 `TaskCommandInput` | 增 `taskSpec?: TaskSpec` |
| `topicCommandService.ts` create_task 透传（L130-135） | `task: command.task` 已整体透传，类型放开即可 |
| `goalCommandService.ts` L15-24 `TaskCommandInput` | 增 `taskSpec?: TaskSpec` |
| `goalCommandService.ts` `createTask` L228-247 | return 增 `taskSpec: task.taskSpec` |
| `goalCommandService.ts` `normalizeTaskInput` | 透传 `taskSpec`（不规范化，原样保留） |

## 6. 执行 prompt 注入（`src/lib/server/goalTaskPrompt.ts` L204-210）

在“任务执行目标”行（L210）后插入规格区块：

```ts
任务执行目标：${task.executionObjective || task.description}
${renderTaskSpecSection(task)}
```

```ts
function renderTaskSpecSection(task: Task): string {
  if (!task.taskSpec?.content) return "";   // 旧任务/降级：回退到现状，仅 description
  return `\n## 任务内容规格\n${task.taskSpec.content}\n`;
}
```

- 无规格时返回空串，行为与现状完全一致（向后兼容旧任务）。
- 执行期**不**调用任何 LLM 生成规格。

## 7. stale 标记（`src/lib/server/governance/taskPatchMerge.ts`）

`mergeTaskPatch`（L87-99）的返回类型 `TaskCommandInputForMerge`（L7-16）增 `taskSpec?: TaskSpec`，命中定义字段时把现有 taskSpec 复制并置 `stale:true`：

```ts
export type TaskCommandInputForMerge = {
  // ...现有...
  taskSpec?: TaskSpec;
};

export function mergeTaskPatch(task: Task, patch: TaskPatch): TaskCommandInputForMerge {
  // ...现有 description/timing/expectedResult...
  const touchedDefinition =
    patch.title !== undefined || patch.description !== undefined ||
    patch.objective !== undefined || patch.expectedOutcome !== undefined ||
    patch.deliverable !== undefined || patch.expectedResult !== undefined ||
    patch.completionCriteria !== undefined || patch.requiredBlocks !== undefined ||
    patch.acceptanceCriteria !== undefined;
  const taskSpec = task.taskSpec && touchedDefinition
    ? { ...task.taskSpec, stale: true }
    : task.taskSpec;
  return { ...现有字段, taskSpec };
}
```

- 配套：`goalCommandService` `update_task`（L321-349）的 task 更新对象需透传 `taskSpec`（现状未保留，等价于丢失；P0 改为保留并接受 stale 标记）。
- P0 仅标记，不自动重算（重算入 P1）。`update_task` 后 `executionObjective` 仍按现状从 description 派生。

## 8. 文件改造清单（汇总）

| 文件 | 类型 | 核心改动 |
|---|---|---|
| `src/types/kiki.ts` | 改 | `TaskSpec` 类型；`Task.taskSpec?`；`GoalBreakdownDraft...tasks[].taskSpec?` |
| `src/types/agentRuntime.ts` | 改 | `AgentRunRole` 增 `"spec_writer"` |
| `src/lib/server/taskExecution/taskSpecPrompt.ts` | 新增 | `buildTaskSpecPrompt` + 类型 |
| `src/lib/server/taskExecution/runSpecWriter.ts` | 新增 | 唯一执行单元 |
| `src/lib/server/goalPlanning/topicInitSaga.ts` | 改 | `"spec"` step + invokes.spec + artifacts.specs + 编排器 spec 步（独立 try，失败降级）+ extractSpecTasksFromPlan |
| `src/lib/server/goalPlanning/runTopicInitSagaDefaults.ts` | 改 | `createDefaultTopicInitSagaInvokes` 增 spec invoke（degradedFallback `{specs:[]}`） |
| `src/lib/server/goalPlanning/sagaDraftAdapter.ts` | 改 | `normalizeTask`/`normalizeSubGoals` 复合键 join；`adaptTopicInitSagaToGoalDraft` 透传 specs；computeSourceRevision |
| `src/lib/goalFactory.ts` | 改 | `buildGoalFromDraft` 透传 `taskItem.taskSpec` |
| `src/lib/server/services/dispatchTaskFromThread.ts` | 改 | 入参增 invoke；落库前 runSpecWriter（单条）；taskSpec 挂 TaskCommandInput |
| `src/lib/server/thread/threadLoopCallbacks.ts` | 改 | `buildDispatchTask`/`buildThreadLoopFrameCallbacks` 透传 invoke |
| `src/lib/server/scheduler/threadLoopDaemon.ts` | 改 | `buildCallbacks(now, deps.invoke)`；config 签名加第二参 |
| `src/lib/server/services/topicCommandService.ts` | 改 | `TaskCommandInput.taskSpec?` |
| `src/lib/server/services/goalCommandService.ts` | 改 | `TaskCommandInput.taskSpec?`；createTask/normalizeTaskInput/update_task 透传 taskSpec |
| `src/lib/server/goalTaskPrompt.ts` | 改 | Dynamic Context 注入 `## 任务内容规格` |
| `src/lib/server/governance/taskPatchMerge.ts` | 改 | 命中定义字段置 `taskSpec.stale=true` |

## 9. 测试计划

| 测试文件 | 用例 |
|---|---|
| `runSpecWriter.spec.ts`（新增） | 批量正常返回；部分缺失 → degraded; invoke 抛错 → `{specs:[],degraded:true}` 不抛；空 tasks 不建 agent_run |
| `taskSpecPrompt.spec.ts`（新增） | 含全字段渲染；空子项省略；单条与批量产出契约一致 |
| `topicInitSaga.spec.ts`（改） | spec 步成功 → artifacts.specs 填充；spec invoke 抛错 → saga 仍 completed（不 failSaga）、artifacts.specs 缺省 |
| `sagaDraftAdapter.spec.ts`（改） | 复合键 join 正确；跨子目标同 index 不串台；无 specs 时 taskSpec undefined |
| `goalFactory.spec.ts`（改/补） | buildGoalFromDraft 透传 taskSpec |
| `dispatchTaskFromThread.spec.ts`（改） | 传 invoke → task.taskSpec 非空；不传 invoke → 降级无规格仍创建 task；runSpecWriter degraded → 不阻断 |
| `goalTaskPrompt.spec.ts`（改/补） | 有 taskSpec 注入区块；无 taskSpec 输出与现状一致 |
| `taskPatchMerge.spec.ts`（改） | 命中定义字段 → stale=true；仅改 triggerRule 等非定义字段不置 stale（按约定确认范围） |
| `threadLoopDaemon.spec.ts`（改） | buildCallbacks 第二参 invoke 透传不破坏现有帧 |

验证命令：`pnpm tsc --noEmit` + `pnpm test:planning`（及相关 thread/governance spec）。

## 10. 分期边界

- **P0（本方案）**：§1–§9 全部。两条路径共用 runSpecWriter；规格随对象贯穿落库；执行 prompt 注入；stale 仅标记。
- **P1（不在本方案）**：stale 自动重算；用户在确认 UI 编辑任务后规格联动重生；taskSpec 的 UI 展示/编辑；规格质量回流。

## 11. 已知取舍（与 PRD 一致）

1. 规划路径规格在**用户确认前**生成；用户在确认 UI 改任务可能使规格过期，靠确认后 `amend → stale` 兜底，联动重算入 P1。本期不改 saga 第 6 步生成时机。
2. `sourceRevision` P0 仅配合 stale 标记，不触发自动重算；提前落库以免 P1 数据迁移。
3. tick 的 `goalContext.goalTitle` P0 允许 draft 兜底，不为此引入重查链路。
