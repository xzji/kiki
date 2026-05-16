# 修复“继续”没有从断点恢复的方案

## Summary

本次问题的核心不是 checkpoint 丢失，而是前端恢复入口只依赖浏览器本地 `conversation.planningRunState`。当该状态因刷新、热更新、状态同步覆盖或会话重建而丢失时，输入“继续”不会调用目标规划恢复链路，而是落入普通 Claude 对话链路。普通对话只能读取 `context.md` 文本，无法调用 `/api/goals/plan` 的 `resumeFromCheckpoint`，因此会出现“看起来说完成了，但没有真正生成规划卡片”的假完成状态。

目标：让“继续/恢复/重试”等意图在本地状态丢失但 workspace checkpoint 仍存在时，也能真正从 `planning/checkpoint.json` 继续生成目标规划，并在成功后生成正式 `goal_plan_card`。

## Current State Analysis

### 已确认事实

- `conv-new-1778936217893` 的 checkpoint 仍存在：
  - 文件：`data/workspaces/conversations/conv-new-1778936217893/planning/checkpoint.json`
  - `goalText`: `托福考试110`
  - `status`: `running`
  - `stage`: `generating_tasks`
  - `completedSubGoals`: 已完成 1 个子目标
  - `nextSubGoalIndex`: `1`
  - `collectedInfo`: 包含用户回答“当前托福90，7.1考试，每天2小时”
- `ConversationView.onSend()` 当前只有在 `conversation.planningRunState?.status === "failed"` 且输入匹配“继续/重试/恢复”时，才会走 `resumeGoalWorkflowFromRecovery()`。
- 如果 `planningRunState` 不存在，`继续` 会继续向下执行普通聊天链路 `streamClaudeChat()`。
- 普通聊天链路不会调用 `/api/goals/plan`，不会传 `resumeFromCheckpoint: true`，也不会创建 `Goal` 或把消息更新成 `kind: "goal_plan_card"`。
- `context/messages.json` 中已记录用户输入“继续”，但没有对应的 `goal_plan_card` 消息，说明它没有走真正的目标规划恢复分支。
- `/api/runtime/state` 当前不持久化 conversations，`RuntimeStateBridge` 只同步 goals/runtimeEnvironments/scheduleEvents。因此服务端 state 缺少该 conversation 不代表浏览器没有该会话，但也说明不能依赖 runtime state 来恢复会话级 planning 状态。
- `POST /api/runtime/state/sync 409` 会导致 goals 被远端快照覆盖，有可能让新建 goal 丢失，但这不是“继续没有进恢复分支”的首因；首因是恢复入口没有 fallback 到 workspace checkpoint。

### 根因

1. 恢复入口过窄：
   - 当前恢复条件是 `conversation.planningRunState.status === "failed"`。
   - 实际断点权威数据在 workspace 的 `planning/checkpoint.json`。
   - 当前前端没有任何机制在 `planningRunState` 丢失时探测 checkpoint。

2. checkpoint 只在服务端可读，前端无法直接判断：
   - `readGoalPlanningCheckpoint()` 是 `goalPlanning.ts` 内部函数。
   - 当前没有 API 给前端查询“这个 conversation 是否有可恢复规划断点”。

3. 普通聊天会误导用户：
   - 输入“继续”落入 `streamClaudeChat()` 后，Claude 根据 `context.md` 自然语言回答。
   - 它可能输出“目标规划已完成”这类文本，但这不是结构化规划结果。
   - 没有 `goalRef`，没有 `Goal`，没有 `goal_plan_card`，右侧规划详情自然打不开。

4. 中断后的 checkpoint 状态表达不够准确：
   - `generateGoalPlanWithClaude()` 在 `AbortError` 时不会把 checkpoint 标记为 `failed/interrupted`，所以文件仍可能显示 `status: "running"`。
   - 虽然这不阻止恢复，但会让 UI 判断和调试更困惑。

## Proposed Changes

### 1. 增加服务端 checkpoint 查询能力

文件：`src/lib/server/goalPlanning.ts`

- 导出只读函数 `getGoalPlanningCheckpointStatus(conversationId)`。
- 返回最小必要信息：
  - `available`
  - `goalText`
  - `status`
  - `stage`
  - `completedSubGoalCount`
  - `totalSubGoalCount`
  - `nextSubGoalIndex`
  - `updatedAt`
  - `collectedInfo` 是否存在，不直接暴露完整长文本给 UI，除非恢复 API 内部需要。
- 对 `status === "completed"` 的 checkpoint 返回 `available: false`，避免重复恢复已完成计划。

新增文件：`src/app/api/goals/plan/checkpoint/route.ts`

- `GET /api/goals/plan/checkpoint?conversationId=...`
- 校验 `conversationId`。
- 调用 `getGoalPlanningCheckpointStatus()`。
- 返回：
  - `200 { available: true, checkpoint: ... }`
  - `200 { available: false }`

为什么需要：

- 前端在用户输入“继续”前能先判断是否确实有可恢复断点。
- 避免把普通会话里的“继续”误拦截成目标恢复。

### 2. 增加服务端 checkpoint 恢复入口

文件：`src/lib/server/goalPlanning.ts`

- 导出函数 `getGoalPlanningCheckpointForResume(conversationId)` 或在新 API 内部使用现有 `readGoalPlanningCheckpoint()`。
- 恢复时必须使用 checkpoint 中的原始参数：
  - `goalText`
  - `collectedInfo`
- 这样可以满足 `isCheckpointCompatible()` 的精确匹配要求，避免前端从消息里猜 `collectedInfo` 导致不兼容并从头开始。

新增文件：`src/app/api/goals/plan/resume/route.ts`

- `POST /api/goals/plan/resume`
- body:
  - `conversationId`
  - `runtimeEnv`
  - `config`
  - `conversationContext`
- 服务端读取 checkpoint：
  - 不存在或已完成：返回 `404/409`
  - 存在且未完成：调用 `generateGoalPlanWithClaude({ goalText: checkpoint.goalText, collectedInfo: checkpoint.collectedInfo, resumeFromCheckpoint: true, ... })`
- 沿用 telemetry：
  - requestId 使用 `goal-plan-resume-*`
  - 进度仍写入 `/api/goals/progress`
- 返回 `{ draft }`，与现有 `/api/goals/plan` 保持一致。

为什么需要：

- 让 checkpoint 恢复不依赖浏览器本地 `planningRunState`。
- 让服务端作为断点恢复的权威来源，避免前端拼错 `goalText/collectedInfo`。

### 3. 增加前端 API wrapper

文件：`src/lib/api/goals.ts`

- 新增 `getGoalPlanCheckpoint(conversationId, signal?)`。
- 新增 `resumeGoalPlanFromCheckpoint(input)`。
- `resumeGoalPlanFromCheckpoint()` 复用 `withGoalProgressPolling()`，与现有 `generateGoalPlan()` 保持同样的进度回调机制。

返回类型：

- `getGoalPlanCheckpoint()` 返回 `{ available: boolean; checkpoint?: ... }`。
- `resumeGoalPlanFromCheckpoint()` 返回 `GoalBreakdownDraft`。

### 4. 重构目标规划提交逻辑，避免重复代码

文件：`src/lib/goalWorkflow.ts`

- 抽取 `commitGoalDraftToStores(input)`：
  - `goalStore.createGoalFromDraft(draft, { conversationId })`
  - `conversationStore.setGoalForConversation(conversationId, goal.id)`
  - `conversationStore.renameConversation(conversationId, draft.goalTitle)`
  - `conversationStore.setGoalInfoCollection(conversationId, null)`
  - `clearPlanningFailure(conversationId)`
  - `writeCurrentConversationContext(conversationId, goal.id)`
  - 返回 `GoalWorkflowResult`
- 让 `runGoalPlanning()` 和新的 checkpoint 恢复函数共用该提交逻辑。

新增函数：

- `hasRecoverableGoalPlanCheckpoint(conversationId)`
- `resumeGoalWorkflowFromCheckpoint(input)`

`resumeGoalWorkflowFromCheckpoint()` 流程：

1. 读取 active Claude runtime。
2. 调用 `resumeGoalPlanFromCheckpoint()`。
3. 使用 `commitGoalDraftToStores()` 生成 goal 并绑定 conversation。
4. 返回 `kind: "planned"` 结果，供 `ConversationView` 更新为 `goal_plan_card`。

### 5. 修改 `ConversationView` 的“继续”分流

文件：`src/components/conversation/ConversationView.tsx`

当前逻辑：

- 只有 `conversation.planningRunState.status === "failed"` 才走恢复。

修改后逻辑：

1. 如果输入匹配 `shouldResumePlanningFromMessage(text)` 且不是 `/goal`：
   - 如果 `planningRunState.status === "failed"`：沿用 `resumeGoalWorkflowFromRecovery()`。
   - 否则先调用 `getGoalPlanCheckpoint(conversation.id)`。
   - 如果 checkpoint 可用：走 `resumeGoalWorkflowFromCheckpoint()`。
   - 如果 checkpoint 不可用：继续走普通聊天，不拦截。

2. 恢复分支的消息更新必须保持一致：
   - 先 append 用户消息。
   - append KiKi streaming 消息：“正在从已保存断点继续目标规划...”
   - 进度用 `appendGoalProgressMessage()` 累加。
   - 成功后必须 `updateMessage(... kind: "goal_plan_card", goalRef: ... )`。
   - 失败时展示 `planningFailureMessage(error)`，并保留可继续提示。

3. 防止假完成：
   - 只有目标恢复/目标规划 API 返回 `GoalWorkflowResult` 后，才允许显示“目标规划草案已生成”。
   - 普通聊天不应出现“目标规划已完成”卡片样式；如果只是文本，就是普通回答。

### 6. 修正 checkpoint 中断状态

文件：`src/lib/server/goalPlanning.ts`

- 在 `generateGoalPlanWithClaude()` catch 中，针对 `AbortError` 也写回 checkpoint：
  - `status: "interrupted"` 或继续沿用当前类型可接受的 `failed`
  - `stage`: 保留当前阶段
  - `updatedAt`: 刷新
- 如果现有类型只允许 `running | completed | failed`，则使用 `failed`，并在 checkpoint 增加 `lastError: "任务生成已中断"` 或 `interrupted: true`。
- `isCheckpointCompatible()` 仍允许 `running/failed/interrupted` 恢复，只排除 `completed`。

为什么需要：

- 避免 UI 和日志看到 checkpoint 仍是 `running`，误以为后台还在跑。
- 让 checkpoint 状态与实际中断一致。

### 7. 降低 runtime state sync 409 对新 goal 的影响

文件：`src/components/providers/RuntimeStateBridge.tsx`

当前行为：

- sync 失败后直接 fetch 远端 snapshot 并 `replaceGoals(snapshot.goals)`。
- 如果本地刚创建了新 goal，而 sync 因 revision 过期返回 409，远端快照可能还不包含这个新 goal，导致本地新 goal 被覆盖。

修复方案：

- 409 后不要无条件 `replaceGoals()`。
- 对 goals 做按 `id` 合并：
  - 远端 goal 保留。
  - 本地新增且远端没有的 goal 保留。
  - 同 id 时用 `updatedAt/lastUpdatedAt` 或现有对象优先策略合并。
- 或者在 409 后重新 fetch，再用最新 revision 重试一次 sync 本地 goals。

本问题首因不是 409，但它会造成“规划完成后 goal 消失”的二次问题，建议一起修。

## Assumptions & Decisions

- checkpoint 是目标规划断点的权威来源，浏览器本地 `planningRunState` 只是 UI 提示状态。
- 输入“继续/恢复/重试”等词时，只有当前 conversation 有可恢复 checkpoint 才拦截，否则仍走普通聊天。
- 恢复必须使用 checkpoint 内保存的 `goalText` 和 `collectedInfo`，不从历史消息猜测。
- 成功恢复后必须生成 `goal_plan_card`，不能只输出普通文本。
- 已完成 checkpoint 不重复恢复，避免重复生成 goal。
- 本次不改变任务执行 worker 的恢复机制，只修目标规划阶段。

## Verification Steps

1. 单元/静态验证：
   - `pnpm lint`
   - `GetDiagnostics` 检查改动文件。

2. checkpoint 查询验证：
   - 对 `conv-new-1778936217893` 调用 `GET /api/goals/plan/checkpoint?conversationId=conv-new-1778936217893`。
   - 期望返回 `available: true`、`goalText: 托福考试110`、`completedSubGoalCount: 1`、`totalSubGoalCount: 5`。

3. 恢复 API 验证：
   - 调用 `POST /api/goals/plan/resume`。
   - 期望日志出现“已读取 checkpoint，将从已完成子目标 1/5 后继续规划”。
   - 期望从 `子目标 2/5` 开始继续，而不是从头生成。

4. 前端交互验证：
   - 打开 `conv-new-1778936217893`。
   - 输入“继续”。
   - 期望 KiKi 消息显示“正在从已保存断点继续目标规划...”，进度累加展示。
   - 完成后该消息变为 `goal_plan_card`。
   - 点击卡片或右上角“目标规划”可打开规划详情。

5. 负向验证：
   - 在没有 checkpoint 的普通会话里输入“继续”。
   - 期望不触发目标恢复，仍走普通聊天。

6. 中断验证：
   - 恢复过程中点击停止。
   - 期望 checkpoint 标记为可恢复的中断/失败状态。
   - 再次输入“继续”可以从最近 checkpoint 接着跑。

7. sync 409 验证：
   - 模拟 goals revision 冲突。
   - 期望本地刚生成的 goal 不会被远端旧 snapshot 覆盖。
