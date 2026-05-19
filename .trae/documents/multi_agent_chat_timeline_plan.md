# 多 Agent 群聊式执行链路计划

## Summary

将任务详情页的“执行过程”从线性日志流升级为多 Agent 群聊式展示：每个 Agent 拥有稳定头像、名字、角色说明和自己的执行消息；工具调用、移交、审阅打回、最终合成都作为该 Agent 的消息或系统消息展示。同时保证这些执行过程在运行中、任务完成后、页面刷新后都能从持久化数据恢复。

## Current State Analysis

- `src/types/executionTrajectory.ts` 当前的 `ExecutionTrajectoryStep` 只有 `agentRole?: AgentRole`、`thought`、`toolCall`、`toolResult`、`handoff` 等字段，足以表达“属于哪个角色”，但缺少 UI 所需的稳定 `agentId / agentName / avatar / messageKind / visibility / contentSummary`。
- `src/lib/server/agentOrchestration/MultiAgentOrchestrator.ts` 当前在 `runRole()` 中写入角色开始、工具调用、角色完成、错误和移交轨迹；但写入的是通用轨迹步骤，不是完整的 Agent 对话事件。
- `src/components/goal/TaskDetailBody.tsx` 当前任务详情内使用 `ExecutionMessageStream` 渲染执行过程；它只是线性消息流，工具调用用灰色 pill 展示，非工具消息没有 Agent 头像和名字。
- `src/components/goal/TaskDetailBody.tsx` 内还有一份独立的 `trajectoryToTimeline()`，会把 `ExecutionTrajectoryStep` 投影成 `TaskExecutionStep`；如果只扩展 `ExecutionTrajectoryStep`，新 UI 字段会在这里丢失。
- `src/components/task/TaskExecutionTimeline.tsx` 当前有 `AgentRunPlanTimeline`，但它是摘要卡片，不是执行过程 UI；任务详情页没有使用这个组件。
- `src/lib/server/repositories/runtimeJobsRepository.ts` 已将 `trajectory` 持久化到 SQLite 的 `runtime_jobs.trajectory_json`。
- `src/app/api/goals/tasks/progress/route.ts` 已从 runtime job 返回 `trajectory`，运行中的任务轮询可拿到轨迹；但它当前在没有 `progress/logs` 时会返回 404，即使 runtime job 已有 `trajectory`，需要补齐。
- `src/stores/goalStore.ts` 的 `syncTaskInstanceRun()` 会把轮询到的 `trajectory` 写回 `TaskInstance.trajectory`，页面刷新后本地状态可以恢复。
- `src/stores/goalStore.ts` 的 `normalizeTimelineFromTrajectory()` 也会投影成 `TaskExecutionStep`，需要同步保留新 UI 字段。
- `src/lib/server/goalTaskRunner.ts` 的 `appendTrajectory()` 会调用 `persistTrajectorySnapshot()`，完成后也会把 `trajectory` 写进最终结果链路；因此持久化链路已存在，但需要扩展事件内容和 UI 投影。
- `src/lib/server/workspace/conversationWorkspace.ts` 的 `writeTaskRunSnapshot()` 会把最终 `trajectory` 写到任务 workspace 的 `trajectory.json`，这是本次持久化验收的文件层证据。
- `src/lib/server/worker/taskDispatchWorker.ts` 在 worker 完成/失败时会把 `latestTrajectory` 写入 runtime job、goals snapshot 和 `trajectory.json`，需要确认新增字段不会在合并去重时丢失。

## Proposed Changes

### 1. 扩展执行轨迹类型

文件：`src/types/executionTrajectory.ts`

做法：
- 在 `ExecutionTrajectoryStep` 上新增 UI 安全字段：
  - `agentId?: string`
  - `agentName?: string`
  - `agentAvatar?: { label: string; tone: "blue" | "purple" | "green" | "orange" | "slate" }`
  - `messageKind?: "role_start" | "agent_message" | "tool_call" | "tool_result" | "handoff" | "review" | "result" | "error" | "system"`
  - `content?: string`
  - `contentSummary?: string`
  - `attempt?: number`
- 保留已有 `agentRole`、`thought`、`toolCall`、`toolResult`、`handoff` 字段，保证旧数据可继续渲染。
- 不保存模型 raw output、隐藏提示词或内部上下文，只保存面向用户的执行过程内容、摘要、工具名、工具摘要和移交摘要，避免再次引入元数据膨胀或敏感信息泄露。

原因：
- 群聊 UI 需要稳定的展示身份和消息类型。
- 仅依赖 `agentRole + title + thought` 会导致 UI 逻辑需要猜测消息语义，难以长期维护。

### 1.1 同步扩展 TaskExecutionStep 投影类型

文件：`src/types/kiki.ts`

做法：
- 在 `TaskExecutionStep` 上新增与 UI 渲染相关的 optional 字段：
  - `agentId?: string`
  - `agentName?: string`
  - `agentAvatar?: { label: string; tone: "blue" | "purple" | "green" | "orange" | "slate" }`
  - `messageKind?: "role_start" | "agent_message" | "tool_call" | "tool_result" | "handoff" | "review" | "result" | "error" | "system"`
  - `content?: string`
  - `contentSummary?: string`
  - `attempt?: number`
- `ExecutionTrajectoryStep` 是服务端和持久化源，`TaskExecutionStep` 是前端展示投影，两者都要扩展，否则新字段会被 normalize 丢弃。

原因：
- `TaskDetailBody.tsx` 和 `goalStore.ts` 当前都渲染 `TaskExecutionStep[]`，如果只改 `ExecutionTrajectoryStep`，群聊 UI 无法拿到头像、名字、消息类型。

### 2. 增加 Agent 显示元信息工具

文件：新增 `src/lib/agentDisplay.ts`

做法：
- 定义 `getAgentDisplay(role: AgentRole, attempt?: number)`，返回：
  - 名字：`Coordinator`、`Researcher`、`Executor`、`Reviewer`、`Synthesizer`
  - 中文职责短句
  - 头像 label：`C / R / E / V / S`
  - 颜色 tone
- 前后端共用该工具，避免 orchestrator、timeline、mock 三处各维护一套 label。

原因：
- 当前 `TaskExecutionTimeline.tsx` 和 `MultiAgentOrchestrator.ts` 内各自有角色 label，后续群聊 UI 会进一步放大重复。

### 3. 后端写入群聊式轨迹事件

文件：`src/lib/server/agentOrchestration/MultiAgentOrchestrator.ts`

做法：
- 在 `runRole()` 开始时写入：
  - `messageKind: "role_start"`
  - `agentRole / agentName / agentAvatar / attempt`
  - `contentSummary`: 该角色本轮目标
- 在收到 `message` 事件时不逐 token 保存，只在角色完成时保存 UI 安全摘要：
  - `messageKind: "agent_message"` 或 synthesizer 使用 `"result"`
  - `content`: `finalMessage.slice(0, 2000)`，保持当前上限
  - `contentSummary`: 前 300 字摘要或同内容截断
- 在 `tool_call` 事件时写入：
  - `messageKind: "tool_call"`
  - 工具名、工具输入摘要、agent 身份
- 在角色失败时写入：
  - `messageKind: "error"`
  - `content`: 错误摘要
- 在 `normalizeHandoff()` 后写入：
  - `messageKind: "handoff"`
  - `handoff.fromRole / toRole / summary`
  - 用系统消息样式展示，也要持久化。
- Reviewer blocking 打回时，第二轮 Executor / Reviewer 的 `attempt` 写入 `2`，对应 UI 显示“Executor · 第 2 轮”。

原因：
- 现有轨迹已经持久化到 `runtime_jobs.trajectory_json`，只需增强写入内容即可满足“过程持久化”。
- 控制保存内容为 UI 安全摘要，可以兼顾可回放与隐私/体积。

### 4. 保证最终结果也包含完整执行过程

文件：`src/lib/server/goalTaskRunner.ts`

做法：
- 保持 `appendTrajectory()` 每次写入都调用 `persistTrajectorySnapshot()`。
- 检查所有 `return { ... result, trajectory }` 分支，确保多 Agent 成功、失败、等待用户、验收失败分支都带 `trajectory`。
- 在 `progressPayloadWithTrajectory()` 中继续返回完整 `trajectory`，供运行中轮询展示。
- 不把执行过程重复塞进 `taskResult.meta.agentRunPlan.roles.rawOutput`，继续只保存 `AgentRunPlan` 摘要；详细过程以 `trajectory` 为准。

原因：
- 用户要求“agent执行过程都应该持久化保存下来”，持久化源应统一为 `trajectory`，不要在 `AgentRunPlan` 中重复保存大文本。

### 4.1 修正运行中进度 API 对 trajectory-only 的返回

文件：`src/app/api/goals/tasks/progress/route.ts`

做法：
- 当前判断 `if (!effectiveProgress && (!logs || logs.length === 0)) return 404` 需要改为同时检查 `trajectory.length`：
  - 若 runtime job 存在且已有 `trajectory`，即使 `progress` 为空，也返回 `200`，携带 `trajectory` 和 `waitingReason`。
  - 只有 `progress/logs/trajectory` 都为空时才返回 404。
- 返回结构保持兼容：`{ progress, logs, trajectory, waitingReason }`。

原因：
- 多 Agent 执行的早期阶段可能先写 trajectory，再写 progress；如果 API 返回 404，前端会短暂看不到群聊过程。

### 4.2 明确 workspace 文件级持久化验收

文件：
- `src/lib/server/worker/taskDispatchWorker.ts`
- `src/lib/server/workspace/conversationWorkspace.ts`

做法：
- 保持 worker 成功/失败时调用 `writeTaskRunSnapshot({ trajectory: latestTrajectory })`。
- 验收时检查 `<workspace>/tasks/<task>/<instance>/trajectory.json` 是否包含群聊字段。
- 不新增单独的 `agent-chat.json` 文件，避免同一事实双写；如后续需要导出，可从 `trajectory.json` 投影生成。

原因：
- SQLite `runtime_jobs.trajectory_json` 解决运行中恢复，workspace `trajectory.json` 解决完成后的文件级回放和排查。

### 5. 改造任务详情执行过程为群聊 UI

文件：`src/components/goal/TaskDetailBody.tsx`

做法：
- 将 `ExecutionMessageStream` 改造成 `AgentConversationStream`。
- 更新本文件内的 `trajectoryToTimeline()`，把 `ExecutionTrajectoryStep` 的新增字段完整投影到 `TaskExecutionStep`。
- 对 `TaskExecutionStep[]` 做投影：
  - 有 `agentRole` 的步骤渲染为 Agent 消息。
  - `tool` / `toolName` 渲染为该 Agent 消息气泡内的“工具调用”条目。
  - `handoff` 渲染为居中的系统移交通知。
  - `error` / failed 渲染为红色 Agent 消息。
  - 没有 `agentRole` 的旧步骤渲染为系统消息，兼容旧数据。
- 每条 Agent 消息包含：
  - 头像圆点
  - Agent 名字
  - 状态 badge
  - 时间
  - 消息正文
  - 可选工具调用摘要
- 连续同一个 Agent 的普通过程消息可以合并，但合并条件必须包含 `agentRole` 相同，避免不同 Agent 串台。
- 保持现有 `max-h-[420px] overflow-y-auto` 自动滚动行为。

原因：
- 任务详情页当前执行过程是用户最直接查看“过程”的入口，应该优先在这里升级。

### 5.1 更新 Store 中的 trajectory normalize

文件：`src/stores/goalStore.ts`

做法：
- 更新 `normalizeTimelineFromTrajectory()`，保留新增字段：
  - `agentId / agentName / agentAvatar`
  - `messageKind`
  - `content / contentSummary`
  - `attempt`
- 对 `tool_result` 补齐 `detail`：
  - 成功时显示 `toolResult.output` 的摘要。
  - 失败时显示 `toolResult.error`。
- `mergeTimelineSteps()` 继续按 `id` 合并，但不能覆盖掉已有新字段。

原因：
- 运行中轮询进入 `goalStore.syncTaskInstanceRun()` 后，会先转成 `timeline` 再渲染；这里丢字段会导致刷新前后 UI 不一致。

### 6. 可选复用到通用时间线组件

文件：`src/components/task/TaskExecutionTimeline.tsx`

做法：
- 将角色显示 label 改为复用 `getAgentDisplay()`。
- 如果该组件仍用于其他入口，保留现有卡片式时间线，但新消息投影逻辑尽量抽成纯函数，避免和 `TaskDetailBody.tsx` 重复。
- 不强行把所有入口统一成群聊 UI，除非当前入口也明确是任务详情执行过程。

原因：
- 控制改动范围，避免影响其他页面布局。

### 7. 更新 Mock 多 Agent Case

文件：`src/mocks/goals.ts`

做法：
- 为 `multiAgentDemoInstance()` 的 `timeline` / `trajectory` 增加群聊所需字段：
  - `agentName`
  - `agentAvatar`
  - `messageKind`
  - `content`
  - `attempt`
- 保持现有 `agentRunPlan` 示例。
- 如果 mock reset version 已是当前最新版本，不再随意提升版本；只有确认需要强制刷新 mock 才提升，避免再次覆盖用户本地会话。
- mock 里同时写 `timeline` 和 `trajectory`：
  - `timeline` 用于当前 UI 立即可见。
  - `trajectory` 用于验证新持久化字段的真实形态。
- mock 中加入至少一个工具调用消息和一个移交系统消息，避免只验证普通文本气泡。

原因：
- 用户需要可见 demo，mock 应覆盖开始、工具、移交、审阅打回、复查、合成完整链路。

### 8. 迁移与兼容

涉及文件：
- `src/types/executionTrajectory.ts`
- `src/components/goal/TaskDetailBody.tsx`
- `src/stores/goalStore.ts`

做法：
- 所有新增字段均为 optional，旧 `trajectory` 数据无需迁移。
- UI 投影函数按以下优先级取内容：
  - `step.content`
  - `step.thought`
  - `summarizeToolOperation(step.toolCall?.name, step.toolCall?.input)`
  - `step.title`
- 旧 `timeline` 数据仍可渲染为系统消息。
- 不再通过提升 mock version 来发布普通 UI 改动；如必须发布 mock 数据，迁移函数应继续合并用户数据。
- `structuredOutput.agentRunPlan` 仍用于结果摘要，不在任务详情“执行过程”里重复渲染完整角色列表，避免同屏重复两套多 Agent 过程。
- 对很长的 `content` 做 UI 层折叠或截断显示，但持久化仍保存已裁剪后的 UI 安全文本，默认上限沿用 2000 字。

### 9. 边界与失败态

涉及文件：
- `src/lib/server/agentOrchestration/MultiAgentOrchestrator.ts`
- `src/components/goal/TaskDetailBody.tsx`

做法：
- Agent 执行失败时，群聊中显示该 Agent 的红色失败气泡，并保留后续系统失败消息。
- Reviewer blocking 打回时，显示为 Reviewer 的审阅消息 + 系统“打回给 Executor 第 2 轮”消息。
- 用户停止任务时，当前已有 `cancelled` progress；UI 需要把最后状态显示为系统停止消息，不误判为 Agent 自身失败。
- 如果任务恢复执行，旧 `initialTrajectory` 和新轨迹合并后按 `startedAt/index` 排序显示，不重复展示相同 `id`。

原因：
- 群聊式 UI 不能只覆盖成功路径，停止/失败/恢复是长耗时任务可控性的关键体验。

## Assumptions & Decisions

- “执行过程持久化”的主存储是 `ExecutionTrajectoryStep[]`，而不是 `AgentRunPlan.roles`。
- 持久化内容保存 UI 安全的过程文本和摘要，不保存完整模型 raw output、不保存隐藏提示词、不保存完整工具原始输出。
- 任务详情页是本次 UI 改造主目标；结果区的“多角色协同摘要”继续保留。
- 单 Agent、旧任务、旧 mock 数据必须继续可看，不能因为缺少 `agentRole` 或新字段而空白。
- 多 Agent 的第二轮修订通过 `attempt` 和 role run id 显示为独立发言者轮次，例如 `Executor · 第 2 轮`。

## Verification Steps

1. 运行 `pnpm exec tsc --noEmit`，确认类型通过。
2. 运行 `pnpm lint`，确认无 lint 错误。
3. 打开 `http://localhost:3000/conversations/conv-goal-toefl`，进入 `Surface Demo · 多 Agent`，展开任务详情。
4. 验证执行过程以群聊方式展示：
   - 每个 Agent 有头像和名字。
   - Coordinator、Executor、Reviewer、Executor 第 2 轮、Reviewer 第 2 轮、Synthesizer 都能区分。
   - 移交消息显示为系统提示。
   - 工具调用显示在对应 Agent 的过程里。
5. 执行一个真实多 Agent 任务，运行中刷新页面，确认执行过程仍从 `runtime_jobs.trajectory_json` 恢复。
6. 任务完成后刷新页面，确认执行过程仍从 `TaskInstance.trajectory` / 最终结果恢复。
7. 检查任务 workspace 下的 `trajectory.json`，确认包含 `agentName / agentAvatar / messageKind / content` 等字段。
8. 打开旧任务或单 Agent 任务，确认旧执行过程仍以兼容样式展示。
9. 手动停止一个运行中任务，确认群聊 UI 显示停止状态，并且刷新后仍可看到停止前的 Agent 执行过程。
10. 确认结果区的 `AgentRunPlan` 摘要仍存在，但任务详情“执行过程”不重复渲染同一组角色摘要。
