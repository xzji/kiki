# 任务结果内联展示与引用反馈重执行计划

## Summary

目标是把“任务完成后的反馈”从任务详情侧边栏移到对话流本身：

- 任务执行完成后，结果直接展示在任务消息卡片中，用户不需要点开侧边栏才能看到主要产出。
- 用户通过消息菜单“引用”这条任务卡片，再在输入框里输入反馈。
- 系统根据用户真实反馈语义判断后续动作：
  - 普通反馈/已阅/满意：在对话流中回复并记录反馈，不重跑。
  - 明确指出错误、遗漏、需要修改：创建一个基于原任务与原结果的修订执行实例，并在对话流中给出“已收到反馈，正在按反馈重做”的回应。
  - 反馈不明确：在对话流中追问澄清，不强行重跑。

这里不新增任务卡片上的独立反馈入口，也不把完成后反馈做成 `awaiting_user`。完成态反馈是用户对已完成产物的后处理输入，不是当前任务阻塞条件。

## Current State Analysis

### 1. 任务结果主要在侧边栏展示

文件：[TaskMessageCard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/TaskMessageCard.tsx)

当前表现：

- 会话流里的 `TaskMessageCard` 只展示标题、状态、摘要和文件/小应用 chip。
- 具体产出物通过点击卡片打开右侧 `TaskResultDrawer` 查看。
- 用户希望“任务结果直接展示到任务卡片上”，因此需要把完成态结果渲染前移到消息卡片里。

相关可复用组件：

- [GenericAgentResultView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/GenericAgentResultView.tsx)
- [ArtifactRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/ArtifactRenderer.tsx)
- [BlockRenderer.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/execution/BlockRenderer.tsx)

### 2. 引用消息已存在，但引用上下文只有文本

文件：

- [ConversationView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationView.tsx)
- [ConversationMessageItem.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationMessageItem.tsx)
- [runtime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/runtime.ts)
- [contextPack.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/contextPack.ts)

当前表现：

- 消息菜单已有“引用”。
- `ConversationView` 维护 `quotedMessage: ConversationMessage | null`。
- 传给 `AssistantComposer` 和 `streamClaudeChat` 的 quoted 数据只有：
  - `roleLabel`
  - `content`
- `task_card` 的结构化 `taskRef/taskSnapshot` 没有进入引用上下文。

问题：

- 如果用户引用任务卡片并反馈“这里不对，改成...”，后端普通聊天只能看到卡片 `content`，无法稳定定位任务、实例、结果、产物和执行轨迹。

### 3. 普通聊天链路不会自动调整任务或重跑

文件：

- [ConversationView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationView.tsx)
- [app/api/claude/chat/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/claude/chat/route.ts)

当前表现：

- 非 `/goal`、非规划恢复消息会进入 `streamClaudeChat()`。
- Claude 只在会话 workspace 中回复文本。
- 该链路不会创建新的任务实例，也不会调用任务执行 API。

问题：

- 用户引用任务结果后提出修改反馈时，如果继续走普通聊天，只能回复解释，无法真正“根据反馈重新调整任务，重新执行”。

### 4. 已有重跑能力，但没有反馈上下文

文件：

- [taskExecution.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskExecution.ts)
- [goalStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/goalStore.ts)
- [app/api/goals/tasks/execute/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/tasks/execute/route.ts)
- [goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts)

当前能力：

- `runTaskExecutionAction(taskId, "rerun")` 可以生成新的重跑实例。
- `generateRerunInstance()` 会创建新实例，保留原结果。
- 任务执行 prompt 已支持 `resumeContext`，但普通 `execute` route 目前不接收用户反馈上下文。

问题：

- 现有重跑是“重新按原要求执行”，不能明确吸收用户引用反馈。
- 需要新增“反馈驱动重跑”路径，把用户反馈、原结果摘要、原轨迹传入新实例执行。

### 5. 完成态反馈不应复用 awaiting_user

相关已有组件：

- [AwaitingUserResumePanel.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/AwaitingUserResumePanel.tsx)
- [app/api/goals/tasks/resume/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/tasks/resume/route.ts)

当前 `awaiting_user/resume` 语义：

- 用于执行中缺用户输入、用户确认或阻塞恢复。
- 会把任务状态切到 `awaiting_user` 或重新置为 running。

决策：

- 完成后的反馈不是阻塞恢复，不应复用 `awaiting_user`。
- 应建立独立的“引用反馈编排”入口。

## Proposed Changes

### 1. 任务卡片内联展示 Agent 产出物

文件：

- [TaskMessageCard.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/TaskMessageCard.tsx)
- [ExecutionResultBody.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/ExecutionResultBody.tsx)

做法：

- 本次重点只覆盖当前主链路的 Agent 产出物，也就是 `generic_result` / `taskResult.blocks` / `artifactRefs` / webapp / external_embed。
- 抽出一个轻量的 `TaskInlineResultView`，复用 `GenericAgentResultView` 渲染 blocks / artifactRefs，避免消息卡片和侧边栏各自维护一套 Agent 产物展示逻辑。
- 代码里确实还存在一些早期固定交互视图：
  - `flashcard`
  - `listening_qa`
  - `reading_digest`
  - `confirm_action`
  - `draft_review`
- 这些“内置任务结果”不是本次产品主链路，不在本次新增反馈重跑范围内；本次只保证不破坏它们现有在侧边栏里的展示和完成逻辑。
- 当实例满足以下条件时，在卡片内直接渲染结果：
  - `instance.status === "completed"`
  - `instance.result?.taskResult` 有 `blocks` 或 `artifactRefs`
  - `task.resultViewKind ?? task.executionKind` 是 `generic_result`，或 `instance.payload.kind === "generic_result"`
- 保留点击整张卡片打开侧边栏的能力，作为详情和执行链路入口。
- 为避免卡片内交互误触发打开侧边栏：
  - 结果区域外层加 `onClick={(event) => event.stopPropagation()}`。
  - 文件下载、webapp、外部嵌入等交互不冒泡。
- 对卡片内结果设置合理边界：
  - 使用 `max-h` + 内部滚动，避免长报告把整条会话流撑得过长。
  - 对 webapp / external_embed 优先显示预览容器；如高度不适合消息流，保留“在侧边栏展开”的入口。
- 结果区域标题采用设计系统风格，例如：
  - `任务结果`
  - `已生成的产出`
- 对 `pending/awaiting_user/in_progress/error/paused` 不展示完成结果，只保留摘要、等待面板或状态。

为什么：

- 满足用户“不需要点到侧边栏才能看到”的诉求。
- 聚焦当前真正使用的 Agent 产出物链路，避免为了历史内置组件扩大改动面。
- 仍保留侧边栏承载更完整的执行链路和任务详情。

### 2. 引用任务卡片时携带结构化任务引用

文件：

- [runtime.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/types/runtime.ts)
- [ConversationView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationView.tsx)
- [contextPack.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/workspace/contextPack.ts)

做法：

- 扩展 `ClaudeChatRequest.quotedMessage` 类型，增加可选字段：
  - `messageId`
  - `messageKind`
  - `taskRef?: { goalId; subGoalId; taskId; instanceId }`
- `ConversationView` 构造 quoted 数据时：
  - 如果 `quotedMessage.kind === "task_card"`，附带 `taskRef`。
  - `content` 不再只用原始 `message.content`，而是使用 `buildTaskQuoteContent(task, instance)` 生成用户可读摘要：
    - 任务标题
    - 状态
    - 结果摘要
    - 主要 block 标题/文件名
  - 这样输入框引用预览也能显示“用户正在反馈哪个任务结果”，而不是只显示 `instance.intro`。
- `contextPack.buildConversationContextPack()` 中，如果引用的是任务卡片：
  - 输出任务标题、状态、实例 ID、结果摘要、最终消息。
  - 输出 `taskResult` 的简要结构化摘要，例如 block 类型、标题、artifactRefs 列表。
  - 不把完整大块 HTML/webapp 内容塞入普通聊天上下文，避免 token 膨胀。

为什么：

- 普通对话可以理解用户反馈指向哪个任务结果。
- 后续反馈编排 API 可以稳定定位任务和实例。

### 3. 新增“任务结果反馈编排”API

新增文件：`src/app/api/goals/tasks/feedback/route.ts`

输入：

- `conversationId`
- `message`
- `taskRef`
- `runtimeEnv`
- 可选 `claudeSessionId`

输出：

- `decision: "acknowledge" | "clarify" | "rerun"`
- `assistantMessage`
- `progress?`
- `logs?`
- `trajectory?`
- `taskCardMessage?` 或 `taskInstanceId?`

处理流程：

1. 根据 `taskRef` 从 `readGoalsSnapshot()` 定位 `goal/subGoal/task/instance`。
2. 只允许处理已完成或有结果的任务实例。
3. 构造反馈判断 prompt，让 Claude 根据用户真实反馈判断；该 prompt 明确禁止仅靠关键词，必须结合原结果和用户反馈意图：
   - `acknowledge`：用户只是评价、感谢、已阅、满意、表达偏好但不要求修改当前任务。
   - `clarify`：用户表达不满或想改，但缺少足够具体的修改方向。
   - `rerun`：用户指出错误、遗漏、事实不准、格式不对、要求补充/替换/重写/重新生成。
4. Claude 必须返回严格 JSON：
   - `decision`
   - `reason`
   - `assistant_message`
   - `revision_context`
   - `clarifying_question?`
5. 对分类 JSON 做修复与校验：
   - 复用现有 JSON 提取/修复工具模式。
   - 校验 `decision` 必须是三选一。
   - 校验 `assistant_message` 非空。
   - 如果判定为 `rerun`，`revision_context` 必须非空；否则降级为 `clarify`。
6. 对 `acknowledge`：
   - 只返回 `assistantMessage`。
   - 可将反馈写入当前实例 `result.structuredOutput.userFeedbackHistory`。
7. 对 `clarify`：
   - 只返回追问消息。
   - 不创建任务实例。
8. 对 `rerun`：
   - 创建新的重跑实例。
   - 将 `revision_context`、用户反馈、原结果摘要、原实例 ID 放入新执行的 `resumeContext`。
   - 启动任务执行队列。
   - 返回一个 assistant 文本回应，并让前端追加新的任务卡片消息。

为什么：

- 用户要求“不是按规则写死，而是根据用户真实反馈判断”。
- 用 Claude 做语义分类和修订上下文提取，规则只做安全边界和路由，不做硬编码判断。

### 3.1 反馈记录和幂等保护

文件：

- 新增 `src/lib/taskFeedback.ts`
- [goalStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/goalStore.ts)
- [app/api/goals/tasks/feedback/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/tasks/feedback/route.ts)

做法：

- 定义轻量反馈记录结构，存入 `instance.result.structuredOutput.userFeedbackHistory`：
  - `id`
  - `sourceMessageId`
  - `userMessage`
  - `decision`
  - `assistantMessage`
  - `revisionContext?`
  - `createdAt`
  - `rerunInstanceId?`
- 反馈 API 接收 `sourceMessageId` 或客户端生成的 `feedbackId`。
- 如果同一 `sourceMessageId + taskInstanceId` 已处理过：
  - 返回已有处理结果。
  - 不重复创建重跑实例。
- 如果同一个源实例已有 running/queued 的反馈重跑：
  - 回复“修订执行已在进行中”，并返回已有实例引用。

为什么：

- 防止用户连续点击发送、网络重试、SSE 重连导致多个重复重跑实例。
- 保留反馈历史，方便后续上下文和调试。

### 4. 新增客户端 API 封装

文件：[taskRuns.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/api/taskRuns.ts)

新增函数：

- `submitTaskResultFeedback(input)`

职责：

- POST `/api/goals/tasks/feedback`
- 返回反馈编排结果。
- 供 `ConversationView` 在用户引用任务卡片时调用。

### 5. ConversationView 拦截“引用任务卡片 + 用户反馈”

文件：[ConversationView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationView.tsx)

做法：

- 在普通聊天分支之前增加分支：
  - `quotedMessage?.kind === "task_card"`
  - 能通过 `resolveTaskCardInfo()` 定位到任务实例
  - 实例 `status === "completed"` 或已有 `result.taskResult`
- 该分支执行：
  1. 追加用户消息。
  2. 追加 KiKi streaming 文本消息，例如 `正在理解你对任务结果的反馈...`。
  3. 调用 `submitTaskResultFeedback()`。
  4. 根据 API 返回更新 KiKi 消息：
     - `acknowledge`：回复“已记录反馈...”。
     - `clarify`：回复追问。
     - `rerun`：回复“已按反馈创建修订执行...”。
  5. 如果 `rerun` 返回新实例：
     - `syncTaskInstanceRun()` 同步 running/queued 进度。
     - 追加新的 `task_card` 消息，引用新实例。
     - 轮询 `fetchTaskRunProgress()` 或复用 `waitForTaskRunCompletion()` 同步执行状态。
- 该分支必须优先于普通 `streamClaudeChat`，否则用户反馈只会变成普通聊天回复，无法触发重跑。
- 如果用户引用的是任务卡片但实例不是 completed：
  - awaiting_user：提示用户先完成当前等待项。
  - in_progress：提示任务仍在执行，反馈可先记录但暂不重跑。
  - error/paused：建议先重试或恢复任务。
- 最后清空引用。

为什么：

- 用户反馈后应该在消息对话流中给出回应。
- 引用任务结果是明确的上下文触发器，不需要任务卡片里再放反馈入口。

### 6. 反馈驱动重跑携带修订上下文

文件：

- [taskExecution.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskExecution.ts)
- [goalStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/goalStore.ts)
- [app/api/goals/tasks/execute/route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/tasks/execute/route.ts)
- [goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts)

做法：

- `generateRerunInstance()` 支持可选 `revisionContext`：
  - `sourceInstanceId`
  - `userFeedback`
  - `revisionInstruction`
  - `createdAt`
- 可放入 `instance.result?.structuredOutput.revisionRequest` 或新增轻量字段；推荐放入 `structuredOutput`，避免扩大核心类型。
- `execute/route.ts` 接收可选 `resumeContext` 或 `revisionContext`。
- `createQueuedRuntimeJob()` payload 传入 `resumeContext`。
- `goalTaskPrompt.ts` 在恢复执行模式中明确：
  - 这是“用户反馈驱动的修订重跑”。
  - 必须优先修正用户指出的问题。
  - 可以复用原结果，但不能忽略反馈。
  - 最终仍必须输出完整可验收产物。
- 对多角色协同任务，`resumeContext` 也要进入 agent orchestration 路径，不能只进入 single_agent prompt；否则多 Agent 任务会忽略用户反馈。
- `buildTaskContextPack()` 中加入 `resumeContext` 已有能力，反馈重跑应复用该上下文写入 workspace。

为什么：

- 现有 rerun 只基于原任务，不知道用户为什么不满意。
- 修订上下文必须进入任务执行 prompt，才能真正“根据反馈重新调整任务”。

### 6.1 反馈分类模型调用方式

文件：

- `src/app/api/goals/tasks/feedback/route.ts`
- 可能新增 `src/lib/server/taskFeedbackJudge.ts`

做法：

- 不复用普通聊天 `claudeSessionId` 作为自由对话上下文，避免分类受长对话漂移影响。
- 使用一个独立、短上下文的 Claude 调用：
  - 输入：任务要求、原结果摘要、用户反馈。
  - 输出：严格 JSON。
- 如果本地 Runtime 不可用：
  - 不做分类和重跑。
  - 返回需要连接 Runtime 的 assistantMessage。

为什么：

- 用户要求“根据真实反馈判断”，但判断应围绕任务结果本身，而不是被普通聊天上下文带偏。
- 独立分类器更可控，也方便 JSON 校验和降级。

### 7. 任务卡片消息生成与快照同步

文件：

- [ConversationView.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/ConversationView.tsx)
- [conversationStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/conversationStore.ts)

做法：

- `rerun` 决策创建新实例后，追加新的 `task_card` 消息：
  - `content`: `已根据你的反馈重新执行「任务名」。`
  - `taskRef`: 指向新实例。
  - `taskSnapshot`: 包含新实例初始快照。
- 后续进度由 `goalStore` 驱动卡片实时更新。
- 原任务卡片保留，形成版本历史。

为什么：

- 用户反馈后，所有回应都在对话流中完成。
- 新旧结果并列存在，便于对比，不覆盖历史。

### 8. 安全和边界处理

做法：

- 只允许引用当前会话目标内的任务卡片触发反馈编排。
- 如果 `taskRef` 找不到或实例没有结果，回退普通聊天并提示无法定位任务结果。
- 如果 Runtime 未连接或离线：
  - 可以记录反馈并回复需要连接 Runtime 才能重做。
  - 不创建重跑实例。
- 如果已有同一实例的修订重跑正在执行：
  - 回复已有修订任务进行中，不重复创建。
- 如果反馈分类失败：
  - 回复“我没能判断你是否希望重做，请明确说明要修改哪里”。
- 对恶意反馈或越权请求：
  - 只能修改被引用任务的结果。
  - 不能修改其他目标、其他会话、宿主源码或本地敏感路径。
  - 反馈重跑仍遵守任务执行 workspace 隔离和现有 artifact/webapp 安全策略。

## Omission Audit

本轮检查后补齐的遗漏：

- **内置视图边界**：代码里存在 flashcard、listening_qa、reading_digest、confirm_action、draft_review 等历史固定交互视图；它们不是本次主链路，本计划只确保不破坏，不把它们纳入反馈重跑范围。
- **引用预览**：原计划没有要求输入框引用预览展示结果摘要，现在补充 `buildTaskQuoteContent()`。
- **幂等保护**：原计划没有处理重复提交导致多次重跑，现在增加 `feedbackId/sourceMessageId` 去重。
- **分类可靠性**：原计划没有 JSON 修复/校验，现在增加严格校验和降级策略。
- **多 Agent 路径**：原计划只隐含 single agent prompt，现在明确 `resumeContext` 必须进入 orchestration。
- **非 completed 状态**：原计划只处理完成态，现在补充 awaiting/in_progress/error/paused 的边界反馈。
- **安全边界**：原计划没有明确越权边界，现在限制反馈只能作用于被引用任务。

## Assumptions & Decisions

- 完成态反馈不属于 `awaiting_user`，不改变原任务的完成状态。
- 任务结果直接展示在任务卡片内，侧边栏仍保留为详情入口。
- 用户通过引用任务卡片表达反馈；任务卡片不新增单独反馈输入框。
- 是否重跑由 Claude 根据反馈语义判断，不通过关键词硬编码。
- 明确需要修改时创建新实例，不覆盖原结果。
- 用户反馈后的所有回应都进入对话消息流。
- 不引入数据库迁移；反馈历史和修订上下文优先存入现有 JSON 结构。
- 反馈分类使用 Claude 判断语义，但仍由系统做三选一结构校验、幂等和安全边界控制。

## Verification Steps

1. 完成态结果内联展示：
   - 执行一个 `generic_result` 任务。
   - 任务完成后，卡片内直接显示 blocks / 文件产物。
   - 不打开侧边栏也能看到主要结果。

2. 普通反馈：
   - 引用完成任务卡片，输入“不错，可以”。
   - KiKi 在对话流回复已收到/已记录。
   - 不创建新任务实例。

3. 修改反馈：
   - 引用完成任务卡片，输入“这个城市对比缺少岘港，补上并重新排序”。
   - KiKi 回复正在按反馈修订。
   - 新增一个 task_card 消息。
   - 新实例带反馈上下文执行。

4. 模糊反馈：
   - 引用完成任务卡片，输入“这个不太对”。
   - KiKi 追问具体哪里不对。
   - 不创建新执行实例。

5. 重跑结果：
   - 新实例完成后，结果卡片内联显示新产物。
   - 原实例结果仍保留。

6. 引用非任务消息：
   - 引用普通 KiKi 文本或用户消息发送反馈。
   - 继续走普通聊天链路。

7. Runtime 异常：
   - Runtime 离线时引用任务卡片要求修改。
   - KiKi 提示需要连接 Runtime 才能重新执行，不误创建 running 卡片。

8. 静态检查：
   - 对新增/修改文件运行 VS Code diagnostics。
   - 如有可用脚本，运行相关 typecheck/lint。

9. 内置视图回归：
   - 如现有 mock 或旧任务包含 flashcard/listening/reading/draft_review，确认侧边栏原有展示不受影响。
   - 本次不要求这些历史内置视图进入消息卡片内联反馈重跑链路。

10. 重复提交：
   - 引用同一任务结果连续发送相同反馈或模拟网络重试。
   - 只创建一个修订实例。
   - 第二次返回已有修订任务提示。
