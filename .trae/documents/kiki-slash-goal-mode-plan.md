# KiKi `/goal` 长程目标任务模式规划

## Summary

在右侧 KiKi 侧边栏和 `/conversations` 会话页的共用输入框中增加 `/` 命令模式，首个命令为 `/goal`。用户输入 `/goal <目标描述>` 后，消息进入长程目标任务模式：调用本地 Claude CLI 生成结构化目标规划，创建并持久化 Goal/SubGoal/Task，绑定会话，展示目标规划抽屉，并通过状态机支持计划确认、执行启动和监控状态。

用户已确认：

- 两处输入框都支持 `/goal`。
- 首版做完整状态机。
- 目标拆解草案调用本地 Claude 生成。
- 输入 `/` 时弹出命令菜单。

## Current State Analysis

- `src/components/layout/AssistantComposer.tsx` 是两处输入框的共用组件，目前只有普通提交，没有 slash command 菜单。
- `src/components/layout/AssistantSidebar.tsx` 调用 `assistantStore.send()`，当前只走普通 Claude 流式聊天。
- `src/components/conversation/ConversationView.tsx` 已在空态提示 `/goal`，但没有实现命令分流；已有 `GoalPlanDrawer` 可展示会话绑定的目标规划。
- `src/stores/conversationStore.ts` 已持久化并支持 `setGoalForConversation()`。
- `src/stores/goalStore.ts` 目前未持久化，`createGoalFromInput()` 仍使用 mock 草案。
- `src/types/kiki.ts` 有 Goal/SubGoal/Task/GoalBreakdownDraft，但缺少 goal-driven 状态机字段。
- `src/lib/server/claudeCli.ts` 已用 `spawn()` 调本地 Claude，并符合 `stdio: ["ignore", "pipe", "pipe"]` 约定；结构化目标规划应新增独立 JSON API，不混入现有 SSE 聊天接口。
- 参考项目的核心可迁移点是状态机、MECE/逆向推演拆解 prompt、任务生成/Review prompt、计划确认流程；不直接搬 EventBus 和后台 Agent Pi 会话池。

## Proposed Changes

1. 新增 `src/lib/slashCommands.ts`
   - 定义 `/goal` 命令元信息。
   - 提供 `parseSlashCommand()` 和 `getSlashCommandSuggestions()`。

2. 改造 `src/components/layout/AssistantComposer.tsx`
   - 输入 `/` 或 `/g` 时弹出 `/goal` 候选菜单。
   - 支持点击、Enter 选择、方向键切换、Escape 关闭。
   - 选中后插入 `/goal ` 并聚焦输入框。

3. 扩展 `src/types/kiki.ts`
   - 新增 `GoalWorkflowPhase`、`GoalPlanDecision`、`GoalWorkflow`。
   - `Goal` 增加 `workflow?: GoalWorkflow`、`conversationId?: string`。
   - `Task` 增加可选 priority、dependencies、executionMode、executionCycle、expectedResult。
   - `GoalBreakdownDraft` 增加 summary、deadline、assumptions、risks、reasoning、notificationStrategy，以及子目标/任务元信息。

4. 改造 `src/stores/goalStore.ts`
   - 用 Zustand `persist` 持久化 goals，key 为 `kiki.goals`。
   - 新增 `createGoalFromDraft()`、`updateGoalWorkflow()`、`confirmGoalPlan()`、`requestGoalPlanRevision()`、`activateGoal()`、`failGoalWorkflow()`。
   - 保留旧 `createGoalFromInput()` 供 `/goals/new` 继续使用。

5. 新增本地 Claude 结构化规划 API
   - 新增 `src/lib/server/goalPlanning.ts`：使用 `spawn()` 调 Claude CLI，生成并校验 `GoalBreakdownDraft` JSON。
   - 新增 `src/app/api/goals/plan/route.ts`：接收 goalText、runtimeEnv、conversationContext，返回 draft。
   - 修改 `src/lib/api/goals.ts`：新增 `generateGoalPlan()`。

6. 新增 `src/lib/goalWorkflow.ts`
   - 提供 `startGoalWorkflow()`，统一处理 runtime 校验、规划 API 调用、goal 创建、conversation 绑定、状态推进。
   - 会话页复用当前 conversation；侧边栏创建新 conversation。

7. 改造 `ConversationView`
   - `onSend()` 先解析 slash command。
   - plain 保持普通聊天。
   - unknown 提示不支持。
   - `/goal` 进入 workflow，生成中展示 KiKi loading，成功后绑定 goal 并自动打开 `GoalPlanDrawer`。

8. 改造 `assistantStore` 与 `AssistantSidebar`
   - `send()` 支持 `/goal` 分流。
   - `AssistantMessage` 增加 action，用于显示“查看目标规划”按钮。
   - 侧边栏点击按钮跳转到对应 conversation。

9. 改造 `GoalPlanContent`
   - 展示 workflow 状态。
   - `presenting_plan + pending` 时显示“确认并启动”和“继续调整”。
   - 确认后进入 `monitoring`，复用现有 `useTriggerEngine` 推进任务实例/Inbox。

## Assumptions & Decisions

- `/goal` 只识别开头命令。
- `/goal` 后的文本即目标描述。
- 完整状态机首版落在 `Goal.workflow` 持久化字段，不实现独立后台 Agent Pi 会话池。
- 目标规划调用本地 Claude CLI，不传 model 参数。
- 不引入新依赖。
- 不重新引入 `dora` 命名。
- 完成后执行 diagnostics、`pnpm lint`、`pnpm build`，清理 `.next` 并固定 3000 端口重启。

## Verification Steps

- 输入框 `/` 菜单在侧边栏和会话页均可用。
- `/goal <目标>` 在两处都能创建目标规划。
- 目标规划由 Claude API 返回并落到 Goal/SubGoal/Task。
- 会话页生成后自动打开目标规划 Drawer。
- 侧边栏生成后提供“查看目标规划”入口。
- 刷新后新 goal 和 conversation 绑定仍存在。
- 计划确认后 workflow 进入 `monitoring`。
- 空 `/goal`、未知命令、Runtime 未配置、Claude JSON 失败均有明确错误。
- 全局搜索无 `dora` 残留。
- `pnpm lint` 和 `pnpm build` 通过。
- 3000 端口清缓存重启成功，访问 `http://localhost:3000`。
