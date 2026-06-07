# 任务内容规格（Task Spec）生成 PRD

## 1. 背景与问题

当前任务执行 prompt 在 `buildGoalTaskRunnerPrompt`（`src/lib/server/goalTaskPrompt.ts`）拼装。整段 prompt 中约 90% 是对所有任务通用的框架（输出格式、协作规则、JSON schema、验收规则、模板 A/B），真正描述“这个任务该做什么”的只有两个一句话字段：

- `task.description`
- `task.executionObjective`

而在 `src/lib/server/goalPlanning/taskCompiler.ts` 中：

```ts
const description = draft.objective;
executionObjective: description, // 与 description 完全相同，无增量
```

`executionObjective` 只是 `description` 的复制。Agent 实际拿到的“任务内容”就是规划阶段一句 `objective`，缺少任务目标、范围、执行要求、约束、交付物、验收标准等关键规格。导致 Agent 自由发挥、输出浅而飘、经常跑偏或需要追问。

### 目标

在**任务生成时**，把一句话的“任务主题”一次性扩写成一份**完整、清晰、可被执行 Agent 直接消费的「任务内容规格」**（目标 / 范围 / 执行要求 / 约束 / 交付物 / 验收标准 / 关键假设），随任务定义一并落库。

衡量标准：执行 Agent 仅凭该规格（无需追问）即可产出与用户真实预期一致的结果。

### 关键范围调整（相对前版）

1. **只在任务生成时产出**，不做“首次执行懒生成”。执行期直接读已落库的规格。
2. 规划编排由 **5 个 agent 扩展为 6 个**，新增「任务要求扩写 Agent（Spec Writer）」，作为 Saga 第 6 步。
3. **tick 增量新增任务**（ThreadRunner → `dispatch_task` → `create_task`）也走**同一个** Spec Writer 执行单元生成规格，不能漏、也不能另起一套实现。

### 非目标

- 不改写通用输出格式 / JSON schema / 验收规则。
- 不替执行：规格只描述“任务内容与要求”，不产出任务的最终答案/成品。
- 不改变任务调度、并发、状态机逻辑。
- 执行期不再触发 LLM 生成规格（与前版懒生成方案的核心差异）。

## 2. 两条生成路径与“规格随任务对象贯穿”的落库策略

系统中新增任务有两条**独立**的落库链路，它们落库的函数并不相同。**“统一”落在唯一的 `runSpecWriter` 执行单元（同一套 prompt / 调用 / 降级），而不是落在同一个落库函数。**

| 路径 | 入口 | 真实落库链路 | 本方案改动 |
|---|---|---|---|
| 规划初始化 | `runTopicInitSaga`（6 步 Saga）→ 产出 `GoalBreakdownDraft` → 用户确认 → `commitGoalDraftToStores` → `buildGoalFromDraft` → `createGoalCommand`（整目标创建） | Planner 产 Task 草稿，无规格；落库不经过 `create_task` | Saga 第 6 步 `spec` 调 `runSpecWriter`（批量），结果按 **saga 内部 taskId** join 进定稿 plan 的 Task，写入草稿 task 的 `taskSpec`，随对象贯穿 draft 链路落库 |
| tick 增量 | `ThreadRunner.tick` → `dispatchTaskFromThread` → `applyTopicCommand({type:"create_task"})` → `goalCommandService.createTask` | 直接 `buildTaskCommandInput` 落库，无规格 | 落库前调用同一个 `runSpecWriter`（单条），挂到 `TaskCommandInput.taskSpec`，`createTask` 透传到 `Task.taskSpec` |

### 2.1 为什么不能“按 taskId 回写已落库 Task”

规划路径的 taskId 在落库前会被**重写两次**：

1. `sagaDraftAdapter.normalizeTask`：`id = String(record.id ?? index+1)`（顺序号覆盖）。
2. `buildGoalFromDraft`（`src/lib/goalFactory.ts`）：`createOpaqueId("task")`（换成最终随机 id）。

因此 saga 内部生成规格时持有的 taskId，到最终落库的 `Task.id` 已不一致，**无法靠 taskId 关联回写**。

**解决：让 `taskSpec` 作为字段挂在 task 对象本身，随对象一路传递**——只在 saga 内 id 仍一致的那一刻做一次 join（把 `artifacts.specs[内部taskId].content` 写入定稿 plan 对应 task 的 `taskSpec`），此后 `taskSpec` 随 `GoalBreakdownDraft` → `buildGoalFromDraft` → `Goal` 透传，不再依赖 id 对齐。

落库一致性由“两条路径共用 `runSpecWriter`”保证；字段贯穿由 `GoalBreakdownDraft.tasks[].taskSpec`、`buildGoalFromDraft`、`TaskCommandInput.taskSpec`、`createTask` 这几个透传点保证。

## 3. 数据模型（SSOT）

在 `Task` 上新增字段 `taskSpec`，并让它贯穿 draft 与命令输入：

```ts
type TaskSpec = {
  /** 任务内容规格 Markdown 正文（目标/范围/执行要求/约束/交付物/验收标准/关键假设） */
  content: string;
  /** 生成时间 ISO */
  generatedAt: string;
  /** 基于哪一版任务定义生成，用于判定 stale */
  sourceRevision: string;
  /** 任务定义被 amend 后置 true，提示规格可能过期（P1 处理重算） */
  stale?: boolean;
};

type Task = {
  // ...existing
  taskSpec?: TaskSpec;
};
```

字段贯穿点（均为可选，旧数据/降级时缺省）：

- `GoalBreakdownDraft.subGoals[].tasks[]` 增 `taskSpec?`（规划路径透传载体）。
- `goalCommandService` 的 `TaskCommandInput` 增 `taskSpec?`（tick 路径透传载体）。

字段语义：

- `sourceRevision`：对任务定义关键字段（title/description/expectedOutcome/expectedResult/collaboration/triggerRule）做稳定哈希得到。
- `stale`：本期（P0）只在 `amend_task` / `update_task` 命中定义字段时置位并在 UI/日志提示；自动重算放 P1，避免 P0 把执行期重新拉回 LLM 生成。

## 4. 统一的 Spec Writer 执行单元（`runSpecWriter`）

### 4.1 定位

`runSpecWriter` 是唯一的“任务草稿 → 任务规格”执行单元，被规划 saga 与 tick 两条路径共用。它不属于 saga 内部状态机，而是一个独立可调用的 agent 执行函数（类比 `goal_task` / `thread_runner` 这类独立 agent_run，而非 saga 专属角色）。

新增 `AgentRunRole` 枚举值 `"spec_writer"`（`src/types/agentRuntime.ts`）。

### 4.2 接口

```ts
export async function runSpecWriter(input: {
  /** 待扩写的任务草稿（长度可为 1；tick 即单条）。taskId 仅用于本批结果对齐。 */
  tasks: Array<{
    taskId: string;
    title: string;
    description: string;
    expectedOutcome: string;
    taskType: "repeat" | "one_shot";
    triggerRule?: string;
    expectedResult?: TaskExpectedResult;
    collaboration?: TaskCollaboration;
  }>;
  /** 关联上下文：目标/子目标，用于 prompt 与 agent_run 归属。 */
  goalContext: { goalTitle: string; goalSummary?: string; subGoalTitle?: string };
  /** agent_run 关联字段：saga 路径传 sagaInstanceId；tick 路径传 threadId/taskId。 */
  attribution: { topicId: string; sagaInstanceId?: string; threadId?: string; taskId?: string };
  /** 复用方注入 invoke，便于测试 mock 与默认 wiring 复用。 */
  invoke: LlmInvoke;
}): Promise<{
  specs: Array<{ taskId: string; content: string }>;
  degraded: boolean;
}>;
```

行为：

- 内部 `createAgentRun({ role: "spec_writer", ...attribution })` + `executeAgentRun`。
- prompt 由 `buildTaskSpecPrompt(tasks, goalContext)`（§6）构造，要求模型对传入的 Task 列表逐个产出规格，输出 `{ specs: [{taskId, content}] }`。
- 解析后按入参 `taskId` 对齐；缺失某条时该条不返回（部分降级），调用方按 taskId 自行判断。
- 整体失败（解析失败 / invoke 抛错）返回 `{ specs: [], degraded: true }`，由调用方决定“无规格落库”。
- `agent_runs` 表的 `sagaInstanceId` / `threadId` / `taskId` 均为可选独立字段，所以 saga 与 tick 都能获得完整可观测性，差异仅是关联 id 不同。批量与单条仅是输入条数差异（tick 即 `tasks.length === 1`），不构成两套实现的理由。

> `taskId` 在两条路径里只是**本批结果对齐键**，不要求与最终落库 `Task.id` 相同：saga 用 saga 内部 plan task id，tick 单条可用占位键（如 `"0"`）后按下标取 `specs[0]`。

### 4.3 saga 接入（`topicInitSaga.ts` + `runTopicInitSagaDefaults.ts` + `sagaDraftAdapter.ts`）

现有顺序：`interview → plan → (critic ↔ refine) → present`。新增 `spec` 步，插在 **Critic 接受之后、Presenter 之前**：

```
interview → plan → (critic ↔ refine) → spec → present
```

理由：必须等 Critic/Refiner 把草稿定稿后再扩写，否则草稿被 Refiner 改动会让规格失效。

- `TopicInitSagaStep` 增 `"spec"`。
- 编排器在该步从**定稿 plan**（`refinedPlan ?? plan`）抽出 Task 列表。**对齐键用 subGoal 维度复合键 `${subGoalId}#${taskId|index}`**——因为 plan task 的 `id`/`index` 只在子目标内唯一，跨子目标裸用会碰撞。`runSpecWriter(tasks=本批全部)` 的结果写入 `artifacts.specs`（复合键 → content）。
- **join 时机（关键）**：`sagaDraftAdapter.normalizeTask` 在把 plan task 转成 `GoalBreakdownDraft` task 时，用**同一个复合键**（subGoal id + 该 task 在 plan 中的 id/index）从 `artifacts.specs` 取出 content，组装成 `TaskSpec` 写进 draft task 的 `taskSpec`。这是 id 仍一致的唯一时刻；此后 `taskSpec` 随对象贯穿。`normalizeSubGoals` 需把 subGoal id / task 原始 id 一并传入 `normalizeTask` 以构造同形复合键。
- `buildGoalFromDraft`（`src/lib/goalFactory.ts`）在构造最终 `Task` 时透传 `taskItem.taskSpec → Task.taskSpec`（id 在此被重写为 opaque id，但 taskSpec 随对象走，不受影响）。
- 失败降级：`runSpecWriter` 返回 `degraded` 或某条缺失时，对应 draft task 的 `taskSpec` 留空，saga **不**失败，继续走 Presenter，记录告警事件。
- specWriter 不进入 Critic↔Refiner 循环，是一次性步骤；本身失败只降级不重试（规格是增强项，不阻断规划主干）。
- 默认 wiring：`createDefaultTopicInitSagaInvokes` 提供 spec 用的 `createClaudeJsonInvoke`（`degradedFallback` 返回 `{ specs: [] }`）。

> 已知 P0 局限：规划路径的规格在**用户确认前**生成。若用户在确认 UI 中编辑/增删任务，已生成的规格可能与改后定义不完全一致。P0 接受该局限（规格为增强项，且确认后 `amend_task` 会置 `stale`）；自动重算/编辑联动放 P1。本期不调整 saga 第 6 步的生成时机。

### 4.4 tick 接入（`dispatchTaskFromThread.ts` + invoke 透传链）

在 `buildTaskCommandInput(draft)` 之后、`applyTopicCommand({ type: "create_task" })` 之前：

1. 调用 `runSpecWriter({ tasks: [单条 draft], goalContext, attribution: { topicId, threadId }, invoke })`。
2. 取 `specs[0].content` 组装 `TaskSpec` 挂到 `TaskCommandInput.taskSpec`。
3. `degraded` 或为空时 `taskSpec` 留空，记录告警，不阻断 tick 派发。
4. `createTask` 透传 `taskSpec → Task.taskSpec`。

**invoke 透传链改造（必须，当前缺口）**：tick 调用链当前没有把 `invoke` 下沉到 dispatch callback。需补：

- `dispatchTaskFromThread(request, { idempotencyKey, invoke })`：新增 `invoke` 入参。
- `buildDispatchTask(frameStartedAt, invoke)`（`threadLoopCallbacks.ts`）：闭包捕获 invoke 并透传。
- `buildThreadLoopFrameCallbacks(frameStartedAt, invoke)`：把 daemon 注入的 `thread_runner` invoke 透传给 `buildDispatchTask`。
- `threadLoopDaemon.tickOnce`：`buildCallbacks(now)` 改为 `buildCallbacks(now, deps.invoke)`，把已有的 `buildThreadRunnerInvoke()` 产物下沉（复用同一个 invoke，无需新建）。

tick 路径不需要 saga，`runSpecWriter` 独立创建 `spec_writer` agent_run（`sagaInstanceId` 留空），可观测性与 saga 路径一致。

## 5. 注入到执行 prompt

`goalTaskPrompt.ts` 在 `# Dynamic Context` 的“任务执行目标”下方插入 `## 任务内容规格` 区块：有 `task.taskSpec.content` 时注入正文；无（旧任务 / 降级）时回退到现状（仅 description）。执行期不再触发任何 LLM 生成。

## 6. 规格生成 Prompt（核心）

设计定位：“任务规格设计师”，把**规划阶段已生成的任务定义**扩写成一份面向**后台执行 Agent**的《任务内容规格》，不执行任务、不产出成品。

适配我们系统的关键约束：

1. **验收标准对齐 SSOT，不另造**：只能细化/拆解系统已有 `completionCriteria`，不得新增、放宽或替换。`completionCriteria` / `requiredBlocks` 仍是唯一真值源。
2. **交付物形态服从系统声明**：产出区域与格式由系统的 `surfaces / primaryFormat / requiredBlocks / presentation` 决定，规格只补“内容结构”。
3. **协作类任务不替用户假设**：只对“不影响是否需要用户介入判定”的缺口做合理假设；需用户提供的关键字段标注“执行时需向用户确认”。
4. **适配周期任务**：`repeat` 任务描述“每次执行交付什么”，而非一次性终态。

`{{TOPIC}}` / `{{CONTEXT}}` 映射：

- `{{TOPIC}}` = 任务标题 + 任务描述 + 预期产出
- `{{CONTEXT}}` = 任务类型 / 触发规则 / 完成标准(completionCriteria) / 必须包含内容块(requiredBlocks) / 产出呈现区域(surfaces+presentation) / 协作要求(mode+需用户提供字段) / 同批次相关任务 / 用户上下文（任一为空则省略对应子项）

`buildTaskSpecPrompt` 统一构造：外层要求模型对传入的 Task 列表逐个产出规格、输出 `{ specs: [{taskId, content}] }` JSON（列表长度为 1 时即 tick 单条）。每个 `content` 是带以下结构的 Markdown 规格正文：

```text
# 角色
你是一名"任务规格设计师"。你的职责不是执行任务，而是把一个【已规划出的任务定义】扩写成一份完整、清晰、可被【后台执行 Agent】直接消费的【任务内容规格】。质量的唯一衡量标准是：执行 Agent 仅凭你的规格（无需追问）就能产出与用户真实预期一致的结果。

注意：你面向的读者是执行 Agent，不是终端用户；不要与用户对话，不要寒暄。

# 输入
- 任务主题：{{TOPIC}}
- 系统已确定的约束与上下文（权威，不可推翻）：{{CONTEXT}}

# 工作步骤（在内部完成，不要输出过程）
1. 意图还原：用一句话复述这个任务"真正想要的结果是什么"，识别隐含目标。
2. 任务分类：判断任务类型（写作/编码/调研/分析/设计/运维/数据处理…），按类型决定该强调的执行要求与方法，不要对所有任务套同一种内容。
3. 缺口识别：列出"未明确但影响结果"的关键变量（受众、范围、深度、方法、数据来源等）。
4. 缺口处理（区分两类，不可一刀切）：
   - 不影响"是否需要用户介入"判定的缺口：给出最常见、最合理的默认假设，并显式写入「关键假设」。
   - 属于协作要求中需用户提供的关键字段：不要假设，标注为"执行时需向用户确认"，写入「关键假设」并注明。
5. 边界界定：明确"做什么"和"明确不做什么"，防止 Agent 过度发挥或跑偏。
6. 验收前置：以系统给定的完成标准(completionCriteria)为准绳，将其细化成可逐条判定的验收项。

# 输出格式（严格按此结构，使用 Markdown，全文中文，总篇幅不超过 800 字）
## 任务目标
- 一段话说明本任务最终要交付什么、解决什么问题。可衡量、可验证。
- 若为周期任务（repeat），说明"每次执行"交付什么，而非一次性终态。

## 执行要求 / 步骤
- 分点列出关键步骤或必须满足的要求（按逻辑或优先级排序）。
- 偏过程型任务给"步骤"，偏标准型任务给"要求清单"。
- 只写能改变执行 Agent 行为的方法与要点，不复述目标信息，不堆正确的废话。

## 范围
- ✅ 包含：明确纳入的工作项
- 🚫 不包含：明确排除、避免发散的部分

## 交付物结构
- 在系统已声明的产出呈现区域与格式之内，补充内容应有的结构与组织方式。
- 不得另行指定文件格式或新增产出形态（呈现区域与主格式以系统约束为准）。

## 验收标准（细化自系统完成标准）
- 把系统给定的 completionCriteria 细化为可勾选的 checklist，每条都能被 yes/no 判定。
- 只能细化、拆解、明确化，不得新增放宽或替换系统完成标准；如有必须包含的内容块(requiredBlocks)，逐项列入。
- 避免"做得好""高质量"这类无法验证的措辞。

## 关键假设
- 列出第 4 步得到的所有假设；属于"执行时需向用户确认"的，单独标注。
- 提示："如有不符，请修正任务定义后重新执行。"

# 硬性规则
- 自包含：不依赖任何未在规格或系统上下文中写明的信息。
- 尊重权威：系统上下文（完成标准、必须内容块、呈现区域、协作要求）为权威，规格只能在其之内细化，不可推翻或放宽。
- 协作优先：涉及需用户提供的关键输入时，不用假设替代，标注为需确认。
- 可验证：目标与验收标准必须客观、可判定，杜绝模糊承诺。
- 不替执行：只产出"任务内容规格"，不直接给出任务的最终答案/成品，不进行检索。
- 适配类型：根据任务类型调整内容，不要千篇一律。
- 吸收反馈：上下文若含用户历史反馈或新增要求，必须显式落进范围、执行要求、验收标准，不得遗漏。
```

注：`{{TOPIC}}` / `{{CONTEXT}}` 由 `buildTaskSpecPrompt` 用真实字段替换；上下文为空的子项整体省略，不要保留空占位行。

## 7. 模块与文件改造清单

| 文件 | 改动 |
|---|---|
| `src/types/kiki.ts` | 新增 `TaskSpec` 类型；`Task` 增 `taskSpec?`；`GoalBreakdownDraft.subGoals[].tasks[]` 增 `taskSpec?` |
| `src/types/agentRuntime.ts` | `AgentRunRole` 增 `"spec_writer"` |
| `src/lib/server/taskExecution/taskSpecPrompt.ts`（新增） | `buildTaskSpecPrompt(tasks, goalContext)`，§6 正文（批量，单条是其特例） |
| `src/lib/server/taskExecution/runSpecWriter.ts`（新增） | 唯一执行单元：建 `spec_writer` agent_run + 调 invoke + 解析对齐 + 降级 |
| `src/lib/server/goalPlanning/topicInitSaga.ts` | 增 `"spec"` step；Critic 后 Presenter 前调用 `runSpecWriter`；写 `artifacts.specs`（内部 taskId → content）；失败降级 |
| `src/lib/server/goalPlanning/runTopicInitSagaDefaults.ts` | 提供 spec 用 invoke（`degradedFallback` 返回 `{ specs: [] }`） |
| `src/lib/server/goalPlanning/sagaDraftAdapter.ts` | `normalizeTask` 按内部 taskId 从 `artifacts.specs` join，写入 draft task 的 `taskSpec`（id 一致的唯一时刻） |
| `src/lib/goalFactory.ts` | `buildGoalFromDraft` 透传 `taskItem.taskSpec → Task.taskSpec`（id 重写不影响随对象传递） |
| `src/lib/server/services/dispatchTaskFromThread.ts` | 新增 `invoke` 入参；落库前调用 `runSpecWriter`（单条），挂 `TaskCommandInput.taskSpec`，失败降级 |
| `src/lib/server/thread/threadLoopCallbacks.ts` | `buildThreadLoopFrameCallbacks(frameStartedAt, invoke)` / `buildDispatchTask(frameStartedAt, invoke)` 透传 invoke 到 dispatch |
| `src/lib/server/scheduler/threadLoopDaemon.ts` | `buildCallbacks(now, deps.invoke)`，复用现有 `thread_runner` invoke 下沉到 dispatch callback |
| `src/lib/server/services/goalCommandService.ts` | `TaskCommandInput` 增 `taskSpec?`；`createTask` 透传 `taskSpec` 到 `Task.taskSpec`；`update_task` 落库支持 `taskSpec` 与 `stale` |
| `src/lib/server/services/topicCommandService.ts` | `TaskCommandInput` 转发兼容 `taskSpec` |
| `src/lib/server/goalTaskPrompt.ts` | Dynamic Context 注入 `## 任务内容规格` |
| `src/lib/server/governance/taskPatchMerge.ts` | `amend/update` 命中定义字段时置 `taskSpec.stale=true` |
| 对应 `*.spec.ts` | `runSpecWriter` 单元（批量/单条/降级）、saga `spec` 步 + adapter join、tick 规格生成 + invoke 透传、`buildGoalFromDraft` 透传、prompt 注入、stale 置位用例 |

## 8. 验收标准

- 规划完成、用户确认落库后，新建任务的 `task.taskSpec.content` 非空，且含目标/范围/执行要求/约束/交付物/验收标准/关键假设各章节；规格内容能正确对应到对应任务（join 未错位）。
- tick 增量新建任务同样带非空 `taskSpec`，且与规划路径走同一个 `runSpecWriter`（代码层面无第二套实现）。
- 执行 prompt 含 `## 任务内容规格`，内容与任务主题强相关；验收标准为可 yes/no 判定的 checklist 且不超出系统 `completionCriteria`。
- `runSpecWriter` 失败时降级为无规格，不阻断规划或 tick。
- `amend_task` 改定义后 `taskSpec.stale=true`（P0 仅标记）。
- 执行期不产生任何规格生成相关的 LLM 调用。
- `pnpm tsc --noEmit` 与新增 spec 全绿。

## 9. 分期

- P0：数据模型 + 统一 `runSpecWriter`（saga 第 6 步 + tick 共用）+ 规格随对象贯穿落库（saga: adapter join + buildGoalFromDraft 透传；tick: createTask 透传）+ tick invoke 透传链 + 执行 prompt 注入 + stale 标记。
- P1：`stale` 自动重算（受控的执行前重生成或后台重算）；用户在确认 UI 编辑任务后的规格联动重生成；UI 展示/编辑 `taskSpec`；规格质量回流（基于验收结果反向优化）。
