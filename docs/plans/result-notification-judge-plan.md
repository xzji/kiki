# ResultNotificationJudge 完整方案

## 背景

当前 KiKi 的长程目标任务已经具备后台执行、Telemetry 回流、SQLite 快照同步、任务详情页展示等能力。但任务执行完成后，系统还缺少一个统一判断：

- 这个结果是否需要主动推送给用户？
- 如果推送，应该推送到 Inbox、会话流，还是两者都推？
- 如果不推送，结果是否仍需要沉淀到任务详情页？
- 如果需要用户确认，前端应该如何突出“下一步动作”？
- 如果只是普通完成结果，如何用更友好的 UI 展示，而不是直接暴露原始输出？

`coding-agent` 项目里已经有一套较完整的思路：执行完成后并不是直接通知用户，而是先判断输出是否有价值，再生成通知，进入通知队列，并在用户空闲时投递。KiKi 当前 Web 产品不必完全照搬 CLI 的空闲投递机制，但需要吸收它的核心原则：**先判断结果价值，再决定是否打扰用户**。

## 目标

本方案设计并落地一个 `ResultNotificationJudge`，作为任务执行完成后的结果判定层。

核心目标：

- 对所有任务完成结果做统一判定。
- `awaiting_user=true` 或需要用户确认的任务必须推送给用户。
- 有价值的完成结果以用户友好的形式推送给用户。
- 普通低价值结果只静默沉淀在任务详情页，不制造噪音。
- Inbox、会话任务卡、任务详情页读取同一份通知语义，避免 UI 状态不一致。
- 任务详情页优先展示“结果摘要、下一步动作、关键产物”，把执行链路、原始输出、结构化数据放到“更多”里。

## 非目标

第一版不做以下能力：

- 不接入系统级 macOS 通知。
- 不做真正的 idle detector 空闲投递。
- 不做复杂的跨任务去重聚合。
- 不强依赖 LLM 二次评审，避免结果回流链路不稳定。
- 不改变任务调度与执行主流程，只在结果完成后增加判定与展示层。

后续版本可以逐步补充 LLM Judge、去重、用户反馈学习和空闲投递。

## 参考 coding-agent

`coding-agent` 的核心链路：

1. 执行结果完成且有输出。
2. 从执行输出中抽取 insight。
3. 通过 `ValueJudge` 判断结果价值。
4. 只有 `shouldNotify=true` 的结果才合成通知。
5. 通知进入 `NotificationQueue`。
6. 用户空闲时投递到会话。

它的价值判断维度：

- Novelty：是否是新信息。
- Importance：对目标达成是否重要。
- Actionability：用户能否基于它采取行动。
- Credibility：来源是否可信。

KiKi 第一版采用更稳定的确定性规则，但保留相同抽象：

- `shouldNotify`：是否应该推送。
- `priority`：推送优先级。
- `notificationType`：推送类型。
- `reason`：判定原因。
- `userMessage`：面向用户的通知文案。
- `resultSummary`：任务详情页友好摘要。

## 当前项目现状

### 已有能力

- `goalTaskRunner` 可以执行任务并解析 Claude CLI 返回的结构化 JSON。
- 返回结果中已有 `awaiting_user`、`awaiting_reason`、`suggested_actions`、`artifacts`、`final_message` 等字段。
- `goalStore.syncTaskInstanceRun` 能把结果同步到 `TaskInstance.result` 和 `TaskInstance.awaitingUser`。
- `GoalSchedulerRuntime` 在任务启动时会创建 Inbox item 和会话 `task_card`。
- `TaskMessageCard`、`InboxCard`、`TaskResultDrawer`、`ExecutionResultBody` 已经形成一条从通知到详情的 UI 链路。
- mock Inbox 已经具备类似产品形态，如 `[需要确认]`、`[需要作答]`、摘要型结果通知。

### 缺口

- 任务完成后没有统一 `shouldNotify` 判定。
- 任务启动时已经创建 Inbox，但完成后没有按最终结果更新为“结果已完成”或“需要确认”。
- 会话任务卡内容主要是启动提示，不是最终结果通知。
- 任务详情页结果区偏原始，缺少友好的摘要、下一步动作、更多详情分层。
- daemon 后台执行完成后，只写回结果和日志，没有通知语义。

## 总体架构

新增一层结果通知判定：

```text
任务执行完成
  -> parseTaskRunnerResult
  -> ResultNotificationJudge
  -> resultPayload.notificationDecision
  -> telemetry / runtime job / snapshot
  -> goalStore.syncTaskInstanceRun
  -> TaskInstance.notification
  -> Inbox / Conversation / Task Detail UI
```

这个架构保证服务端和前端围绕同一份 `notificationDecision` 工作。

## 核心数据结构

### TaskResultNotificationDecision

建议新增到 `src/types/kiki.ts` 或独立 `src/types/resultNotification.ts`，最终由 `TaskInstance` 引用。

```ts
export type TaskResultNotificationChannel =
  | "silent"
  | "inbox"
  | "conversation"
  | "both";

export type TaskResultNotificationType =
  | "action_required"
  | "answer_required"
  | "result_ready"
  | "digest_ready"
  | "silent_archive";

export type TaskResultNotificationPriority = "high" | "normal" | "low";

export type TaskResultNotificationDecision = {
  shouldNotify: boolean;
  channel: TaskResultNotificationChannel;
  notificationType: TaskResultNotificationType;
  priority: TaskResultNotificationPriority;
  reason: string;
  title: string;
  snippet: string;
  userMessage: string;
  badge?: "need_confirm" | "need_answer" | null;
  resultSummary: {
    headline: string;
    keyPoints: string[];
    nextActions: string[];
    primaryArtifactLabel?: string;
  };
  detailPolicy: {
    showTimelineByDefault: boolean;
    showRawOutputBehindMore: boolean;
    showArtifactsExpanded: boolean;
  };
  createdAt: string;
};
```

### TaskInstanceNotificationState

`TaskInstance` 上保存实际通知状态。

```ts
export type TaskInstanceNotificationState = TaskResultNotificationDecision & {
  deliveryState: "pending" | "delivered" | "silent";
  deliveredAt?: string;
  inboxItemId?: string;
  conversationMessageId?: string;
};
```

扩展 `TaskInstance`：

```ts
export type TaskInstance = {
  // existing fields...
  notification?: TaskInstanceNotificationState;
};
```

### resultPayload 扩展

`goalTaskRunner` 生成的 `resultPayload` 增加：

```ts
const resultPayload = {
  resultViewKind: result.resultViewKind,
  awaitingUser: result.awaitingUser,
  awaitingReason: result.awaitingReason,
  suggestedActions: result.suggestedActions,
  artifacts: result.artifacts,
  structuredOutput: result.structuredOutput,
  finalMessage: result.finalMessage,
  notificationDecision,
};
```

## ResultNotificationJudge 设计

### 文件位置

建议新增：

```text
src/lib/server/resultNotificationJudge.ts
```

如果前端也需要复用格式化逻辑，可以拆成：

```text
src/lib/resultNotification/shared.ts
src/lib/server/resultNotificationJudge.ts
```

第一版推荐把纯规则函数放到 shared，服务端只负责调用。

### 输入

```ts
export type JudgeTaskResultInput = {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  result: {
    summary: string;
    finalMessage: string;
    resultViewKind: TaskResultViewKind;
    awaitingUser: boolean;
    awaitingReason?: string;
    suggestedActions?: string[];
    artifacts: TaskRunArtifact[];
    structuredOutput: Record<string, unknown> | null;
  };
  now?: string;
};
```

### 输出

返回 `TaskResultNotificationDecision`。

### 判定原则

优先级从高到低：

1. 明确等待用户：`awaitingUser=true`。
2. 任务配置要求确认：`task.requiresConfirmation=true`。
3. 任务预期产出是决策或确认：`expectedResult.type=decision|confirmation`。
4. 任务类型本身需要审阅：`draft_review|confirm_action`。
5. 练习/问答类需要用户作答：`flashcard|listening_qa|freeform_chat`。
6. 有明确产物或高价值摘要：`artifacts.length > 0` 或 `finalMessage` 足够充实。
7. 高优先级任务完成：`priority=critical|high`。
8. monitoring 类任务默认静默，除非结果提示异常、机会、风险或阻塞。
9. 其他普通完成结果静默归档。

### 第一版规则伪代码

```ts
export function judgeTaskResult(input: JudgeTaskResultInput): TaskResultNotificationDecision {
  const { goal, task, result } = input;
  const kind = result.resultViewKind || task.resultViewKind || task.executionKind;

  if (result.awaitingUser) {
    return buildActionRequiredDecision(input, {
      reason: result.awaitingReason || "任务需要你确认下一步。",
      badge: "need_confirm",
    });
  }

  if (task.requiresConfirmation || task.expectedResult?.type === "confirmation" || task.expectedResult?.type === "decision") {
    return buildActionRequiredDecision(input, {
      reason: "任务已完成，建议你确认结果后继续推进。",
      badge: "need_confirm",
    });
  }

  if (kind === "confirm_action") {
    return buildActionRequiredDecision(input, {
      reason: result.summary || "KiKi 已整理好可执行方案，需要你确认。",
      badge: "need_confirm",
    });
  }

  if (kind === "draft_review") {
    return buildReviewReadyDecision(input);
  }

  if (kind === "flashcard" || kind === "listening_qa" || kind === "freeform_chat") {
    return buildAnswerRequiredDecision(input);
  }

  if (kind === "reading_digest") {
    return buildDigestReadyDecision(input);
  }

  if (hasMeaningfulArtifacts(result) || hasSubstantialFinalMessage(result) || isHighPriority(task)) {
    return buildResultReadyDecision(input);
  }

  if (task.executionMode === "monitoring" && hasImportantSignal(result)) {
    return buildResultReadyDecision(input, { priority: "high" });
  }

  return buildSilentArchiveDecision(input);
}
```

### 文案生成

文案生成必须稳定，不依赖模型。

基础标题：

```ts
const title = `${cleanTaskTitle(task)} - ${goal.title}`;
```

Inbox snippet：

- `action_required`：`[需要确认] ${reason}`
- `answer_required`：`[需要作答] ${headline}`
- `digest_ready`：`${headline}`
- `result_ready`：`${headline}`
- `silent_archive`：不创建 Inbox

会话消息：

- `action_required`：`我已完成任务「xxx」，现在需要你确认下一步。`
- `answer_required`：`任务「xxx」已经准备好，需要你完成本轮作答。`
- `digest_ready`：`我整理好了任务「xxx」的摘要，核心是：yyy`
- `result_ready`：`任务「xxx」已完成，点击卡片可以查看结果。`

### resultSummary 生成

`resultSummary` 用于任务详情页顶部友好展示：

- `headline`：优先 `summary`，其次 `finalMessage` 第一句，最后 fallback。
- `keyPoints`：从 `finalMessage` 里按换行或列表切分，最多 3 条。
- `nextActions`：优先 `suggestedActions`，其次按类型 fallback。
- `primaryArtifactLabel`：第一个 artifact 的 label。

## 服务端接入

### goalTaskRunner

修改点：

- 在 `executeOnce` 返回 `ParsedTaskRunnerResult` 后，生成 `notificationDecision`。
- 在 `finishGoalTelemetry` 的 `resultPayload` 中写入 decision。
- `appendGoalLog` 的 `result_ready` 仍保留，但可以把 `status` 和 message 调整为更精准。

推荐接入位置：

```ts
const result = await executeOnce({ ...input, attemptCount });
const notificationDecision = judgeTaskResult({
  goal: input.goal,
  subGoal: input.subGoal,
  task: input.task,
  instance: input.instance,
  result,
});
```

### taskDispatchWorker

daemon 后台执行完成后，当前会把 `latestProgress.resultPayload` 写入 runtime job `result`。只要 `resultPayload.notificationDecision` 已经存在，这里不需要额外判定。

但要确保：

- `syncGoalInstanceFromProgress` 能把 `notificationDecision` 同步到 snapshot。
- 浏览器重新打开后，`RuntimeStateBridge` 能拿到 `TaskInstance.notification`。

### goalStateSnapshot

`syncGoalInstanceFromProgress` 需要增加：

```ts
notification: progress?.resultPayload?.notificationDecision
  ? normalizeNotificationDecision(...)
  : instance.notification
```

这样 daemon 完成任务后，即使浏览器关闭，通知语义仍会落盘。

## 前端状态接入

### goalStore.syncTaskInstanceRun

当前已经同步：

- `status`
- `payload`
- `execution`
- `result`
- `awaitingUser`
- `timeline`

需要新增同步：

```ts
notification: progress?.resultPayload?.notificationDecision
  ? {
      ...progress.resultPayload.notificationDecision,
      deliveryState: shouldNotify ? "pending" : "silent",
    }
  : instance.notification
```

注意：

- 如果 notification 已经 delivered，不要重复变回 pending。
- 使用 `inboxItemId` 和 `conversationMessageId` 防止重复推送。

### Result Delivery Orchestrator

建议新增一个前端轻量分发器：

```text
src/lib/resultNotification/delivery.ts
```

或先内联在 `GoalSchedulerRuntime` 中。

职责：

- 扫描刚完成且 `notification.deliveryState=pending` 的实例。
- 根据 `channel` 创建或更新 Inbox。
- 根据 `channel` 创建或更新 conversation task card。
- 标记 `deliveryState=delivered`。

建议第一版放在 `GoalSchedulerRuntime` 中，后续再抽。

## Inbox 关联

### 创建/更新策略

当前任务启动时会创建 `inbox-${instanceId}`。完成后推荐更新同一个 item，而不是创建新 item。

如果启动时没有创建，则创建：

```ts
const inboxItemId = `inbox-${instanceId}`;
```

更新内容：

- `title`: `notification.title`
- `snippet`: `notification.snippet`
- `badge`: `notification.badge`
- `unreadCount`: `1`
- `timeLabel`: 当前完成时间
- `linkTo`: `/goals/${goalId}/tasks/${taskId}?view=exec&instanceId=${instanceId}`
- `goalId`: `goal.id`
- `createdAt`: notification createdAt

### inboxStore 扩展

当前只有 `addItem`，需要新增：

```ts
upsertItem: (item: InboxItem) => void;
```

逻辑：

- 已存在则更新并置顶。
- 不存在则插入顶部。

## 会话流关联

### 推荐策略

更新原任务卡，而不是追加多张卡，避免会话噪音。

启动时已有：

```ts
msg-task-${instanceId}
```

完成后：

- 找到这个 message。
- 更新 `content` 为 `notification.userMessage`。
- 设置 `unread=true`。
- `status=done`。

如果找不到，补建一张 `task_card`。

### conversationStore 扩展

需要确认现有 store 是否已有 update message 能力。如果没有，新增：

```ts
upsertTaskMessage(conversationId, message)
updateMessage(conversationId, messageId, updater)
```

保证任务完成回流时不会重复插卡。

### TaskMessageCard

当前摘要展示：

```ts
instance.result?.summary || instance.awaitingUser?.reason || instance.intro
```

建议改为：

```ts
instance.notification?.snippet ||
instance.result?.summary ||
instance.awaitingUser?.reason ||
instance.intro
```

状态展示：

- `completed` -> `已完成`
- `awaiting_user` -> `待确认`
- `error` -> `失败`

如果 `notification.badge` 存在，在卡片状态行加一个小标签：

- `需要确认`
- `需要作答`

## 任务详情页 UI 设计

### 当前问题

`ExecutionResultBody` 当前结构是：

- 顶部任务卡
- 执行链路
- 执行结果

这对调试有用，但对用户来说优先级反了。完成后用户更关心：

- 结果是什么？
- 我要不要做什么？
- 关键产物在哪里？
- 详细执行过程可以晚点看。

### 新结构

建议调整为：

```text
任务结果顶部卡
  - 状态：已完成 / 待确认 / 执行失败
  - 一句话结论
  - 需要用户动作时显示强调卡
  - 主操作按钮区域

关键结果
  - 3 条以内 keyPoints
  - 主要 artifact 预览
  - 下一步建议

更多详情
  - 执行链路
  - 完整输出
  - 全部产物
  - 原始结构化数据
```

### ResultOverviewCard

新增组件：

```text
src/components/task/ResultOverviewCard.tsx
```

展示：

- `notification.resultSummary.headline`
- `notification.notificationType`
- `notification.badge`
- `instance.execution.finishedAt`
- `notification.resultSummary.nextActions`

视觉：

- `action_required`：浅黄色背景，边框 `#F5D58B`。
- `answer_required`：浅蓝或浅紫背景。
- `result_ready`：白底或浅绿色提示。
- `error`：浅红色。

### UserActionPanel

新增或内联：

- 当 `instance.awaitingUser` 或 `notification.notificationType=action_required` 显示。
- 展示原因和建议操作。
- 第一版按钮可以是非破坏性的 UI：
  - `确认已查看`
  - `打开结果`
  - `稍后处理`

如果没有后续动作逻辑，按钮先只更新本地状态或不做，避免伪执行。

### ArtifactPreviewList

现有 `GenericAgentResultView` 直接把 artifact 内容全部展开，容易压屏。

建议：

- 默认展示 artifact label、kind、内容前 300-500 字。
- 如果是 `link`，突出链接按钮。
- 如果是 `markdown/text/code/json`，提供“展开全部”。
- 全部展开内容放到“更多详情”。

### MoreDetailsDisclosure

新增折叠区：

- 默认收起。
- 标题：`更多执行细节`。
- 内容：
  - `TaskExecutionTimeline`
  - `finalMessage`
  - `structuredOutput`
  - 全量 artifacts

对任务详情页、Inbox 结果页、会话结果页都统一使用。

## UI 与 mock 数据对齐

mock Inbox 当前有以下风格：

- `[需要作答] 昨天你已经对了 9 道题...`
- `整理了 4 条 AI 行业的重点大新闻...`
- `[需要确认] 我共草拟了 3 封邮件...`

新通知应该保持同类语气：

### 需要确认

```text
[需要确认] 我已完成「邮件草稿审阅」，共整理 3 封草稿，建议先确认最重要的一封。
```

### 需要作答

```text
[需要作答] 本轮听力练习已准备好，建议先完成 10 道题再查看解析。
```

### 普通摘要

```text
整理了 4 条 AI 行业重点信息，其中 OpenAI 多智能体框架最值得关注。
```

### 普通完成

```text
任务已完成，我整理了核心结论和相关产物，点击查看详情。
```

## 完整落地步骤

### 阶段 1：类型与 Judge

改动：

- 扩展 `types/kiki.ts`。
- 新增 `resultNotificationJudge.ts`。
- 为规则函数增加小型单元测试或至少样例验证。

验收：

- 对 `awaiting_user` 返回 `action_required`。
- 对 `draft_review` 返回 `action_required`。
- 对 `reading_digest` 返回 `digest_ready`。
- 对低价值普通结果返回 `silent_archive`。

### 阶段 2：服务端结果写入

改动：

- `goalTaskRunner.ts` 调用 Judge。
- `resultPayload` 增加 `notificationDecision`。
- `goalStateSnapshot.ts` 同步 notification 到 instance。

验收：

- 前端轮询 progress 能看到 `notificationDecision`。
- daemon 完成后 snapshot 中保留 notification。

### 阶段 3：前端状态同步

改动：

- `goalStore.syncTaskInstanceRun` 写入 `instance.notification`。
- 保留 delivered 状态，避免重复投递。

验收：

- 任务完成后实例上有 notification。
- 刷新页面后 notification 不丢。

### 阶段 4：Inbox 与会话推送

改动：

- `inboxStore` 新增 `upsertItem`。
- `conversationStore` 新增或复用 message 更新方法。
- `GoalSchedulerRuntime` 在任务完成后调用 delivery。
- `TaskMessageCard` 优先展示 notification snippet。
- `InboxCard` 展开后优先展示 notification userMessage。

验收：

- 需要确认的任务完成后，Inbox 出现 `[需要确认]`。
- 会话任务卡从“后台执行中”更新为最终结果提示。
- 同一任务不会重复生成多张卡。

### 阶段 5：任务详情页 UI

改动：

- 新增 `ResultOverviewCard`。
- 改造 `GenericAgentResultView`。
- `ExecutionResultBody` 调整顺序，结果优先，执行链路放进更多。
- `TaskResultDrawer` 和全屏结果页复用相同 UI。

验收：

- 完成任务先看到用户友好的结果摘要。
- 需要确认的任务有明显“等待你确认”区域。
- 长 artifact 不会直接压满页面。
- 执行链路和原始输出可以从更多区域查看。

### 阶段 6：验证与回归

验证场景：

- `awaiting_user=true` 的任务。
- `draft_review` 任务。
- `reading_digest` 任务。
- 普通 `generic_result` 且有 artifact。
- 普通 `generic_result` 且无重要结果。
- daemon 后台完成任务后浏览器重新打开。
- 会话页、Inbox、任务详情页三处状态一致。

## 风险与处理

### 重复推送

风险：前端轮询多次收到 completed progress，可能重复创建 Inbox 或会话消息。

处理：

- 使用固定 ID：`inbox-${instanceId}`、`msg-task-${instanceId}`。
- `deliveryState` 从 `pending` 改为 `delivered`。
- `upsert` 而不是单纯 `add`。

### 浏览器关闭时无法推送

风险：daemon 完成任务时前端不在线，无法立即更新 Inbox。

处理：

- 服务端 snapshot 写入 `notification`。
- 浏览器重新打开后 `RuntimeStateBridge` 同步目标状态。
- 前端扫描 `deliveryState=pending` 的 notification 并补发。

### 判定过度打扰

风险：太多普通完成结果进入 Inbox。

处理：

- 默认只推 `awaiting_user`、确认类、问答类、摘要类、高优先级、有 artifact 的任务。
- monitoring 默认静默，除非检测到重要信号。
- 后续可加“通知阈值”到彩蛋设置。

### UI 信息过载

风险：任务详情页展示 artifacts、finalMessage、timeline 后过长。

处理：

- 结果摘要默认展示。
- 产物预览默认截断。
- 执行链路和原始输出放入“更多执行细节”。

### LLM 输出不稳定

风险：依赖 Claude 额外判断会引入失败点。

处理：

- 第一版用确定性规则。
- 后续再增加可选 LLM Judge，并设置 fallback。

## 后续增强

### LLM Judge

后续可新增：

```ts
judgeTaskResultWithClaude(input, deterministicDecision)
```

只在以下情况触发：

- deterministic 认为可能需要推送但不确定。
- monitoring 任务输出较长，需要判断是否包含风险/机会。
- recurring digest 需要去重，避免每天推重复内容。

### 通知去重

可基于：

- `taskId`
- `notificationType`
- `headline`
- `primaryArtifactLabel`
- 最近 24 小时同类通知

### 用户反馈学习

Inbox 支持：

- 已读
- 忽略
- 稍后
- 有用

后续反馈可影响 Judge 阈值。

### 空闲投递

借鉴 `coding-agent`：

- 用户正在对话或任务结果抽屉打开时不弹新通知。
- 高优先级通知缩短等待时间。
- 低优先级通知只进 Inbox，不进会话。

## 推荐 MVP 范围

第一轮实现建议包含：

- 类型扩展。
- 确定性 `ResultNotificationJudge`。
- 服务端写入 `notificationDecision`。
- 前端同步 `instance.notification`。
- Inbox upsert。
- 会话任务卡更新。
- `TaskMessageCard` 使用 notification 文案。
- `ExecutionResultBody` 结果优先，更多详情折叠。

第一轮暂缓：

- LLM Judge。
- 系统级通知。
- 复杂去重。
- 用户反馈学习。
- 空闲检测投递。

## 验收标准

完成后需要满足：

- 任务执行完成后，系统能明确判断 `shouldNotify`。
- 需要用户确认的任务必定推送到 Inbox 和会话任务卡。
- 普通低价值任务不会打扰用户，但结果仍可在任务详情页查看。
- Inbox、会话卡片、任务详情页展示同一份结果语义。
- 任务详情页先展示用户友好的摘要和下一步动作，再展示更多细节。
- 后台 daemon 完成任务后，重新打开浏览器仍能看到通知语义和结果。
- 不重复推送同一任务实例。
