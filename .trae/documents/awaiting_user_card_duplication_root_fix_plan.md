# 「等待用户补充」卡片重复信息根因级修复方案

> 目标：从协议与渲染契约层根除「卡片摘要 / 面板标题 / 字段问题 / 通知 snippet / pending taskResult.blocks」之间的重复表达，避免后续新增任何文案/字段时再次出现「红框红框、箭头箭头」类问题。

---

## 一、Summary

当前重复不是个案 UI bug，而是 **同一条信息被允许同时填进多层协议字段，且没有任何一层定义"同屏展示优先级"**。具体：

- 服务端在 `coerceMissingUserContextBlocker` / `createPreExecutionInteractionRequirement` 中，当只有 1 个缺失字段时，会把 `fields[0].question` 抄到 `interactionRequirement.question`；同时还会把 `reason` 落到 `awaitingReason / finalMessage / summary`，再由 `resultNotificationJudge` 落到 `notification.snippet/userMessage/resultSummary.headline`。
- 前端 `TaskMessageCard`、`AwaitingUserResumePanel`、`InboxCard`、`ExecutionResultBody` 各自从这堆字段中"取自己最方便的那个"渲染，没有统一选择器。
- `taskResult.blocks` 里同样写了 `"需要你补充"` 标题 + 问题段落，与交互面板在某些入口仍可能同屏。

根因级修复 = **引入 AwaitingDisplayModel 契约**：把"卡片应显示什么"变成 **一个由服务端决定、前端只读** 的展示模型，所有入口（会话卡 / 收件箱 / 任务详情 / 时间线）都消费同一份 model，禁止再各自挑字段。

---

## 二、Current State Analysis

### 2.1 重复来源（基于 Phase 1 探查）

| 层 | 字段 | 当前来源 | 现象 |
|---|---|---|---|
| 通知层 | `notification.snippet`、`userMessage`、`resultSummary.headline` | [resultNotificationJudge.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/resultNotificationJudge.ts#L164-L185) 用 `interaction.reason` 生成 | 卡片摘要复用 → 与下方面板重复 |
| 交互层 | `interactionRequirement.question` | [preExecutionBlocker.ts#L30-L34](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskExecution/preExecutionBlocker.ts#L30-L34)：`fields.length===1 → fields[0].question` | 与字段级 question 完全相同 |
| 字段层 | `fields[].question` | [compileFields.ts#L26-L35](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/informationRequest/compileFields.ts#L26-L35) 由 readiness 派生 | 单字段时与上一层一字不差 |
| 结果块 | `taskResult.blocks` 中 `"需要你补充"` heading + paragraph | [preExecutionBlocker.ts#L88-L99](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/taskExecution/preExecutionBlocker.ts#L88-L99) | 当 defer 失败时与面板同屏 |
| 会话摘要 | `instance.result.summary / finalMessage / awaitingReason` | [goalTaskRunner.ts#L860-L956](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L860-L956) | 与 notification、interaction 重复 |

### 2.2 渲染入口（每个入口都自己挑字段）

- [TaskMessageCard.tsx#L80-L128](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/conversation/TaskMessageCard.tsx#L80-L128)：`summaryText`（取 notification.snippet）+ 嵌入 `AwaitingUserResumePanel`
- [AwaitingUserResumePanel.tsx#L350-L377](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/AwaitingUserResumePanel.tsx#L350-L377)：`headline`（取 requirement.question）+ 字段级 `questionForField`
- [InboxCard.tsx#L81-L99](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/inbox/InboxCard.tsx#L81-L99)：`notification.userMessage` + 嵌入 `TaskMessageCard`
- [ExecutionResultBody.tsx#L215-L243](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/ExecutionResultBody.tsx#L215-L243)：时间线 `waitingReason` + `interactionTurn`
- [TaskDetailBody.tsx#L796-L807](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/goal/TaskDetailBody.tsx#L796-L807)：时间线再嵌入面板

### 2.3 已存在但被绕过的设计

- `filterTaskResultForPresentation`（[presentationFilter.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/taskResult/presentationFilter.ts)）证明项目已有"渲染前过滤"先例，可以扩展同一模式。
- `shouldDeferConcreteResultUntilUserInput`（[ExecutionResultBody.tsx#L121](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/ExecutionResultBody.tsx#L121)、[TaskDetailBody.tsx#L78](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/goal/TaskDetailBody.tsx#L78)）逻辑被复制了两份，已经预示需要统一选择器。

---

## 三、Proposed Changes

### 设计核心：AwaitingDisplayModel 契约

新增一个纯函数 selector：`buildAwaitingDisplayModel(task, instance)`，返回结构化展示模型。所有渲染入口必须只通过它取值，不再读 `notification.*` / `interactionRequirement.question` / `fields[].question` 中任意一个原始字段。

```ts
// src/lib/taskInstance/awaitingDisplayModel.ts （新文件）
export type AwaitingDisplaySection =
  | { kind: "notice"; text: string }                   // 卡片顶部一句话说明（替代旧 notification.snippet）
  | { kind: "panel_title"; text: string }              // 面板小标题（"等待你补充信息"）
  | { kind: "headline"; text: string; suppressOnFields: boolean } // 主问题
  | { kind: "fields"; fields: MissingFieldQuestion[] } // 字段表单
  | { kind: "submitted"; submission: InteractionSubmission };

export type AwaitingDisplayModel = {
  active: boolean;                  // 是否处于等待用户态
  origin: "card" | "inbox" | "detail" | "timeline";
  sections: AwaitingDisplaySection[];
  hidePendingTaskResultBlocks: boolean; // pending 态隐藏 taskResult.blocks
  hideOuterSummary: boolean;        // 外层卡片摘要是否隐藏
};
```

**选择规则（唯一真理）**：

1. `active = !!instance.awaitingUser && !optionalFeedbackResult`
2. `notice` = `notification.snippet` 经 `stripNotificationPrefix` 处理；若与 headline/fields[*].question 语义同义 → 丢弃
3. `headline.text` = `interactionRequirement.question || awaitingUser.reason`
4. `headline.suppressOnFields` = `fields.length === 1 && isSameDisplayText(headline, fields[0].question)`
5. `fields` 直接取 `interactionRequirement.fields`
6. `hideOuterSummary = active`（卡片摘要只在非等待态展示）
7. `hidePendingTaskResultBlocks = active`

`isSameDisplayText` 复用现已写在 [AwaitingUserResumePanel.tsx#L203-L213](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/AwaitingUserResumePanel.tsx#L203-L213) 的归一化函数，提升到工具文件。

---

### 改动清单

#### 1. 新增 `src/lib/taskInstance/awaitingDisplayModel.ts`
- 导出 `buildAwaitingDisplayModel(task, instance, origin)`
- 导出 `normalizeDisplayText` / `isSameDisplayText`（从 AwaitingUserResumePanel 抽离）
- 内部包含 `mergeNoticeWithHeadline`：若 notice ⊆ headline 或反之，则去掉 notice
- 单测：`awaitingDisplayModel.spec.ts` 覆盖 4 组场景：单字段同义、多字段、无字段仅 confirm、已提交回显

#### 2. 协议层归一化：`src/lib/server/taskExecution/preExecutionBlocker.ts`
- 修改 `buildQuestion`：当 `fields.length === 1` 时 **不再** 把 `fields[0].question` 复制到顶层；置空字符串，由 UI 直接用 fields。
- 同步调整 `coerceMissingUserContextBlocker`（[goalTaskRunner.ts#L902-L943](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts#L902-L943)）的 `interactionRequirement.question` 赋值，单字段时留空。
- `taskResult.blocks` 在 pending-user 态保留构造，但增加一条 `meta.role: "pending_user_placeholder"`，给 selector 识别用。

#### 3. 通知层瘦身：`src/lib/server/resultNotificationJudge.ts`
- `contextRequiredDecision` 的 `snippet` 从 `[待补充] ${headline}` 改为 `[待补充] 任务「{title}」需要你补充信息`，**避免照抄问题原文**。
- `userMessage` 同样改为不重复 question 的版本，让 InboxCard 的"KiKi 第一段话"和卡片不会再字面相同。

#### 4. 渲染入口统一接入

- **TaskMessageCard.tsx**：删除 `summaryText` 中读取 `notification.snippet` 的分支；改为 `buildAwaitingDisplayModel(...)`。等待态不渲染外层 summary，由 model 控制。已有的 `instance.awaitingUser && !isOptionalFeedbackResult ? null` 临时补丁删除并替换为 model 驱动。
- **AwaitingUserResumePanel.tsx**：`headline` / `fields` / 是否隐藏字段问题改为 model 提供。删除当前内部的 `isSameDisplayText` 局部副本。
- **InboxCard.tsx**：展开态的 `KiKi: {notification.userMessage}` 改用 `model.notice`。若 model.notice 为空（已被去重），则隐藏 KiKi 段落，仅保留下方任务卡。
- **ExecutionResultBody.tsx / TaskDetailBody.tsx**：`shouldDeferConcreteResultUntilUserInput` 仍保留（它是渲染顺序而非文案问题）；但 pending taskResult.blocks 渲染入口改用 `model.hidePendingTaskResultBlocks`，避免新入口绕过。
- **GenericAgentResultView.tsx**：当 `taskResult.meta.role === "pending_user_placeholder"` 且 model.active 时返回 null。

#### 5. 字段级 question 兜底加固：`src/lib/server/informationRequest/compileFields.ts`
- 在 LLM 给多个 `fields[]` 但 question 完全相同时，`compileMissingFieldQuestions` 内增加 `dedupeQuestionsByLabel`：若 `field.question === otherField.question`，回退为 `请补充：${field.label}`。这避免多字段场景未来出现同句重复。

#### 6. 文档约束：`src/lib/server/goalTaskPrompt.ts`
- 在 LLM 协议注释中补充明确语义：
  - `interaction_requirement.question` 仅在 `fields.length !== 1` 时使用
  - 不允许把 `fields[i].question` 同时写进顶层 question
- 给 `task_result.blocks` 的 `"需要你补充"` 模板加注释：`仅作为协议归档，UI 在等待态会隐藏`

#### 7. 测试
- 单测 `awaitingDisplayModel.spec.ts`（新）
- 调整现存 `compileFields` / `preExecutionBlocker` 相关测试，断言单字段时顶层 question 为空
- 手动验证脚本：`pnpm dev` + 触发示例任务，对照截图核对箭头/红框不再重复

---

## 四、Assumptions & Decisions

1. **Single Source of Truth**：服务端只负责"事实"（缺失什么、为什么），UI 展示策略由前端 selector 决定。这避免在 LLM 协议里塞展示规则。
2. **不强制 LLM 改协议**：现有 LLM 输出仍被允许同时给 question + fields[].question；compiler 会做归一，不破坏向后兼容。
3. **不删除 notification.snippet**：通知中心、推送、未读折行仍需要它；只改写其内容使之不与卡片正文重复。
4. **保留 `taskResult.blocks` pending-user 模板**：为了归档/导出可追溯；UI 在等待态隐藏即可。
5. **范围**：本方案仅覆盖 `awaitingUser` 路径。已提交（`interactionSubmission`）路径的 `SubmittedInteractionPanel` 同样接入 model，但变更点小，归并在 #4 中处理。

---

## 五、Verification

1. `pnpm test` —— 跑 `awaitingDisplayModel.spec.ts`、`compileFields` 旧测试、`preExecutionBlocker`（若有）。
2. 启动 `pnpm dev`，构造单字段缺失（如缺 "出发城市"）：
   - 会话卡：仅出现 1 次"你打算从哪个城市出发？"，箭头处不再有"需要你补充关键信息"摘要。
   - 收件箱卡：KiKi 段落不复述问题；展开后的 TaskMessageCard 与之前一致。
   - 任务详情：时间线右侧交互气泡 + 结果区无 pending taskResult.blocks 同屏。
3. 构造多字段缺失（出发城市 + 日期 + 预算）：
   - headline 显示总问题，每个字段下显示自己的 question。
   - 没有任何两段文字 `normalizeDisplayText` 后相等。
4. 构造 LLM 故意给重复 question 的 fields：compiler 自动 fallback 到 `请补充：${label}`。
5. Lint / TypeCheck：`pnpm lint && pnpm tsc --noEmit`。

---

## 六、风险与回滚

- 风险点：`notification.userMessage` 改文案后，已存在的库内通知历史看起来与新版不一致 —— 可接受，无需迁移。
- 风险点：旧 checkpoint 中 `interactionRequirement.question` 仍带 fields[0].question；前端 selector 会用 `isSameDisplayText` 自动去重，向前兼容。
- 回滚：所有改动集中在 selector + 5 个生产者文件，回退影响面小；可通过 revert 单 PR 完成。
