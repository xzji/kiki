# Task ID 全局唯一修复计划

## Summary

本计划修复新规划任务中出现重复 `task.id` 的问题。当前根因是 `applyTaskReview()` 在每个子目标内都重新生成 `draft-task-1`、`draft-task-2` 等局部 ID，后续 `buildGoalFromDraft()` 又按这些 draft task id 构建全局 `taskIdMap`，导致不同子目标的同序号任务可能被映射成同一个正式 task opaque id。

目标是在 draft 阶段就生成全局唯一的任务 ID，并在正式构建阶段增加防御校验，避免后续再出现“点击 A 任务进入 B 任务详情”的问题。

## Current State Analysis

* `src/lib/server/goalPlanning.ts`

  * `applyTaskReview(tasks, review)` 当前只接收任务数组和 review 结果。

  * 内部使用 `draft-task-${index + 1}` 作为保留任务的新 ID。

  * 因为 `generateGoalPlanWithClaude()` 会按子目标逐个调用 `applyTaskReview()`，所以每个子目标都会重复生成 `draft-task-1`。

  * dependencies 已经通过局部 `taskIdMap` 做重写，但只在当前子目标任务集合内有效。

* `src/lib/goalFactory.ts`

  * `buildGoalFromDraft(draft)` 使用 `draft.subGoals.flatMap(... taskItem.id ...)` 建全局 `taskIdMap`。

  * 当 draft 内存在重复 task id 时，`Map` 后写覆盖前写或复用同 key，最终会让多个任务共享同一个正式 task id。

  * 当前依赖映射会过滤无法解析的依赖，但没有检测重复 task id。

* `src/mocks/goals.ts`

  * mock 版 `buildGoalFromDraft(draft)` 与真实 `goalFactory` 有一套相似逻辑。

  * 需要同步加防御，避免 mock/dev 演示数据掩盖真实问题或制造同类假象。

* `src/lib/opaqueIds.ts`

  * `createOpaqueId("task")` 已经包含 `Date.now()` 和 `Math.random()`，正式 opaque id 本身有时间和随机性。

  * 但当前重复并不是 `createOpaqueId()` 生成冲突，而是 draft 阶段重复 key 导致正式构建时同一个 key 被复用。

  * 因此修复重点应放在 draft task id 的唯一性和构建阶段重复防御，而不是只改 `createOpaqueId()`。

## Proposed Changes

### 1. 为规划生成引入稳定的 task id 批次种子

文件：`src/lib/server/goalPlanning.ts`

做法：

* 在 `generateGoalPlanWithClaude()` 中复用已有的 `planStartedAt = Date.now()` 作为本次规划的时间变量。

* 派生一个字符串种子，例如：

  * `const taskIdBatchSeed = planStartedAt.toString(36);`

* 在调用 `applyTaskReview()` 时传入子目标作用域和时间种子：

  * `subGoalDraftId: draft-subgoal-${subGoal.id}`

  * `subGoalIndex: subGoalIndex + 1`

  * `taskIdBatchSeed`

原因：

* 时间变量满足“除了目标作用域外，再加上时间变量生成唯一”的要求。

* 使用本次规划开始时间而不是每个任务单独 `Date.now()`，可以让同一次规划内 ID 规则可读、可追踪。

* 子目标作用域确保不同子目标不会重复。

### 2. 改造 `applyTaskReview()` 的 draft task id 生成规则

文件：`src/lib/server/goalPlanning.ts`

将签名从：

```ts
function applyTaskReview(
  tasks: TaskGenerationPayload["tasks"],
  review: TaskReviewPayload,
): DraftTask[]
```

改为：

```ts
function applyTaskReview(
  tasks: TaskGenerationPayload["tasks"],
  review: TaskReviewPayload,
  context: {
    taskIdBatchSeed: string;
    subGoalDraftId: string;
    subGoalIndex: number;
  },
): DraftTask[]
```

新增 helper：

```ts
function buildDraftTaskId(input: {
  taskIdBatchSeed: string;
  subGoalDraftId: string;
  subGoalIndex: number;
  taskIndex: number;
  sourceTaskId?: string;
}) {
  const sourcePart = sanitizeDraftIdPart(input.sourceTaskId ?? `task-${input.taskIndex}`);
  return [
    "draft-task",
    input.taskIdBatchSeed,
    `sg${input.subGoalIndex}`,
    sanitizeDraftIdPart(input.subGoalDraftId),
    `t${input.taskIndex}`,
    sourcePart,
  ].join("-");
}
```

生成示例：

* `draft-task-m8z3k2-sg2-draft-subgoal-2-t1-task-1`

* `draft-task-m8z3k2-sg2-draft-subgoal-2-t2-task-2`

注意事项：

* `sanitizeDraftIdPart()` 只保留小写字母、数字和 `-`，避免 LLM 生成的 task id 带空格、中文或特殊符号。

* 对 retainedTasks 建立 `source task id -> new draft task id` 映射。

* `dependencies` 继续通过该映射重写。

* review 删除的任务对应依赖继续过滤，不把不存在的依赖写入 draft。

* fallback 的 firstTask 也必须使用同一套 `buildDraftTaskId()`，不能继续写死 `"draft-task-1"`。

### 3. 在正式 goal 构建阶段增加重复检测和兜底唯一化

文件：`src/lib/goalFactory.ts`

新增 helper：

```ts
function buildTaskIdMap(draft: GoalBreakdownDraft) {
  const taskIdMap = new Map<string, string>();
  const seen = new Set<string>();

  for (const subGoal of draft.subGoals) {
    for (const taskItem of subGoal.tasks) {
      const scopedDraftTaskId = `${subGoal.id}:${taskItem.id}`;
      const mapKey = seen.has(taskItem.id) ? scopedDraftTaskId : taskItem.id;
      seen.add(taskItem.id);
      taskIdMap.set(mapKey, createOpaqueId("task"));
    }
  }

  return { taskIdMap, resolveTaskId };
}
```

实际实现建议更直接：

* 先扫描 `draft.subGoals[].tasks[].id`，统计重复。

* 如果无重复，保持现有 `taskItem.id -> createOpaqueId("task")` 映射。

* 如果发现重复：

  * 对重复项使用 scoped key：`${subGoal.id}:${taskItem.id}`。

  * 任务自身取 ID 时使用 `resolveTaskId(subGoal.id, taskItem.id)`。

  * 依赖映射优先解析本子目标作用域内的 `${subGoal.id}:${dependencyId}`，再解析全局唯一的 `dependencyId`。

原因：

* 新规划修复后不应再触发重复，但这里是防御层，避免旧 draft、mock draft 或未来其他入口继续制造重复。

* 不在正式数据中保留无法解析的依赖，继续维持当前过滤策略。

### 4. 同步 mock 构建路径的防御逻辑

文件：`src/mocks/goals.ts`

做法：

* 将 `src/lib/goalFactory.ts` 中的重复检测/解析逻辑同步到 mock 版 `buildGoalFromDraft()`。

* 或者提取一个共享 helper，真实与 mock 共用。

建议：

* 如果改动范围要小，先同步实现，避免引入新的模块依赖。

* 如果后续继续维护成本变高，再把 `buildTaskIdMap` 抽到 `src/lib/goalDraftIds.ts`。

### 5. 增加依赖完整性校验日志

文件：`src/lib/goalFactory.ts`

在 `buildGoalFromDraft()` 构建 task dependencies 时：

* 对每个 dependencyId 调 `resolveTaskId(...)`。

* 无法解析时过滤。

* 开发环境下可 `console.warn` 输出被过滤的依赖，包含：

  * `goalTitle`

  * `subGoal.id`

  * `taskItem.id`

  * `dependencyId`

约束：

* 不影响生产流程。

* 不把 unresolved dependency 写进正式 Goal。

### 6. 历史数据处理策略

当前修复只保证新生成的 goal 不再出现重复 task id。

历史已生成的越南目标仍然可能包含重复正式 task id，因为错误已经写入当前 workspace 数据。处理建议：

* 默认不做自动迁移，避免误改用户现有执行记录、实例、消息引用。

* 对用户当前这条异常目标，建议重新规划生成一次。

* 如果必须修历史数据，应另起独立迁移方案，统一修复：

  * goal 内重复 `task.id`

  * task instances 的 `taskId`

  * conversation message `taskRef.taskId`

  * runtime jobs / blockers / event log 中的 taskId 引用

## Assumptions & Decisions

* 决策：draft task id 同时包含时间变量和子目标作用域，而不是只依赖 `createOpaqueId()`。

* 决策：使用 `planStartedAt` 作为本次规划时间种子，保证同一轮规划内可追踪。

* 决策：依赖映射仍以 draft id 为准，不引入标题匹配，避免同名任务误连。

* 决策：无法解析的依赖继续过滤，不生成伪 task id。

* 决策：本计划不迁移历史 goal，只修复后续生成链路。

## Verification Steps

1. 静态验证

   * 检查 `applyTaskReview()` 生成的所有 `DraftTask.id` 都包含：

     * `draft-task`

     * `taskIdBatchSeed`

     * `sg${subGoalIndex}`

     * `subGoalDraftId`

     * `t${taskIndex}`

   * 检查 fallback 分支不再出现写死 `"draft-task-1"`。

2. 类型检查

   * 运行 `pnpm exec tsc --noEmit`。

3. 定向 lint

   * 运行：

     * `pnpm exec eslint src/lib/server/goalPlanning.ts src/lib/goalFactory.ts src/mocks/goals.ts`

4. 手动验证新规划

   * 新建一个包含多个子目标、每个子目标都有 2 个以上任务的目标。

   * 检查生成后的 goal 中所有 `task.id` 全局唯一。

   * 点击任意任务行，确认打开的是对应任务详情。

   * 检查依赖任务展示为正确的任务名称 + 任务 ID。

5. 回归验证依赖

   * 生成带任务依赖的目标。

   * 确认 `task.dependencies[]` 中每个 ID 都能在当前 goal 的 task 集合中找到。

   * 确认不再出现“依赖失效：当前目标里没有这个任务”。

