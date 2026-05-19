# 任务结果与多 Agent 过程信息分离计划

## Summary

目标：任务结果区域只展示“最终任务交付结果”，不展示多 Agent 协同、角色分工、审阅过程、关键动作表等过程信息。

过程信息应统一进入“执行链路”：

- Coordinator / Executor / Reviewer / Synthesizer 的步骤、思考摘要、审阅意见、移交关系，属于执行过程。
- 任务结果区域只展示用户真正要看的报告、表格、结论、建议、文件产物或 webapp。
- 任务消息卡片内联结果和右侧详情产出物区域都必须遵守这个边界。

## Current State Analysis

### 1. 当前任务结果渲染本身没有主动插入 Agent 信息

文件：

- `src/components/task/GenericAgentResultView.tsx`
- `src/components/execution/BlockRenderer.tsx`
- `src/components/task/TaskInlineResultView.tsx`
- `src/components/task/ExecutionResultBody.tsx`

当前链路：

- `GenericAgentResultView` 只渲染 `taskResult.blocks` 和 `taskResult.artifactRefs`。
- `TaskResultBlockView` 会展示：
  - `taskResult.title`
  - `taskResult.blocks`
- `TaskInlineResultView` 在任务卡片中复用 `GenericAgentResultView`。
- `ExecutionResultBody` 的产出物区域也复用 `GenericAgentResultView`。

结论：

- UI 组件不是凭空加了“多 Agent 协同结果”。
- 截图里的过程信息来自 `taskResult.blocks` 本身。

### 2. mock 数据确实把多 Agent 过程写进了 taskResult.blocks

文件：`src/mocks/goals.ts`

已发现示例：

- `taskResult.title`: `多 Agent 托福听力复盘 Demo`
- blocks 中包含：
  - heading: `多 Agent 协同结果`
  - paragraph: `Coordinator 明确 mixed 结果要求，Executor...`
  - comparison_table: columns 为 `角色 / 关键动作 / 状态`

这些内容不是最终用户交付结果，而是协同过程摘要，应从任务结果区域移除，放到执行链路中。

### 3. Synthesizer prompt 没有明确禁止过程信息进入最终结果

文件：`src/lib/server/agentOrchestration/prompts.ts`

当前 Synthesizer 会拿到：

- 前序移交
- 前序角色输出
- 审阅结果
- `buildGoalTaskRunnerPrompt()` 的最终任务 JSON 格式要求

但缺少明确边界：

- 可以参考前序角色输出和审阅意见。
- 不能把“谁做了什么、审阅如何打回、角色动作表”写进 `task_result.blocks`。
- 这些过程信息只能进入 `agentRunPlan` / `trajectory` / 执行链路。

### 4. 渲染层缺少保险过滤

即使修正 prompt，模型仍可能偶发把过程信息写进 `taskResult.blocks`。

需要在渲染层加一个轻量过滤保险：

- 过滤明显的过程型 heading / paragraph / comparison_table。
- 只在 UI 展示时过滤，不修改原始数据，避免丢调试信息。
- 原始过程仍可通过执行链路、metadata 或 raw output 调试。

## Proposed Changes

### 1. 新增任务结果展示过滤器

新增文件：`src/lib/taskResult/presentationFilter.ts`

职责：

- 输入 `TaskResult`。
- 输出用于 UI 展示的 `TaskResult` 副本。
- 只过滤明显属于过程信息的 blocks，不修改原对象。

过滤规则：

- 过滤 heading：
  - 包含 `多 Agent`
  - 包含 `协同结果`
  - 包含 `协同过程`
  - 包含 `角色分工`
  - 包含 `执行过程`
  - 包含 `审阅过程`
- 过滤 paragraph / markdown：
  - 明显描述角色流水线，例如同时出现两个及以上角色名：`Coordinator`、`Executor`、`Reviewer`、`Synthesizer`、`Researcher`
  - 明显描述“第一轮/第二轮/打回/复查通过/移交”等执行过程，而不是用户结果内容
- 过滤 comparison_table：
  - columns 包含 `角色`
  - 且 columns 包含 `关键动作`、`状态`、`职责`、`输出`、`审阅` 之一
- 保留正常业务结果：
  - 城市对比表、投资分析表、行程表、清单、结论、推荐、风险提示、文件产物

降级策略：

- 如果过滤后 blocks 为空，但原 blocks 非空，则不展示空白结果。
- 这种情况下保留原 blocks，避免误伤导致用户什么都看不到。
- 后续可在 diagnostics 或 console debug 中记录被过滤数量，但本次不新增用户可见提示。

### 2. GenericAgentResultView 统一使用展示过滤器

文件：`src/components/task/GenericAgentResultView.tsx`

修改：

- 在传给 `InteractiveRenderSurface` 和 `FileArtifactSurface` 前调用 `filterTaskResultForPresentation(taskResult)`。
- `artifactRefs` 不过滤，因为文件产物属于最终交付结果。
- `meta.agentRunPlan`、`meta.qualityReview` 不展示在结果区，只保留给执行链路和调试使用。

为什么：

- `TaskInlineResultView` 和 `ExecutionResultBody` 都复用 `GenericAgentResultView`。
- 在这里过滤一次即可同时覆盖任务卡片内联结果和右侧详情产出物区域。

### 3. BlockRenderer 去重主标题与首个 heading

文件：`src/components/execution/BlockRenderer.tsx`

修改：

- 在 `TaskResultBlockView` 中计算展示 blocks。
- 如果第一个 block 是 heading，并且与 `result.title` 高度相似或重复，则隐藏第一个 heading。

相似判断：

- 去掉空格、标点、`Demo`、`报告`、`结果`、`分析` 等弱词后做包含判断。
- 仅处理第一个 heading，避免误删正文中的正常章节。

为什么：

- 即使不是多 Agent 过程，也可能出现“报告标题 + 第一章标题”重复。
- 这能解决截图中上下两个标题挤在一起的问题。

### 4. 修正多 Agent Synthesizer prompt

文件：`src/lib/server/agentOrchestration/prompts.ts`

在 Synthesizer 的“额外要求”中新增：

- 前序角色输出、审阅意见、移交关系只作为生成最终结果的依据。
- `task_result.blocks` 只能包含最终用户交付内容。
- 禁止在 `task_result.blocks` 中写：
  - 多 Agent 协同结果
  - 角色分工
  - Coordinator / Executor / Reviewer / Synthesizer 的过程描述
  - 审阅打回、复查过程、移交过程
  - `角色 / 关键动作 / 状态` 这类过程表
- 如需保留过程信息，必须放在 `structured_output.agentRunPlan`、`task_result.meta.agentRunPlan` 或执行轨迹中，供“执行链路”展示。

为什么：

- 从源头减少过程信息进入最终结果。
- 符合用户现在的产品边界：结果就是结果，过程就是执行链路。

### 5. 修正单 Agent 执行 prompt 的通用边界

文件：`src/lib/server/goalTaskPrompt.ts`

在最终输出约束中新增：

- `task_result.blocks` 是给用户看的最终交付结果。
- 不要把执行过程、工具调用过程、Agent 自我说明、审阅过程写进 `task_result.blocks`。
- 如果需要表达过程，写入执行轨迹或 final_message 的极简说明，但不进入结果 blocks。

为什么：

- 虽然问题主要发生在多 Agent，但单 Agent 也可能把“我做了什么”写进结果。
- 统一语义边界，减少未来回归。

### 6. 更新 mock 示例，避免 demo 误导

文件：`src/mocks/goals.ts`

修改：

- `inst-surface-demo-multi-agent` 的 `taskResult.blocks` 改成真正的托福听力复盘结果，例如：
  - heading: `听力复盘结论`
  - paragraph: 错因摘要
  - callout: 下一轮练习重点
  - comparison_table: `问题类型 / 典型表现 / 练习建议`
- 删除结果 blocks 中的：
  - `多 Agent 协同结果`
  - Coordinator / Executor / Reviewer / Synthesizer 过程描述
  - `角色 / 关键动作 / 状态` 表
- 保留 `structuredOutput.agentRunPlan` 和 `taskResult.meta.agentRunPlan`，让执行链路继续展示多 Agent 过程。

为什么：

- mock 会直接影响用户看到的 demo。
- 当前 mock 正在把错误的信息架构固化到 UI 中。

### 7. 不改变执行链路展示

文件：

- `src/components/task/TaskExecutionTimeline.tsx`
- `docs/agent-execution-chain-demo.html`

本计划不修改这些文件。

原因：

- 多 Agent 过程应该展示，但位置是“执行链路”。
- 后续如果用户确认新的执行链路 UI demo，再单独应用到 `TaskExecutionTimeline`。
- 本次只处理“任务结果区域不显示过程信息”。

## Assumptions & Decisions

- 任务结果区域只展示最终交付内容。
- 多 Agent 协同过程不删除，只移动语义位置：执行链路展示，结果区不展示。
- 渲染过滤只影响 UI 展示，不修改原始结果数据。
- Prompt 约束负责源头治理，渲染过滤负责兜底。
- 文件产物和 webapp 仍属于最终结果，应继续展示。
- 不做数据库迁移。
- 不改变执行链路 UI demo，也不把新执行链路样式应用到项目组件。

## Verification Steps

1. 查看多 Agent demo 任务：
   - 任务结果区域不再出现 `多 Agent 协同结果`。
   - 任务结果区域不再出现 `Coordinator / Executor / Reviewer / Synthesizer` 过程说明。
   - 任务结果区域不再出现 `角色 / 关键动作 / 状态` 表。

2. 查看执行链路：
   - 多 Agent 角色过程仍能在执行链路中看到。
   - `agentRunPlan` 和 trajectory 不受影响。

3. 查看普通报告任务：
   - 城市对比、投资分析、行程规划等正常业务表格不被过滤。
   - 文件产物仍展示在文件区域。

4. 查看标题展示：
   - 如果 `taskResult.title` 和第一个 heading 重复，只显示一个主标题。
   - 正常章节标题不被误删。

5. 静态检查：
   - 对新增/修改文件运行 VS Code diagnostics。
   - 运行 `npx tsc --noEmit`。
