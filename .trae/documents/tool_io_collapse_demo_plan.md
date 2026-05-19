# 工具输入输出折叠 Demo 计划

## Summary
- 目标：先在既有多 Agent demo 页面中验证工具输入/输出展示方案，再决定是否同步到真实组件。
- 范围：只改 `docs/agent-execution-chain-demo.html`，暂不修改真实业务组件。
- 期望效果：
  - 工具胶囊不再重复展示“工具名 + 中文动作 + 同一参数”。
  - 工具展示拆成 `工具名`、`输入`、`输出` 三部分。
  - 工具输出超过 300 个字符时，默认只展示 3 行，hover 后允许点击展开。
  - 每个 Step 的整体内容超过 300 个字符时，默认只展示 3 行，hover 后允许点击展开。

## Current State Analysis
- 当前 demo 文件：`docs/agent-execution-chain-demo.html`
  - 工具样式位于 `.step-tool`、`.step-tool-name`、`.step-tool-detail`。
  - 当前工具只是一颗灰色胶囊：`tool_name · 一行执行内容`。
  - 当前 Step 思考文本直接用 `.step-thought` 展示，没有长度折叠。
- 当前真实组件：`src/components/task/TaskExecutionTimeline.tsx`
  - 工具详情由 `getToolDetail(step)` 生成。
  - `getToolDetail(step)` 调用 `formatToolOperationText(step.title, step.detail?.trim())`。
  - 这会把工具标题和摘要再次拼接，导致类似 `WebSearch · 搜索网页：xxx` 的重复观感。
- 当前数据约束：
  - `TaskExecutionStep` 只有 `detail` 和 `toolName`，没有单独的原始 `toolInput/toolOutput` 字段。
  - demo 阶段可以先手写静态 `input/output` 内容验证视觉和交互。
  - 后续真实落地如果要展示真正输入/输出，需要从 `ExecutionTrajectoryStep.toolCall/toolResult` 保留并映射到前端类型。

## Proposed Changes
- 修改 `docs/agent-execution-chain-demo.html`
  - 新增折叠文本样式：
    - `.clamp-box`：默认最多 3 行。
    - `.clamp-box.is-expanded` 或 `details[open]`：展开全文。
    - `.expand-hint`：hover Step 或 hover 工具时才显示“展开/收起”。
  - Step 内容折叠：
    - 把 `.step-thought` 内长文本包装成可折叠结构。
    - 超过 300 字的 Step 用 `details.step-collapse` 表示，默认展示 3 行。
    - 未超过 300 字的 Step 保持普通文本，不出现额外控件。
  - 工具胶囊改造：
    - 保持灰色柔和胶囊视觉，但内部结构改为：
      - `WebSearch` 工具名。
      - `输入：越南主要旅游城市...`
      - `输出：返回 8 条网页结果...`
    - 工具名和输入之间增加明显间距，避免“工具名字前边没有间隙”的问题。
    - 不再把中文动作标题和参数重复拼接。
  - 工具输出折叠：
    - 输出内容超过 300 字时，使用可折叠输出区域。
    - 默认展示 3 行，hover 工具胶囊后出现展开入口。
    - 展开后显示完整输出；再次点击可收起。
  - Demo 内容更新：
    - 选 2 到 3 个 Step 放入较长的工具输出，模拟真实 WebSearch/WebFetch 返回。
    - 保留 1 到 2 个短工具示例，用于验证短内容不显示展开控件。

## Assumptions & Decisions
- 本轮只验证 demo 效果，不同步真实组件。
- 300 字阈值在 demo 中用静态判断体现：长文本手动使用可折叠结构，短文本不使用。
- 展开触发方式：
  - 使用原生 `<details>`，点击 summary 展开/收起。
  - 控件默认弱显示或隐藏，hover 后更明显。
- 工具重复问题先在 demo 中通过结构拆分解决：
  - `tool.name` 只显示工具名。
  - `tool.input` 只显示输入摘要。
  - `tool.output` 只显示输出摘要或折叠输出。
- 后续真实落地需要再处理数据结构：
  - 将 `ExecutionTrajectoryStep.toolCall.input` 和 `ExecutionTrajectoryStep.toolResult.output/error` 映射到 UI。
  - 避免继续使用 `formatToolOperationText(title, detail)` 生成工具胶囊正文。

## Verification Steps
- 打开预览：
  - `http://localhost:8100/docs/agent-execution-chain-demo.html`
- 检查视觉：
  - 工具名与输入内容之间有清晰间距。
  - 工具胶囊不再重复显示 `WebSearch` 和 `搜索网页` 的同义信息。
  - 短工具输出不出现展开控件。
  - 长工具输出默认只展示 3 行。
  - hover 后出现可点击的展开/收起入口。
  - Step 长文本超过 300 字时默认 3 行折叠，hover 后可展开。
- 检查交互：
  - 点击长工具输出可以展开，再点击可以收起。
  - 点击长 Step 内容可以展开，再点击可以收起。
  - 展开后不会破坏现有 `过程(n)` 的折叠层级。
- 检查文件：
  - `docs/agent-execution-chain-demo.html` 无 HTML/CSS 明显语法错误。
