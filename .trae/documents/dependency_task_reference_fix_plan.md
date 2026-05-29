# 依赖任务引用与展示修复计划

## Summary

本计划修复任务详情中“依赖任务”字段展示不清晰，以及“依赖失效：当前目标里没有这个任务”的根因问题。

目标：
- “依赖任务”字段稳定展示依赖任务名称 + 任务 ID。
- 新生成的 goal 中不再出现指向不存在任务的 `task.dependencies`。
- 若历史数据或异常数据仍存在失效依赖，UI 能清晰展示“未知任务 + 原始依赖 ID + 失效原因”，避免误导。
- 保持任务执行上下文对依赖状态的阻塞能力，不绕过真实依赖问题。

## Current State Analysis

### UI 展示现状

- 任务详情页依赖展示入口在 `src/components/goal/TaskDetailBody.tsx`。
- 执行结果页也有一份依赖展示入口在 `src/components/task/ExecutionResultBody.tsx`。
- 两处都通过 `getTaskDependencyViews(goal, task)` 获取依赖展示数据。
- 当前 `TaskDependencyView` 只有 `id`、`title`、`expectedOutcome`、`statusLabel`、`reason`、`satisfied`、`missing`。
- 当依赖任务找不到时，`src/lib/taskDependencies.ts` 会返回：
  - `id = dependencyId`
  - `title = dependencyId`
  - `statusLabel = "依赖失效"`
  - `reason = "依赖配置引用了 xxx，但当前目标里没有这个任务。"`
- 因此 UI 虽然展示了“名称 + ID”，但缺失时名称和 ID 完全相同，用户看起来像只显示了 ID。

### 数据生成根因

- 任务规划 prompt 要求 Claude 输出 `task-1`、`task-2` 等任务 ID，并通过 `dependencies` 引用依赖任务。
- `src/lib/server/goalPlanning.ts` 的 `applyTaskReview()` 会将任务 ID 重写为 `draft-task-${index + 1}`。
- 但 `applyTaskReview()` 当前直接保留 `task.dependencies`，未把旧任务 ID 同步映射为新 draft task ID。
- `src/lib/goalFactory.ts` 的 `buildGoalFromDraft()` 会基于 draft task ID 创建 `taskIdMap`。
- 当 `dependencies` 仍是旧 ID（例如 `task-1`）时，`taskIdMap.get(dependencyId)` 找不到。
- 当前 fallback 是 `deriveOpaqueId("task", dependencyId)`，这会生成一个看似合法的 opaque task ID，但当前 goal 中没有这个任务。
- 最终 UI 与执行上下文都会判定依赖任务不存在。

### 运行上下文影响

- `src/lib/server/taskExecution/contextResolver.ts` 会通过 `buildTaskGraph(goal)` 查找依赖任务。
- 失效依赖会生成 `missing` blocker，阻止任务继续执行。
- 这部分行为是合理的，不能简单忽略所有失效依赖；修复重点应放在新数据不再产生失效依赖。

### 测试现状

- 当前项目没有发现现成的 `*.test.*` 单元测试文件。
- `package.json` 没有 test 脚本。
- 可用验证方式：
  - `pnpm exec tsc --noEmit`
  - 定向 `pnpm exec eslint ...`
  - 必要时用只读/临时脚本检查构建出的 draft 依赖是否可解析，但不纳入持久测试文件，除非后续明确要补测试体系。

## Proposed Changes

### 1. 修复规划 review 阶段依赖 ID 重写

文件：`src/lib/server/goalPlanning.ts`

修改位置：`applyTaskReview()`

方案：
- 在过滤/归一化任务前，先建立原始任务 ID 到新 draft 任务 ID 的映射。
- 保持当前任务 ID 重写策略：`task.id -> draft-task-${index + 1}`。
- 同步重写每个任务的 `dependencies`：
  - 如果依赖 ID 能在原始任务列表中找到，则替换为对应的新 draft task ID。
  - 如果依赖 ID 指向被 review 删除的任务，则过滤掉该依赖。
  - 如果依赖 ID 完全不在原始任务列表中，则过滤掉该依赖。
- 为避免静默吞掉问题，建议在函数内部保留可选的诊断信息输出点；若当前日志体系不适合此函数，可先不打日志，只保证不生成坏数据。

伪代码：

```ts
const retainedTasks = tasks
  .map((task, originalIndex) => ({ task, originalIndex, reviewItem: reviewMap.get(task.id) }))
  .filter(({ task, reviewItem }) => !(reviewItem && !reviewItem.aligned && reviewItem.goalContribution === "low"));

const taskIdMap = new Map(
  retainedTasks.map(({ task }, index) => [task.id, `draft-task-${index + 1}`]),
);

const normalizeDependencies = (dependencies: string[] | undefined) =>
  dependencies
    ?.map((dependencyId) => taskIdMap.get(dependencyId))
    .filter((dependencyId): dependencyId is string => Boolean(dependencyId));
```

注意：
- 这里的 `index` 应以保留后的任务列表为准，确保 draft task ID 连续。
- fallback 分支（只保留第一个任务）也需要同样处理依赖，通常应得到空数组或只保留能解析的依赖。

### 2. 修复 `buildGoalFromDraft()` 对无法解析依赖的 fallback

文件：`src/lib/goalFactory.ts`

修改位置：`buildGoalFromDraft()` 中 task dependencies 映射逻辑。

当前逻辑：

```ts
dependencies: taskItem.dependencies?.map(
  (dependencyId) => taskIdMap.get(dependencyId) ?? deriveOpaqueId("task", dependencyId),
),
```

建议改为：

```ts
dependencies: taskItem.dependencies
  ?.map((dependencyId) => taskIdMap.get(dependencyId))
  .filter((dependencyId): dependencyId is string => Boolean(dependencyId)),
```

原因：
- `deriveOpaqueId("task", dependencyId)` 适合稳定迁移已有实体 ID，不适合把未解析依赖伪造成真实任务。
- 无法解析的依赖进入正式 goal 后，会在 UI 和执行上下文中造成“当前目标里没有这个任务”的阻塞。
- 依赖缺失属于规划数据质量问题，应在构建阶段过滤或记录，而不是生成不存在的任务 ID。

兼容说明：
- 历史 goal 数据不迁移。
- 新 goal 构建不会再制造失效 opaque 依赖。
- 若历史数据仍有失效依赖，展示层仍负责清晰呈现。

### 3. 同步修复 mock 构建路径

文件：`src/mocks/goals.ts`

修改位置：mock 内部 `buildGoalFromDraft()`。

原因：
- 该文件存在与 `src/lib/goalFactory.ts` 类似的 fallback：
  - `taskIdMap.get(dependencyId) ?? deriveOpaqueId("task", dependencyId)`
- 若 dev mock 仍制造不存在依赖，会影响本地演示和回归观察。

方案：
- 与真实 `goalFactory.ts` 保持一致，只保留能解析到当前 draft 任务的依赖。

### 4. 增强依赖展示模型

文件：`src/lib/taskDependencies.ts`

建议调整 `TaskDependencyView`：

```ts
export type TaskDependencyView = {
  id: string;
  taskId: string;
  title: string;
  displayTitle: string;
  expectedOutcome: string;
  statusLabel: string;
  reason: string;
  satisfied: boolean;
  missing: boolean;
};
```

行为：
- 正常依赖：
  - `taskId = dependency.id`
  - `title = 去前缀后的任务标题`
  - `displayTitle = title`
- 缺失依赖：
  - `taskId = dependencyId`
  - `title = ""`
  - `displayTitle = "未知任务"`
  - `statusLabel = "依赖失效"`
  - `reason = "依赖配置引用了 {dependencyId}，但当前目标里没有这个任务。"`

目的：
- 明确区分“依赖任务名称”和“依赖任务 ID”。
- 避免缺失时把 ID 当作 title，造成重复展示和理解偏差。

### 5. 统一两个 UI 入口的依赖展示

文件：
- `src/components/goal/TaskDetailBody.tsx`
- `src/components/task/ExecutionResultBody.tsx`

方案：
- 依赖主行展示：
  - 正常：`{dependency.displayTitle}` + `任务 ID：{dependency.taskId}`
  - 缺失：`未知任务` + `引用 ID：{dependency.taskId}`
- 状态标签保持现有视觉：
  - 缺失：红色 `依赖失效`
  - 已满足：绿色 `已结束`
  - 未满足：灰色/中性色状态
- 保留“需要信息”和“当前原因”两行。
- 对缺失依赖，“需要信息”继续显示“依赖任务本身不存在，无法读取预期产出。”。

可选 UI 文案：

```tsx
<span>{dependency.displayTitle}</span>
<span className="font-mono text-[11px] text-[#8C9198]">
  {dependency.missing ? `引用 ID：${dependency.taskId}` : `任务 ID：${dependency.taskId}`}
</span>
```

### 6. 保持执行上下文阻塞语义

文件：`src/lib/server/taskExecution/contextResolver.ts`

本次不建议修改核心阻塞逻辑。

原因：
- 如果历史数据仍存在失效依赖，执行应继续阻塞并提示修复配置。
- 数据生成修复后，新任务不会再正常进入这个分支。

可选小优化：
- 如果想统一用户文案，可将 missing blocker 文案从“依赖任务「ID」不存在”调整为“依赖引用 ID「ID」不存在对应任务”。
- 该优化不影响功能，可以作为低优先级附带项。

## Assumptions & Decisions

- 不迁移历史数据；历史失效依赖通过 UI 清晰提示。
- 不新增测试框架；本轮以 TypeScript、ESLint 和手动构造数据验证为主。
- 不改变 `Task.dependencies` 的数据结构，继续使用 `string[]` 存储 task ID。
- 不改变 `goalCommandService.ts` 的单点写入原则；本修复聚焦规划生成和展示，不新增绕过命令服务的写入。
- 不修改执行阻塞语义；失效依赖仍应阻止自动执行。
- 若 review 删除了被依赖任务，本轮选择过滤该依赖，而不是保留为失效依赖。

## Edge Cases

- 依赖任务被 review 删除：过滤依赖，避免生成失效引用。
- 依赖 ID 拼错或 Claude 引用了不存在 ID：过滤依赖，避免生成失效引用。
- 多个任务依赖同一个上游任务：统一映射到同一个新 draft task ID。
- 任务依赖自己：保留映射后可能形成自依赖；建议依赖完整性校验或 cycle 检测继续负责阻塞。
- 历史数据已有失效依赖：不会自动修复，但 UI 展示更明确。

## Verification Steps

1. 类型检查：

```bash
pnpm exec tsc --noEmit
```

2. 定向 ESLint：

```bash
pnpm exec eslint src/lib/server/goalPlanning.ts src/lib/goalFactory.ts src/mocks/goals.ts src/lib/taskDependencies.ts src/components/goal/TaskDetailBody.tsx src/components/task/ExecutionResultBody.tsx
```

3. 手动数据验证：
- 构造任务列表：
  - `task-1`
  - `task-2` 依赖 `task-1`
- 经过 `applyTaskReview()` 后确认：
  - task ID 变为 `draft-task-1`、`draft-task-2`
  - `draft-task-2.dependencies = ["draft-task-1"]`

4. 失效依赖验证：
- 构造 `task.dependencies = ["missing-task"]` 的历史数据。
- 打开“详细信息”。
- 预期看到：
  - `未知任务`
  - `引用 ID：missing-task`
  - `依赖失效`
  - 明确原因说明。

5. UI 入口验证：
- 在任务详情页 `TaskDetailBody` 查看依赖字段。
- 在执行结果页 `ExecutionResultBody` 查看依赖字段。
- 两处均展示依赖任务名称 + 任务 ID。

