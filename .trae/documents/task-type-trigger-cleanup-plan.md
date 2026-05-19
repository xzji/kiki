# 任务类型与触发时机收敛改造计划

## Summary

本次改造目标是把任务元信息收敛成更直观的一套语义：

- 保留 `任务类型`，只显示两类：`重复任务` / `一次性任务`
- 保留 `触发时机`，直接展示真实规则：
  - `每天 07:30`
  - `每周日 20:00`
  - `每 3 个小时`
  - `满足触发条件执行：xxx`
- 删除详情面板中的 `执行周期`
- 删除后端 `executionCycle` / `execution_cycle` 字段及其写入逻辑

为了不影响现有调度和通知语义，本次不会删除 `executionMode`。原来“监控任务”的特殊行为，改为挂在 `executionMode === "monitoring"` 上，而不再占用一个独立的 `taskType`。

## Current State Analysis

### 当前真实数据结构

- `Task["taskType"]` 目前是三值：`daily_repeat | one_shot | monitoring`
  - 文件：`src/types/kiki.ts`
- `Task["executionCycle"]` 目前是两值：`once | recurring`
  - 文件：`src/types/kiki.ts`
- 详情页展示的 `执行周期` 不是直接读 `executionCycle`，而是根据 `taskType` 再次派生：
  - `daily_repeat -> 每日`
  - `one_shot -> 一次性`
  - `monitoring -> 长期`
  - 文件：`src/components/goal/TaskDetailBody.tsx`

### 当前重复与误导点

- `执行周期` 和 `任务类型` 高度重复，且 `daily_repeat -> 每日` 会把“每周触发”也压扁成“每日”
- `executionCycle` 主要存在于规划链路与草稿落库中：
  - Claude 规划 JSON schema
  - `goalPlanning.ts` 的 sanitize / infer / draft 写入
  - `goalStore.ts` 的草稿映射
- 真正运行期调度并不直接依赖 `executionCycle`，更依赖这些字段：
  - `taskType`
  - `executionMode`
  - `triggerRule`

### 当前“监控任务”的真实耦合点

- `monitoring` 现在既是 `taskType`，也是 `executionMode`
- 特殊逻辑主要出现在：
  - 任务排序权重：`src/stores/goalStore.ts`
  - 运行时调度排序：`src/components/providers/GoalSchedulerRuntime.tsx`
  - 服务端调度排序：`src/lib/server/worker/goalSchedulerEngine.ts`
  - 结果通知策略：`src/lib/server/resultNotificationJudge.ts`
- 因此“监控并入重复任务”不是纯文案改动，必须把这些判断从 `taskType === "monitoring"` 迁移到 `executionMode === "monitoring"`

## Assumptions & Decisions

- `executionCycle` 可删，前提是“任务是重复还是一次性”的判断改由更直接的 `taskType` 承担
- `taskType` 收敛为两值：`repeat | one_shot`
- 原 `daily_repeat` 与 `monitoring` 在迁移后统一归一为 `repeat`
- `executionMode` 继续保留：
  - `standard`
  - `interactive`
  - `monitoring`
  - `event_triggered`
- 原“监控任务”的特殊通知/排序语义继续保留，但语义来源改为 `executionMode === "monitoring"`
- `触发时机` 直接使用 `triggerRule` 展示，不再额外展示 `执行周期`
- 事件触发类任务的展示文案统一为：
  - `满足触发条件执行：{具体条件}`
- 对已有持久化数据做兼容归一：
  - 旧值 `daily_repeat -> repeat`
  - 旧值 `monitoring -> repeat`

## Proposed Changes

### 1. 收敛领域类型定义

#### `src/types/kiki.ts`

变更内容：

- 删除 `TaskExecutionCycle = "once" | "recurring"`
- 删除 `Task.executionCycle?`
- 删除 `GoalBreakdownDraft.subGoals[].tasks[].executionCycle?`
- 将 `Task["taskType"]` 从
  - `daily_repeat | one_shot | monitoring`
  改为
  - `repeat | one_shot`

原因：

- 让“任务类型”只表达“重复 / 一次性”这一层概念
- 把“监控”保留在 `executionMode`
- 删掉未直接参与运行时决策、但在 UI 造成重复的 `executionCycle`

实现方式：

- 统一替换相关联合类型
- 全项目清理引用点
- 在运行期 normalizer 中兼容旧值，避免本地持久化数据或 mock 数据立即失效

### 2. 迁移任务 normalizer，兼容旧数据

#### `src/stores/goalStore.ts`

变更内容：

- 在 `normalizeTask(task)` 中加入 `taskType` 归一逻辑：
  - `daily_repeat -> repeat`
  - `monitoring -> repeat`
  - `one_shot -> one_shot`
- 删除 `executionCycle` 的透传与写入
- 更新 `inferSubGoalEstimatedDuration()` 中的任务时长映射，去掉 `taskType === "monitoring"` 分支

原因：

- 持久化 store 可能已有旧任务数据
- mock、历史数据、本地 `zustand persist` 都可能还带着旧 `taskType`
- 这是最稳妥的兼容入口

实现方式：

- 在 `normalizeTask` 中做一次性收敛，后续代码全部只处理 `repeat | one_shot`
- 任务时长权重改为：
  - `one_shot`
  - `repeat`
- 监控额外权重仍保留在 `executionMode === "monitoring"`

### 3. 重构规划链路：用 `task_type` 取代 `execution_cycle`

#### `src/lib/server/goalPlanning.ts`

变更内容：

- `TaskGenerationPayload.tasks[]` 删除 `execution_cycle`
- 改为显式输出 `task_type: "repeat" | "one_shot"`
- 保留 `execution_mode`
- 保留 `recurrence`
- 保留 `trigger_condition`
- 更新 prompt 里的字段说明与约束文案
- 更新 sanitize / validator / draft 映射逻辑
- 删除 `executionCycle` 写入：
  - `executionCycle: task.execution_cycle`
- 重写 `inferTaskType()`：
  - 直接读取 `task.task_type`
  - 对异常值回退：
    - 有 `recurrence` 或 `execution_mode === "monitoring"` 时默认 `repeat`
    - 否则默认 `one_shot`
- 调整 `inferTriggerRule()`：
  - `event_triggered` 时优先输出 `满足触发条件执行：{trigger_condition}`
  - `monitoring` 时使用 `recurrence`
  - `repeat` 时使用 `recurrence`
  - `one_shot` 时使用 `trigger_condition` 或默认一次性文案

原因：

- 如果直接删除 `execution_cycle` 而不补一个替代字段，规划链路无法稳定判断“重复 / 一次性”
- `task_type` 更贴近最终产品语义，也和你要的 UI 一致

实现方式：

- 修改 prompt schema、示例和规则说明
- 修改 JSON 解析器对应的 validator
- 修改 `applyTaskReview()` / `inferTaskType()` / 最终 `DraftTask` 落库映射

### 4. 去掉草稿到 Goal 的 `executionCycle` 透传

#### `src/stores/goalStore.ts`

变更内容：

- 删除 `createGoalFromDraft()` 中的：
  - `executionCycle: draftTask.executionCycle`

原因：

- 即使规划链路删掉了字段，这里仍会继续把旧草稿字段透传到运行时任务对象

实现方式：

- 直接删除透传
- 保留 `executionMode`、`expectedResult`、`executionStrategy` 等仍然有效的元数据

### 5. 重命名并简化前端展示

#### `src/components/goal/TaskDetailBody.tsx`

变更内容：

- `任务类型` 文案改为：
  - `repeat -> 重复任务`
  - `one_shot -> 一次性任务`
- 删除 `执行周期` 整行
- `触发时间` 改名为 `触发时机`
- 对事件触发类规则补齐前缀：
  - 如果是 `executionMode === "event_triggered"` 且 `triggerRule` 没有前缀，格式化为 `满足触发条件执行：{triggerRule}`

原因：

- 这是用户当前感知重复的主来源
- 改名后信息层次更清楚：类型看“重复 / 一次性”，触发时机看具体规则

实现方式：

- 清理 `TASK_TYPE_LABEL`
- 删除 `MetaLabel/MetaValue` 中的 `执行周期`
- 新增 `formatTaskTriggerMoment(task)` 一类的局部 helper，统一详情页展示

#### `src/components/task/DetailPanel.tsx`

变更内容：

- 同步将类型文案改成两类
- 保持 `触发时机` 标签一致

原因：

- 避免不同详情面板出现不一致表述

### 6. 收敛手动创建/编辑入口

#### `src/components/goal/TaskCreateDrawer.tsx`

变更内容：

- 任务类型下拉改为：
  - `重复任务`
  - `一次性任务`
- 默认值从 `daily_repeat` 改为 `repeat`
- `触发规则` 标签改为 `触发时机`
- placeholder 改成你希望的展示风格，例如：
  - `每天 07:30`
  - `每周日 20:00`
  - `每 3 个小时`
  - `满足触发条件执行：航班价格低于 1800 元`

原因：

- 避免 UI 还能创建出旧的 `monitoring` 类型
- 让人工创建与自动规划后的数据语义一致

#### `src/components/goal/TaskEditDrawer.tsx`

变更内容：

- 与创建抽屉同步，去掉 `监控任务`
- 文案统一成 `重复任务 / 一次性任务`
- 标签统一为 `触发时机`

### 7. 迁移运行时“监控特权”判断到 executionMode

#### `src/lib/server/resultNotificationJudge.ts`

变更内容：

- 将
  - `input.task.taskType === "monitoring"`
  改为
  - `input.task.executionMode === "monitoring"`

原因：

- 原来监控类结果只有检测到重要信号才高优先通知，这个行为应该保留
- 但语义来源必须从 `taskType` 挪到 `executionMode`

#### `src/components/providers/GoalSchedulerRuntime.tsx`

变更内容：

- 调整任务排序逻辑，删除 `taskType === "monitoring"` 分支
- 若仍需保留监控类排序差异，则改用 `executionMode === "monitoring"`

#### `src/lib/server/worker/goalSchedulerEngine.ts`

变更内容：

- 与前端 runtime 调度保持一致，同步迁移排序与可执行性判断中的 `monitoring` 来源

原因：

- 避免前后端调度规则分叉

### 8. 清理 mock / baseline / 文档引用

#### `src/mocks/goals.ts`

变更内容：

- 把 `taskType: "daily_repeat"` / `taskType: "monitoring"` 统一改成 `taskType: "repeat"`
- 删除 `executionCycle` 写入

#### `src/mocks/goal-breakdown.ts`

变更内容：

- 同步 taskType 新值，删掉草稿里的 `executionCycle`

#### `src/lib/devMockSessions.ts`

变更内容：

- 同步 taskType 新值

#### 文档

- 最少同步这几处与 schema 强相关的文档，避免后续误导：
  - `docs/plans/project-prompts-inventory.md`
  - `docs/plans/kiki-slash-goal-mode-plan.md` 中提到 `executionCycle` 的段落

原因：

- mock 和文档若继续保留旧结构，会导致后续测试样本和 prompt inventory 再次把旧字段带回来

## Verification Steps

### 静态验证

- 全局搜索确认不再存在运行时代码中的 `executionCycle`
- 全局搜索确认 `taskType` 只剩：
  - `repeat`
  - `one_shot`
- 全局搜索确认“监控特权”判断迁移到 `executionMode === "monitoring"`
- 对改动文件跑 TypeScript / diagnostics，确保无类型错误

### 行为验证

- 详情页验证：
  - 不再显示 `执行周期`
  - 显示 `任务类型：重复任务 / 一次性任务`
  - 显示 `触发时机`
- 创建/编辑任务验证：
  - 下拉只剩两类
  - 旧任务若是 `monitoring`，打开后能稳定归一为 `重复任务`
- 自动规划验证：
  - Claude 规划结果仍能区分重复任务与一次性任务
  - `monitoring` 任务生成后显示为 `重复任务`，但 `executionMode` 仍保留为 `monitoring`
- 通知验证：
  - 原监控类任务在出现重要信号时，仍走高优先级通知
- 调度验证：
  - 一次性任务完成后仍不会重复执行
  - 重复任务仍按 `triggerRule` 持续触发

## Risk Notes

- 最大风险不是 `executionCycle` 删除本身，而是“重复 / 监控”两层语义原来混在 `taskType` 上；如果只删字段、不迁移运行时判断，通知和排序会变
- 本地持久化数据里可能还有旧的 `daily_repeat | monitoring | executionCycle`；必须依赖 `normalizeTask()` 做兼容收敛
- 规划 prompt 与 validator 必须同步改，否则 Claude 返回结构和解析器会不一致
