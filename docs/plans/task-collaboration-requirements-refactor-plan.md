# 任务协作要求与结果推送改造方案

## 背景

当前目标规划和任务执行链路已经具备基础的任务执行字段，例如 `executionMode`、`executionStrategy`、`expectedResult`、`requiresConfirmation`，但它们还不足以表达产品上真正需要的“Agent / 用户职责分工”。

用户期望的模型不是简单区分“自动执行 / 需要确认”，而是明确说明：

1. 哪些任务由 Agent 自主完成，用户只需要知悉或确认结果。
2. 哪些任务需要用户与 Agent 共同完成，Agent 负责准备、分析、生成，用户负责作答、选择、补充或确认。
3. 哪些任务主要由用户完成，Agent 负责建议、提醒、跟进和记录。

当前实现把多种用户介入场景都压缩进 `awaitingUser=true`，导致 UI 和通知层容易把“需要作答”“需要参与”“交付物未通过验收”都显示成“待确认”。

## 当前实现现状

### 规划阶段

已有字段：

- `executionMode`: `standard | interactive | monitoring | event_triggered`
- `executionStrategy`: `agent_autonomous | user_interactive | hybrid`
- `expectedResult`: 结果类型、格式、完成标准
- `requiresConfirmation`: 是否需要确认
- `resultViewKind`: 结果视图类型，如 `flashcard`、`listening_qa`、`draft_review`

当前问题：

- 没有明确 `agentResponsibilities`。
- 没有明确 `userResponsibilities`。
- 没有明确用户介入类型，例如确认/给建议、作答、补充上下文、线下执行。
- 没有明确用户介入发生在执行前、执行中、执行后，还是任务本身的核心环节。
- `executionStrategy` 只表达粗分类，不能直接指导通知文案和 UI 状态。

### 执行阶段

当前执行 Prompt 已改为交付物要求驱动，要求 Claude 返回 `deliverable_check`，并要求主交付物放在 `artifacts[0]`。

当前问题：

- `awaitingUser` 仍然是布尔值。
- 用户确认、用户作答、用户补充信息、交付物缺口都可能被统一塞进 `awaitingUser`。
- Runner 验收失败时会转成 `awaitingUser=true`，避免误标完成，但这会被通知层误解为“需要用户确认”。

### 通知阶段

当前通知判断器逻辑：

- 如果 `result.awaitingUser=true`，优先生成 `action_required`。
- `flashcard/listening_qa/freeform_chat` 只有在没有 `awaitingUser` 时才会进入 `answer_required`。
- 投递器只检查 `notification.shouldNotify && deliveryState === "pending"`，不区分通知是结果完成、执行中确认，还是任务互动。

当前问题：

- 答题类任务会被错误显示为“待确认”。
- 执行中需要确认和完成后需要确认混在一起。
- 交付物未通过验收也可能触发用户推送。
- 调度器在任务刚启动时会先推“后台启动”卡片，容易让用户误以为这是结果推送。

## 目标模型

新增任务协作要求 `TaskCollaborationRequirements`，在规划阶段明确 Agent 与用户的职责边界。

### 任务协作类型

```ts
export type TaskCollaborationMode =
  | "agent_autonomous"
  | "agent_with_user_confirmation"
  | "agent_user_collaborative"
  | "user_primary_agent_assistive";
```

语义：

- `agent_autonomous`: Agent 自主完成，用户通常只需知悉结果。
- `agent_with_user_confirmation`: Agent 自主推进，但关键节点或最终结果需要用户确认。
- `agent_user_collaborative`: Agent 和用户共同完成，用户参与是任务完成的一部分。
- `user_primary_agent_assistive`: 用户主要完成，Agent 负责建议、提醒、检查和记录。

### 用户介入类型

```ts
export type UserInteractionType =
  | "none"
  | "confirm"
  | "answer"
  | "provide_context"
  | "perform_offline_action";
```

语义：

- `none`: 不需要用户介入。
- `confirm`: 用户确认决策、动作、结果、草稿，或对 Agent 产出给出修改建议。
- `answer`: 用户作答、练习、填写。
- `provide_context`: 用户补充缺失背景。
- `perform_offline_action`: 用户在线下执行动作，Agent 负责提醒和记录。

### 用户介入时机

```ts
export type UserInteractionTiming =
  | "not_required"
  | "before_execution"
  | "during_execution"
  | "after_agent_output"
  | "core_task_step";
```

语义：

- `not_required`: 不需要介入。
- `before_execution`: 执行前必须确认或补充信息。
- `during_execution`: 执行中遇到阻塞点，需要用户确认后继续。
- `after_agent_output`: Agent 产出后，需要用户确认、给出修改建议或采纳。
- `core_task_step`: 用户参与本身就是任务完成的一部分，例如答题、填写、训练。

### 建议新增字段

```ts
export type TaskCollaborationRequirements = {
  mode: TaskCollaborationMode;
  agentResponsibilities: string[];
  userResponsibilities: string[];
  userInteractionType: UserInteractionType;
  userInteractionTiming: UserInteractionTiming;
  userFacingActionLabel: string;
  shouldNotifyUser: boolean;
  completionOwner: "agent" | "user" | "shared";
  completionDefinition: string;
};
```

挂载到 `Task`：

```ts
export type Task = {
  // existing fields...
  collaboration?: TaskCollaborationRequirements;
};
```

## 规划阶段改造

### Prompt 要求

在 `buildTaskGenerationPrompt()` 中新增输出字段：

```json
{
  "collaboration": {
    "mode": "agent_autonomous | agent_with_user_confirmation | agent_user_collaborative | user_primary_agent_assistive",
    "agent_responsibilities": ["Agent 负责事项"],
    "user_responsibilities": ["用户负责事项"],
    "user_interaction_type": "none | confirm | answer | provide_context | perform_offline_action",
    "user_interaction_timing": "not_required | before_execution | during_execution | after_agent_output | core_task_step",
    "user_facing_action_label": "给用户看的按钮/动作文案",
    "should_notify_user": true,
    "completion_owner": "agent | user | shared",
    "completion_definition": "这个任务如何才算完成"
  }
}
```

### 规划规则

规划阶段必须判断：

- 如果 Agent 可以完整交付结果，设为 `agent_autonomous`。
- 如果 Agent 生成结果但需要用户确认是否采用，设为 `agent_with_user_confirmation`。
- 如果 Agent 准备题目、材料、选项、草稿，用户需要作答、确认、给建议或选择，设为 `agent_user_collaborative`。
- 如果任务主体必须由用户在线下完成，Agent 只能辅助提醒，设为 `user_primary_agent_assistive`。

### 字段映射

兼容旧字段：

- `executionStrategy = agent_autonomous` -> `collaboration.mode = agent_autonomous`
- `executionStrategy = hybrid` -> 优先映射为 `agent_user_collaborative`
- `executionStrategy = user_interactive` -> 优先映射为 `user_primary_agent_assistive`
- `requiresConfirmation=true` 不再直接表示所有互动，只表示确认类互动
- `resultViewKind=flashcard/listening_qa/freeform_chat` 默认映射为 `user_interaction_type=answer`
- `resultViewKind=draft_review` 默认映射为 `user_interaction_type=confirm`
- `resultViewKind=confirm_action` 默认映射为 `user_interaction_type=confirm`

## 执行阶段改造

### Runner 输出模型

新增用户介入原因，不再只用 `awaitingUser`：

```ts
export type InteractionRequirement = {
  type:
    | "none"
    | "confirm"
    | "answer"
    | "provide_context"
    | "deliverable_gap"
    | "agent_revision_required";
  timing:
    | "before_execution"
    | "during_execution"
    | "after_agent_output"
    | "core_task_step"
    | "not_required";
  reason: string;
  question?: string;
  options?: string[];
  suggestedActions?: string[];
  shouldNotifyUser: boolean;
};
```

### Prompt 输出 Schema

在 `goalTaskPrompt.ts` 中将 `awaiting_user` 扩展为：

```json
{
  "interaction_requirement": {
    "type": "none | confirm | answer | provide_context | deliverable_gap | agent_revision_required",
    "timing": "not_required | before_execution | during_execution | after_agent_output | core_task_step",
    "reason": "为什么需要用户或 Agent 继续处理",
    "question": "需要用户确认/回答的问题",
    "options": ["选项1", "选项2"],
    "suggested_actions": ["建议动作"],
    "should_notify_user": true
  }
}
```

保留兼容：

- `awaiting_user` 可以继续读取，但只作为旧字段兜底。
- 新逻辑优先使用 `interaction_requirement`。

### 验收失败处理

交付物未通过验收时：

- 不应标记为 `confirm`。
- 不应默认推送给用户。
- 应设置为 `agent_revision_required` 或 `deliverable_gap`。
- 默认 `shouldNotifyUser=false`。
- 任务状态可以显示为“等待 Agent 补齐”或“未通过验收”，而不是“待确认”。

## 通知阶段改造

### 通知判断优先级

新的 `judgeTaskResult()` 应按以下顺序判断：

1. `interactionRequirement.type = confirm` 且 `shouldNotifyUser=true` -> 推确认卡。
2. `interactionRequirement.type = answer` -> 推作答卡。
3. `interactionRequirement.type = provide_context` -> 推补充信息卡。
4. `interactionRequirement.type = deliverable_gap | agent_revision_required` -> 默认不推送给用户。
5. 任务已完成且结果值得查看 -> 推结果卡或 Inbox。
6. 任务完成但无需打扰 -> 静默归档。

### 通知类型建议

```ts
export type TaskResultNotificationType =
  | "result_ready"
  | "action_required"
  | "answer_required"
  | "context_required"
  | "silent_archive";
```

### 投递门禁

投递器 `deliverPendingTaskNotifications()` 需要增加门禁：

- `result_ready` 只能在实例 `completed` 时投递。
- `answer_required` 可以在 `awaiting_user` 或 `completed` 时投递，取决于任务是否需要用户完成核心步骤。
- `action_required` 可以在执行中或完成后投递，但必须是 `interactionRequirement.type=confirm`。
- `deliverable_gap` 和 `agent_revision_required` 不投递。
- 启动任务时不再默认推送会话卡片。

## 状态与 UI 改造

### 实例状态不再等同于展示文案

`awaiting_user` 只是运行时暂停的一类状态，UI 文案必须结合 `interactionRequirement.type`。

显示规则：

- `confirm` -> `待确认`
- `answer` -> `待作答`
- `provide_context` -> `待补充`
- `deliverable_gap` -> `未通过验收`
- `agent_revision_required` -> `等待 Agent 补齐`

### 任务详情页

任务详情页三个列表建议调整为：

- `待执行`
- `执行中`
- `待用户参与`
- `已完成`

如果暂时保持三个列表，也应将 `awaiting_user` 按 interaction type 显示：

- 确认/给建议/作答/补充 -> 可以留在 `执行中`，但标签必须具体。
- 交付物缺口 -> 显示为“等待 Agent 补齐”，不显示“待确认”。

### 会话卡片

会话卡片的文案和按钮应由通知类型决定：

- `answer_required`: “题目已准备好，开始作答”
- `action_required`: “需要你确认：xxx”或“草稿已生成，请确认或提出修改建议”
- `context_required`: “需要你补充：xxx”
- `result_ready`: “任务已完成，查看结果”

## 需要修改的文件

### 类型定义

- `src/types/kiki.ts`
  - 新增 `TaskCollaborationRequirements`
  - 新增 `InteractionRequirement`
  - 扩展 `Task`
  - 扩展 `TaskInstanceResult` 或 result payload

### 规划层

- `src/lib/server/goalPlanning.ts`
  - `buildTaskGenerationPrompt()` 输出 collaboration 字段
  - validate/normalize draft 时保留 collaboration
  - 兼容旧任务字段映射

### 执行层

- `src/lib/server/goalTaskPrompt.ts`
  - 注入 collaboration requirements
  - 要求返回 `interaction_requirement`

- `src/lib/server/goalTaskRunner.ts`
  - 解析 `interaction_requirement`
  - 验收失败转为 `agent_revision_required` 或 `deliverable_gap`
  - 不再把所有非完成状态都转成 `awaitingUser=true`

### 通知层

- `src/lib/server/resultNotificationJudge.ts`
  - 按 interaction type 分流
  - 新增 context 类型
  - deliverable gap 默认 silent

- `src/components/providers/GoalSchedulerRuntime.tsx`
  - 去掉任务启动时默认推送会话卡片
  - 投递 pending notification 前增加状态和类型门禁

### 同步层

- `src/stores/goalStore.ts`
  - 同步 `interactionRequirement`
  - `awaitingUser` 仅作兼容层

- `src/lib/server/runtime/goalStateSnapshot.ts`
  - 同步 `interactionRequirement`
  - 保证 daemon 和浏览器状态一致

### UI 层

- `src/components/goal/TaskDetailBody.tsx`
  - 按 interaction type 显示状态文案
  - 不再把所有 `awaiting_user` 显示为“待确认”

- `src/components/conversation/TaskMessageCard.tsx`
  - 按通知类型显示卡片状态和 CTA

- `src/components/task/ExecutionResultBody.tsx`
  - 结果区区分作答、确认/建议、补充信息、未通过验收

## 实施顺序

### 第一阶段：模型补齐

1. 在 `kiki.ts` 新增协作要求和用户介入类型。
2. 在规划 prompt 中要求输出 collaboration。
3. normalize 旧任务时自动推断 collaboration。

### 第二阶段：执行链路改造

1. 在任务执行 prompt 中注入 collaboration。
2. Runner 解析 `interaction_requirement`。
3. 交付物验收失败不再转成“待确认”，而是转成 `agent_revision_required`。

### 第三阶段：通知投递收紧

1. 通知判断器按 interaction type 分流。
2. 投递器增加状态门禁。
3. 禁用任务启动时默认会话卡片推送。

### 第四阶段：UI 语义修正

1. 任务详情页状态文案按 interaction type 显示。
2. 会话任务卡片按通知类型展示。
3. 结果页区分“作答、确认/建议、补充、结果”。

### 第五阶段：数据兼容

1. 为旧 mock 和用户数据补默认 collaboration。
2. 保持 `awaitingUser` 兼容读取。
3. 新数据优先使用 `interactionRequirement`。

## 验收标准

1. Agent 自主完成任务不会在启动时推送用户卡片。
2. 只有完成后的结果、或执行中真正需要用户参与的任务，才推送卡片。
3. 答题类任务显示“待作答”，不显示“待确认”。
4. 草稿类任务显示“待确认”，CTA 可写为“确认或提出修改建议”。
5. 缺上下文显示“待补充”。
6. 交付物未通过验收不推送用户确认卡，而是显示“等待 Agent 补齐”或“未通过验收”。
7. `result_ready` 只在任务完成后投递。
8. 执行过程的信息流只展示真实执行链路，不承担结果推送语义。
