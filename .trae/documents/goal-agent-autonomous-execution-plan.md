# `/plan` 目标任务改造成真正 Agent 独立执行的实施计划

## Summary

将当前 `/goal` 体系从“规划是结构化的，但执行仍主要落到 `freeform_chat` 对话壳层”升级为“规划阶段产出可执行任务，执行阶段由后台 agent 自动独立运行”。首版目标对齐用户确认的边界：

- 所有任务统一进入 agent 执行链路，不再把通用任务默认降级为“自由对话”。
- 默认使用本地 Runtime 的 `execute` 权限，在工作目录内允许 agent 真正执行。
- scheduler 触发任务后自动后台运行，不要求用户先点击“开始”。
- 任务详情页需要展示完整但可读的执行链路，粒度为“阶段 + 工具步”。
- 失败按错误类型处理：瞬时错误可自动重试，权限/逻辑类错误暂停并等待用户处理。

## Current State Analysis

- `src/lib/server/goalPlanning.ts`
  - 当前规划 Prompt 已支持 `execution_mode`、`expected_output`、`dependencies` 等结构化字段。
  - 但 `inferExecutionKind()` 仍会把大量任务映射回 `freeform_chat`，导致规划层没有真正表达“可由 agent 独立执行”的语义。
- `src/types/kiki.ts`
  - 现有 `ExecutionKind` 偏 UI 视图类型：`flashcard`、`reading_digest`、`draft_review`、`confirm_action`、`freeform_chat`。
  - `TaskInstance` 只有 `intro/payload/status`，缺少 agent 运行请求、步骤日志、重试信息、最终结果、失败分类等字段。
- `src/stores/goalStore.ts`
  - 当前实例状态流转仅是本地前端状态更新，`controlTaskExecution()` / `completeTaskInstance()` 不连接后端执行。
  - `confirmGoalPlan()` 只把 workflow 标记为 `executing`，没有真正启动 executor。
- `src/components/providers/GoalSchedulerRuntime.tsx`
  - 已具备 scheduler、依赖检查、实例生成、Inbox/会话卡片推送能力。
  - 但触发后只是生成 `task_card`，并未向后端发起任务执行。
- `src/components/task/ExecutionResultBody.tsx`
  - 当前执行页本质是根据 `executionKind` 切换本地 view。
  - `freeform_chat` 实际接入的是本地 mock 对话，不是 agent 运行。
- `src/components/execution/FreeformChatView.tsx`
  - 当前只是 `useChatStore` 的 seed 对话，不接 Claude CLI，也没有真正工具调用。
- `src/lib/server/claudeCli.ts`
  - 已有稳定的 Claude CLI 流式调用封装，支持 `--resume`、干净环境变量、权限模式。
  - 这是实现任务 agent runner 的主要后端能力基础。
- `src/lib/server/goalTelemetry.ts` 与 `src/app/api/goals/progress/route.ts`
  - 已具备 request 级别进度和日志能力，但 scope 仅面向 `goal_plan` / `goal_collect`。
  - 可以扩展为 `goal_task_execute`，作为任务执行链路可视化的首版基础设施。
- `src/components/goal/TaskDetailBody.tsx` 与 `src/app/goals/[goalId]/tasks/[taskId]/page.tsx`
  - 已有任务详情页和实例入口，适合作为“查看执行链路”的主承载页面。

## Assumptions & Decisions

- 不追求一比一复制外部 `coding-agent` 仓库实现；以当前项目已有 Claude CLI、scheduler、会话、任务详情页为基础做本地化对齐。
- 所有任务都统一走“agent 执行 -> 产出结果 -> 可能等待用户确认”的闭环。
- 现有 `flashcard`、`listening_qa`、`reading_digest`、`draft_review`、`confirm_action` 不再代表“执行方式”，而更适合作为“结果呈现类型”或“用户交互类型”。
- 首版默认只支持 Claude Local Runtime 作为任务执行引擎，不新增多 runtime 执行抽象。
- 首版不做真正跨进程任务持久化恢复；任务运行时状态以 telemetry 文件 + 持久化 store 协同保存，页面刷新后可以查看最近链路和结果。
- 首版自动重试策略按错误类型：
  - CLI 启动失败、网络/API 瞬时错误：自动重试。
  - 权限拒绝、Prompt/解析逻辑错误、用户取消：直接暂停并记录原因。
- 保持现有 `claudeEnv.ts` 干净环境约束和 `--resume <sessionId>` 会话连续性要求。

## Proposed Changes

### 1. 重构任务执行语义模型

- 修改 `src/types/kiki.ts`
  - 将 `executionKind` 从“执行方式”改造为“结果呈现类型/interaction kind”，建议新增或重命名为更清晰的字段：
    - `executionStrategy`: `"agent_autonomous"` | `"user_interactive"` | `"hybrid"`
    - `resultViewKind`: `"flashcard"` | `"listening_qa"` | `"reading_digest"` | `"draft_review"` | `"confirm_action"` | `"generic_result"`
  - 扩展 `TaskExpectedResult`，明确任务完成产物的格式与验收条件。
  - 为 `TaskInstance` 增加真正执行所需元数据：
    - `runner`: requestId、runtimeEnvId、permissionMode、workingDirectory、attemptCount、lastAttemptAt
    - `execution`: phase、status、startedAt、finishedAt、errorCategory、errorMessage
    - `timeline`: 阶段节点与工具步骤数组
    - `result`: summary、artifacts、finalMessage、structuredOutput
    - `awaitingUser`: 是否等待确认、等待原因、建议动作
  - 保留旧字段的兼容迁移策略，避免已持久化数据直接失效。

### 2. 让规划结果直接表达“agent 可执行”

- 修改 `src/lib/server/goalPlanning.ts`
  - 停止把通用任务默认归类到 `freeform_chat`。
  - 调整任务生成 Prompt，要求 Claude 在任务维度显式返回：
    - 执行目标
    - 建议工作目录
    - 是否可全自动执行
    - 需要用户确认的前置条件
    - 预期产物格式
    - 结果呈现类型
  - 新增统一的任务后处理逻辑：
    - 默认 `executionStrategy = "agent_autonomous"`
    - 仅在明确需要人工练习/交互时设为 `user_interactive` 或 `hybrid`
    - 将 `confirm_action` / `draft_review` 语义改为“agent 已先做完，再等待用户确认/审阅”
  - 保留强容错 JSON 解析链路，新增对新字段的 schema 校验和降级修复。

### 3. 新增后端任务执行 Runner

- 新增 `src/lib/server/goalTaskRunner.ts`
  - 封装单个任务实例的 agent 执行流程。
  - 输入：goal、subGoal、task、instance、runtimeEnv。
  - 职责：
    - 生成 task-specific prompt，注入目标背景、子目标上下文、依赖结果摘要、验收标准。
    - 调用 `streamClaudeCli()` 真正执行。
    - 将 Claude 流式事件映射为“阶段 + 工具步” timeline。
    - 归类错误类型并执行自动重试。
    - 解析最终结果，生成 `resultViewKind` 对应 payload 或 generic result。
    - 决定实例最终流向：`completed`、`awaiting_user`、`paused/error`。

- 新增 `src/lib/server/goalTaskPrompt.ts`
  - 统一构造 task runner prompt。
  - 对齐 coding-agent 风格，包含：
    - 任务目标
    - 当前上下文
    - 允许的执行边界
    - 完成标准
    - 输出格式约束
    - 当需要用户确认时如何明确输出 decision block

### 4. 扩展任务执行 telemetry 与链路模型

- 修改 `src/types/goalTelemetry.ts`
  - 扩展 `GoalTelemetryScope`，新增 `goal_task_execute`。
  - 新增任务执行步骤事件类型，例如：
    - `phase_started`
    - `tool_call_started`
    - `tool_call_finished`
    - `assistant_output`
    - `retry_scheduled`
    - `await_user`
    - `result_ready`

- 修改 `src/lib/server/goalTelemetry.ts`
  - 增加面向任务实例的日志写入能力，支持 requestId 与 `taskInstanceId` 绑定。
  - 提供获取任务执行链路的 helper，便于任务详情页轮询。

- 新增或改造 API
  - 新增 `src/app/api/goals/tasks/execute/route.ts`
    - 启动指定任务实例的后台执行。
  - 新增 `src/app/api/goals/tasks/progress/route.ts`
    - 按 `requestId` 或 `instanceId` 返回链路进度、步骤、结果摘要。

### 5. 将 scheduler 从“发卡片”升级为“自动启动后台执行”

- 修改 `src/components/providers/GoalSchedulerRuntime.tsx`
  - 保留现有 due、依赖、并发控制逻辑。
  - 在实例生成后，不再只做本地状态推进，而是：
    - 调用任务执行 API
    - 标记实例进入真实 `in_progress`
    - 在会话里推送“任务已由 KiKi 自动启动”的 `task_card`
  - 当任务运行完成：
    - 若得到结果，更新 Inbox 与会话消息文案为“结果已就绪”
    - 若需人工确认，转 `awaiting_user`
    - 若失败，按错误类型自动重试或转暂停
  - 继续复用 `maxConcurrentTasks`、heartbeat、timeout 逻辑，但状态来源改为真实 runner 状态。

### 6. 用真实执行状态重构 Goal Store

- 修改 `src/stores/goalStore.ts`
  - 新增实例级更新方法：
    - `startTaskInstanceRun()`
    - `appendTaskInstanceStep()`
    - `finishTaskInstanceRun()`
    - `failTaskInstanceRun()`
    - `markTaskInstanceAwaitingUser()`
    - `retryTaskInstanceRun()`
  - `controlTaskExecution()` 改为真正的“暂停/继续/重试”控制，而不是只改本地状态。
  - `completeTaskInstance()` 不再由 view 直接调用，而由 runner 结果驱动。
  - 增加兼容迁移逻辑，处理已持久化旧 task instance 数据。

### 7. 重构执行页：从 view 切换页变成 agent 运行详情页

- 修改 `src/components/task/ExecutionResultBody.tsx`
  - 去掉“点开始后本地切换 view”的主逻辑。
  - 变成任务实例状态总览 + 执行链路主容器：
    - 顶部显示当前状态、开始时间、最近更新时间、重试次数
    - 中部显示“阶段 + 工具步”时间线
    - 底部显示最终结果或等待用户操作区
  - 针对 `resultViewKind` 渲染不同结果面板：
    - `flashcard` 仍复用 `FlashcardView`
    - `reading_digest` 仍复用 `ReadingDigestView`
    - `draft_review` 仍复用 `DraftReviewView`
    - `confirm_action` 仍复用 `ConfirmActionView`
    - 通用结果新增 `GenericAgentResultView`

- 新增 `src/components/task/TaskExecutionTimeline.tsx`
  - 展示阶段节点与工具步骤状态。
  - 支持“进行中 / 成功 / 失败 / 等待用户 / 已重试”。

- 新增 `src/components/task/GenericAgentResultView.tsx`
  - 承载通用 agent 执行结果、总结、附件/产物列表、建议下一步。

- 保留 `src/app/conversations/[conversationId]/results/[messageId]/page.tsx`
  - 但内容改为真实链路视图，而不是本地 mock 结果页。

### 8. 弱化并逐步下线 `freeform_chat` mock 执行

- 修改 `src/components/execution/FreeformChatView.tsx`
  - 首版不再作为默认执行方式。
  - 可保留为兜底交互视图，仅用于 `awaiting_user` 后的补充沟通，或直接由新的通用结果组件取代。

- 修改 `src/mocks/goals.ts`、`src/mocks/goal-breakdown.ts`
  - 更新 mock 数据以适配新 schema。
  - 删除“默认 `freeform_chat`”的示例，改为 agent 结果型样例。

### 9. 调整会话卡片和任务详情文案

- 修改 `src/components/conversation/TaskMessageCard.tsx`、`src/components/providers/GoalSchedulerRuntime.tsx`
  - 卡片文案从“点击卡片查看并继续执行”改为：
    - “KiKi 正在后台执行”
    - “KiKi 已完成并生成结果”
    - “KiKi 需要你确认”
    - “KiKi 执行失败，等待处理”

- 修改 `src/components/goal/TaskDetailBody.tsx`
  - 任务详情页首页直接显示最近实例的执行链路摘要。
  - 操作按钮改为“查看链路 / 重试 / 继续 / 停止”，不再把“开始执行”作为默认入口。

### 10. 前后端数据流与轮询策略

- 修改 `src/lib/api/goals.ts` 或新增 `src/lib/api/taskRuns.ts`
  - 封装执行启动、进度查询、重试、停止接口。

- 修改 `src/app/goals/[goalId]/tasks/[taskId]/page.tsx`
  - 任务页加载当前最新实例及其执行链路。
  - 在页面可见时轮询任务执行 API，实时刷新 timeline。

- 修改 `src/app/inbox/[itemId]/result/page.tsx`
  - 收敛到与任务结果页相同的执行详情视图，避免两套分叉表现。

## Implementation Order

1. 扩展任务与实例 schema，先把执行语义与 timeline 数据模型立住。
2. 改造 `goalPlanning.ts`，让规划输出真正的 agent 可执行元数据。
3. 新增后端 `goalTaskRunner.ts` 与任务执行 API。
4. 扩展 telemetry 和 progress API，打通 requestId/instanceId 追踪。
5. 改造 `goalStore.ts` 与 `GoalSchedulerRuntime.tsx`，让任务自动后台跑。
6. 重构 `ExecutionResultBody` 和任务详情页，接入实时执行链路。
7. 更新会话卡片、Inbox、mock 数据和兼容迁移。
8. 最后统一清理 `freeform_chat` 的默认路径与过时文案。

## Verification Steps

- 规划生成后，任务数据不再默认落成 `freeform_chat`，而是带有 agent 可执行元信息。
- 确认计划后，scheduler 触发实例会自动调用后台执行 API，而不是只发卡片。
- 任务详情页能看到“阶段 + 工具步”链路，包含当前步骤、完成状态、重试记录。
- Claude CLI 真正以 `execute` 权限在配置工作目录中执行，且继续使用干净环境变量。
- `confirm_action` / `draft_review` 变成“agent 已执行完后等待用户确认”的结果态，而不是执行入口本身。
- 瞬时错误会自动重试；权限/逻辑错误会暂停并显示原因。
- 会话页、Inbox、任务详情页三处状态一致，不出现“UI 显示已启动但实际未执行”的错位。
- 刷新页面后，最近任务实例状态、结果摘要和执行链路仍可恢复查看。
- `pnpm lint`、`pnpm build` 通过。
- 按现有约定清理 `.next` 后在 3000 端口重启，确认任务自动执行、链路展示、结果回流正常。
