# 多 Agent 调度与协同落地执行计划

> 本文档是整理后的落地执行版。前半部分给出可直接实施的方案，后半部分保留原始预研记录，避免遗漏讨论过的关键判断。

## 1. Executive Summary

当前项目可以增加多 Agent 协同，但不建议一开始做“多个 Agent 并发抢任务/抢文件”。推荐路径是：

1. **先做单任务内多角色协同**：一个 task instance 仍对应一个 `runtime_job`，但 job 内部由 Coordinator、Executor、Reviewer、Synthesizer 顺序协作。
2. **KiKi 掌握顶层编排权**：KiKi 负责角色状态、handoff、trajectory、取消、恢复、产物校验；Claude 自己发起的子 Agent 只作为角色内部实现细节。
3. **先顺序执行，不先并发写文件**：MVP 避免多 Claude CLI 进程同时改同一 workspace，降低资源竞争和产物冲突。
4. **最终结果继续走现有链路**：最终只由 Synthesizer 输出系统要求的纯 JSON，复用现有 `TaskResult`、artifact、blocker、resume、localValidation 和 acceptance。
5. **简单任务不启用多 Agent**：只对 mixed surfaces、webapp、文件产物、高价值决策、复杂报告等任务启用。

一句话结论：

* 如果目标是“让一次 Claude 回答更强”，可以让 Claude 自己发起子 Agent。

* 如果目标是“做 KiKi 这种可停止、可恢复、可观察、可验收的长程任务系统”，顶层编排权必须在 KiKi 任务层。

## 2. Why Multi-Agent

多 Agent 的收益不是“模型突然更聪明”，而是把复杂任务拆成不同责任边界：

* Coordinator 负责明确任务要求和完成标准。

* Executor 负责实际产出。

* Reviewer 负责独立检查是否满足要求。

* Synthesizer 负责吸收审阅意见并输出最终结果。

这样能解决当前单 Agent 容易出现的问题：

* 复杂结果漏字段：例如 mixed 模式有 blocks 但漏 files。

* 文件产物丢失：写了本地文件但没有通过 artifactRefs/files 返回。

* webapp 不完整：有 HTML，但 manifest、初始 state、预览要求不完整。

* 自审不可靠：同一个 Agent 既写又审，容易忽略自己的遗漏。

* 用户介入分类不准：把 deliverable\_gap、agent\_revision\_required 和 confirm 混成“待确认”。

### 具体例子

#### 旅行小应用

用户要求：“做一份胡志明市 5 天游玩行程，并生成可交互小应用。”

单 Agent 风险：

* 同时查资料、写路线、生成 webapp、检查结果，容易漏预算、餐厅、文件区域或 webapp manifest。

多角色收益：

* Coordinator 定义每日路线、预算、餐厅、webapp、markdown 文件都必须存在。

* Executor 生成 blocks、webapp 和文件内容。

* Reviewer 检查双区域结果、webapp 预览和文件产物是否齐全。

* Synthesizer 输出最终 JSON。

#### 买 SUV 决策

用户要求：“比较 30 万以内适合家庭的 SUV，考虑空间、安全、油耗、保值率，给 3 个推荐。”

单 Agent 风险：

* 评价维度不一致，广告口径混入事实，推荐理由跳跃。

多角色收益：

* Coordinator 定义评价矩阵。

* Researcher 收集候选和证据。

* Executor 生成对比表和推荐。

* Reviewer 检查是否同维度比较、是否有来源冲突。

* Synthesizer 给最终推荐，并把试驾候选选择表达为 `confirm`。

#### 报告 + 文件 + 摘要卡片

用户要求：“生成产品分析报告，导出 markdown 文件，并在交互区展示摘要卡片。”

单 Agent 风险：

* blocks 有了但 files 漏了，或 markdown 与摘要不一致。

多角色收益：

* Reviewer 专门检查 mixed 模式是否同时满足 blocks 和 artifacts。

* Synthesizer 确保最终 JSON 同时包含 `task_result.blocks` 和 `files`。

## 3. Current State

### 3.1 已有能力

当前项目已有多 Agent MVP 所需的大部分地基：

* `src/lib/server/goalTaskRunner.ts`：已有 Claude CLI 调用、流式事件、tool\_call 轨迹、JSON 解析、本地校验、自动修复、验收评审、阻塞点、产物落盘。

* `src/lib/server/repositories/runtimeJobsRepository.ts`：`runtime_jobs` 已有 `trajectory_json`、`blocker_json`、`result_json`，可承载角色运行记录。

* `src/types/executionTrajectory.ts`：已有 trajectory step 类型，可扩展 `agentRole` 和 `handoff`。

* `src/types/kiki.ts`：已有 `TaskCollaborationRequirements` 和 `InteractionRequirement`，能表达用户与 Agent 的协作要求。

* `src/components/task/TaskExecutionTimeline.tsx`：已有执行过程 UI，可增强为角色 timeline。

* `src/components/task/GenericAgentResultView.tsx`：已支持交互渲染区 + 文件区域并列展示。

* `src/lib/server/workspace/artifactStorage.ts`：已支持文件产物和 webapp 产物落盘。

### 3.2 当前并发真实状态

当前不是完整服务端多任务并发模型：

* 队列层支持多个任务进入 `runtime_jobs`。

* 浏览器实验调度器有 `maxConcurrentTasks`。

* 服务端 daemon 仍是串行消费：`taskDispatchWorker` 使用 `claimQueuedRuntimeJobs({ limit: 1 })`，daemon 会 `await runTaskDispatchWorker`。

因此，多 Agent MVP 不应假设已有可靠的服务端并发执行能力。

## 4. Core Decisions

### 4.1 编排权

采用“KiKi 任务层编排为主，Claude 内部子 Agent 为辅”。

KiKi 负责：

* 角色计划。

* 角色状态。

* 结构化 handoff。

* trajectory。

* 取消和恢复。

* 权限分层。

* 结果校验。

* artifact 入库。

Claude 内部子 Agent 可以使用，但只作为某个角色内部实现细节：

* 可以记录为该角色下的一条 tool\_call。

* 不作为 UI、恢复、通知、验收的产品状态源。

### 4.2 执行粒度

MVP 不把每个角色拆成独立 `runtime_job`。

原因：

* 当前 job id 是 `job-${instance.id}`，天然是 task instance 级别。

* 拆成角色 job 会牵涉调度器、租约、恢复、取消、UI 的大改。

* 角色协同的第一价值是质量控制，不是吞吐。

推荐：

* 一个 task instance = 一个 runtime\_job。

* 一个 runtime\_job 内部包含多个 role run。

### 4.3 文件编辑

采用“单写者规则”：

* Coordinator：不写业务产物。

* Researcher：readonly。

* Executor：唯一默认允许写业务产物的角色。

* Reviewer：readonly，只输出 issue 和 suggestedFix。

* Synthesizer：默认不改文件，只输出最终 JSON。

如果 Reviewer 发现文件问题：

* 不直接改文件。

* 打回 Executor 修订。

* 修订后 Reviewer 复查。

### 4.4 冲突解决

冲突优先级：

1. 用户最新输入。
2. 任务 `expectedResult`、`collaboration`、surfaces、completionCriteria。
3. 有来源的高置信事实。
4. Reviewer blocking issue。
5. Coordinator 定义的完成标准。

冲突处理：

* 可自动修复：Executor 修订 → Reviewer 复查。

* 依赖用户偏好：生成 `InteractionRequirement`。

* 无法解决：标记 `agent_revision_required` 或 failed，不伪装完成。

## 5. Target Architecture

### 5.0 Goal-Level vs Task-Level Multi-Agent

需要区分两个层级：

* 任务级多 Agent：解决“一个任务怎么产出更高质量结果”。

* 目标级多 Agent：解决“整个目标下多个任务是否方向一致、依赖是否合理、产物是否能合成最终目标成果”。

当前文档的 M1 先做任务级多 Agent，因为它改动更小、收益更直接、能复用现有 `runtime_jobs` 和 `goalTaskRunner`。

但从长程目标系统看，最终确实需要目标级 Agent，建议作为 M2.5 或 M3 的能力加入。

#### 目标级多 Agent 适合解决什么

目标级多 Agent 的价值不是替代每个任务执行，而是做跨任务协调：

* 全局一致性：多个任务产出的结论、口径、格式是否一致。

* 依赖管理：前置任务没完成时，后续任务是否应该暂停或改写。

* 任务重排：目标推进中发现优先级变化，是否需要新增、暂停、合并任务。

* 跨任务冲突：任务 A 的结论和任务 B 的结论冲突时，谁来裁决。

* 最终合成：所有子任务完成后，是否需要目标级总结、报告、dashboard 或 handoff package。

* 进度监督：哪些任务卡住，哪些应该自动修订，哪些需要问用户。

#### 推荐的目标级角色

目标级不建议一开始就让多个 Agent 都能执行和写文件。推荐先做轻量监督角色：

* Goal Coordinator：维护目标全局状态、成功标准、任务依赖和当前优先级。

* Goal Reviewer：定期检查所有任务结果是否共同满足目标，发现缺口和冲突。

* Goal Synthesizer：在关键阶段合成目标级结果，例如最终总结或阶段性报告。

不建议 MVP 做：

* 不建议目标级 Agent 直接改每个任务产物。

* 不建议目标级 Agent 和任务级 Executor 同时写同一文件。

* 不建议目标级 Agent 每轮都重规划整个目标。

#### 目标级通信模型

目标级需要一个跨任务黑板：

```text
<conversationWorkspaceDir>/planning/
  goal-orchestration.json
  goal-blackboard.json
  goal-review.json
```

其中：

* `goal-orchestration.json`：记录目标级 Agent 的运行计划。

* `goal-blackboard.json`：记录目标成功标准、关键决策、跨任务事实、冲突、全局风险。

* `goal-review.json`：记录 Goal Reviewer 对整个目标的审阅结果。

任务级结果向目标级上报：

* task summary。

* artifactRefs。

* interactionRequirement。

* review decision。

* unresolved risks。

目标级 Agent 只消费这些摘要，不读取所有任务 raw output，避免上下文爆炸。

#### 目标级冲突解决

目标级冲突优先级：

1. 用户最新目标描述和最新反馈。
2. goal workflow 中确认过的目标成功标准。
3. 已完成任务的高置信 evidence。
4. Goal Reviewer 的 blocking issue。
5. 单个 Task Reviewer 的局部判断。

处理方式：

* 局部问题：打回对应任务修订。

* 全局目标变化：建议重排任务或新增任务，但需要用户确认。

* 任务结论冲突：生成 conflict review，让相关任务补证据或由 Goal Synthesizer 裁决。

* 无法自动裁决：生成目标级 `InteractionRequirement`。

#### 目标级与任务级的推荐推进顺序

推荐顺序：

1. M1：任务级多角色协同，先把单任务产物质量做稳。
2. M2：任务级角色恢复和审阅打回。
3. M2.5：目标级轻量 Goal Reviewer，只做跨任务检查，不改任务。
4. M3：目标级 Goal Coordinator，支持任务重排、新增建议、阶段性合成。
5. M4：目标级与任务级形成完整层级编排。

为什么不先做目标级：

* 当前目标规划已有 `goalPlanning`、subGoals、tasks、checkpoint，已经具备基础目标拆解。

* 目前更大的质量缺口在单任务产物是否完整、是否符合双区域结果和文件产物要求。

* 目标级 Agent 如果过早拥有重排和写入能力，容易引入大范围状态不一致。

最终形态：

```text
Goal Coordinator
  → 监督多个 SubGoal / Task
  → 必要时触发 Task-Level Multi-Agent
  → Goal Reviewer 做跨任务审阅
  → Goal Synthesizer 输出目标级阶段成果或最终成果
```

### 5.1 新增模块

新增目录：

```text
src/lib/server/agentOrchestration/
  MultiAgentOrchestrator.ts
  prompts.ts
  strategy.ts
  handoff.ts
  review.ts
```

新增类型：

```text
src/types/agentOrchestration.ts
```

### 5.2 角色

MVP 默认角色：

* Coordinator：确认任务要求、完成标准、角色计划。

* Executor：执行任务和生成候选产物。

* Reviewer：检查产物是否满足要求。

* Synthesizer：合成最终 JSON。

可选角色：

* Researcher：只在信息收集较重的任务启用。

### 5.3 策略

策略选择：

* `single_agent`：简单任务、短文本任务、用户要求快速回答。

* `quality_review`：复杂报告、mixed surfaces、文件产物。

* `research_then_write`：调研、决策、对比类任务。

* `build_then_review`：webapp、小应用、代码/文件产物。

启用多角色的推荐条件：

* `expectedResult.surfaces` 包含 `files` 且包含 `interactive`。

* `interactiveSurface.kind` 是 `webapp`、`dashboard`、`form`。

* `fileSurface.required = true`。

* `presentation` 是 `dashboard`、`handoff_package`、`visual_report`。

* 任务优先级 high / critical。

禁用多角色的条件：

* 简单问答。

* 只需要短文本。

* 用户明确要求快速响应。

* 当前是恢复路径的小修订。

* 上一次同任务多角色失败且不可自动修复。

## 6. Data Model

新增 `src/types/agentOrchestration.ts`：

```ts
export type AgentRole =
  | "coordinator"
  | "researcher"
  | "executor"
  | "reviewer"
  | "synthesizer";

export type AgentRoleRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "awaiting_user";

export type AgentRoleRun = {
  id: string;
  role: AgentRole;
  title: string;
  objective: string;
  inputSummary: string;
  outputSummary?: string;
  status: AgentRoleRunStatus;
  startedAt?: string;
  finishedAt?: string;
  rawOutput?: string;
  parsedOutput?: Record<string, unknown>;
  error?: string;
  filesTouched?: string[];
};

export type AgentHandoff = {
  fromRole: AgentRole;
  toRole: AgentRole;
  summary: string;
  claims: Array<{
    text: string;
    confidence: "low" | "medium" | "high";
    evidence?: string[];
  }>;
  decisions: string[];
  openQuestions: string[];
  risks: string[];
  filesTouched?: string[];
  artifactRefs?: string[];
  createdAt: string;
};

export type AgentReviewDecision = {
  passed: boolean;
  severity: "info" | "warning" | "blocking";
  issues: Array<{
    id: string;
    severity: "info" | "warning" | "blocking";
    message: string;
    expected: string;
    actual: string;
    suggestedFix?: string;
  }>;
  decisionReason: string;
};

export type AgentRunPlan = {
  schemaVersion: 1;
  mode: "single_agent" | "role_collaboration";
  strategy: "quality_review" | "research_then_write" | "build_then_review" | "custom";
  roles: AgentRoleRun[];
  handoffs: AgentHandoff[];
  review?: AgentReviewDecision;
  finalRole: AgentRole;
};
```

扩展 `src/types/executionTrajectory.ts`：

```ts
agentRole?: AgentRole;
handoff?: {
  fromRole?: AgentRole;
  toRole?: AgentRole;
  summary: string;
};
```

扩展 `TaskResult.meta`：

```ts
agentRunPlan?: AgentRunPlan;
qualityReview?: {
  passed: boolean;
  issues: string[];
  reviewerRole: "reviewer";
};
```

MVP 存储策略：

* 不新增 DB 表。

* `AgentRunPlan` 写入 `runtime_jobs.result_json` 和最终 `taskResult.meta`。

* role/handoff 写入 `trajectory_json`。

* 调试文件可写入 `<taskWorkspaceDir>/agent-orchestration/`。

## 7. Runtime Flow

MVP 流程：

```text
taskDispatchWorker
  → runGoalTask
  → chooseAgentStrategy
  → single_agent 或 role_collaboration

role_collaboration:
  → Coordinator 生成 AgentRunPlan
  → Executor 生成候选产物
  → Reviewer 审阅候选产物
    → passed: Synthesizer 合成最终 JSON
    → blocking: Executor 修订一次，再 Reviewer 复查
    → needs user: 生成 InteractionRequirement
  → parseAndRepair
  → localValidation
  → acceptance
  → artifactStorage
  → write runtime job / task snapshot / goals snapshot
```

取消：

* MVP 取消粒度是当前 role run。

* 用户停止任务时，中断当前 Claude CLI，job 标记 cancelled。

恢复：

* MVP 先复用现有 `/api/goals/tasks/resume`。

* M2 再支持从最后 completed role 后继续。

## 8. Communication Model

多 Agent 之间不自由聊天，而是使用三类通信通道：

* Structured Handoff：角色之间传递摘要、事实、风险、文件引用、开放问题。

* Blackboard：稳定状态，可选写入 `<taskWorkspaceDir>/agent-orchestration/blackboard.json`。

* Trajectory：用于 UI 和恢复的过程记录。

推荐目录：

```text
<taskWorkspaceDir>/agent-orchestration/
  run-plan.json
  blackboard.json
  handoffs/
    001-coordinator-to-executor.json
    002-executor-to-reviewer.json
    003-reviewer-to-synthesizer.json
```

## 9. UI Plan

### Timeline

修改 `src/components/task/TaskExecutionTimeline.tsx`：

* 展示 role label。

* handoff step 使用单独样式。

* review blocking issue 突出显示。

* 默认折叠详细 tool\_call。

### Result View

修改 `src/components/task/GenericAgentResultView.tsx`：

* 如果 `taskResult.meta.agentRunPlan` 存在，显示轻量“多角色协同摘要”。

* 不替代现有交互渲染区和文件区域。

* 最终结果仍以 blocks、webapp、artifacts 为主。

## 10. Configuration

建议增加配置：

```ts
type MultiAgentConfig = {
  multiAgentEnabled: boolean;
  multiAgentMode: "off" | "auto" | "force";
  maxRoleRunsPerTask: number;
  maxReviewRounds: number;
  roleTimeoutMs: number;
  roleCollaborationMinComplexity: "medium" | "high";
};
```

默认：

* `multiAgentEnabled = false` 或仅开发开关打开。

* `multiAgentMode = "auto"`。

* `maxReviewRounds = 1`。

* `maxRoleRunsPerTask = 5`。

## 11. Risks And Guardrails

### 成本和延迟

风险：

* 多次 LLM 调用变慢、变贵。

控制：

* 复杂任务才启用。

* 限制角色数量和审阅轮数。

* 角色超时。

### 上下文膨胀

风险：

* raw output 全量传递导致 prompt 过长。

控制：

* 只传 handoff。

* raw output 只用于调试或落盘。

* 大内容用 artifactRef 或 workspace 文件引用。

### 提示注入传播

风险：

* Researcher 读取的外部内容污染 Executor/Synthesizer。

控制：

* 外部内容只作为 evidence。

* Synthesizer 只服从 KiKi 系统要求、用户输入和任务完成标准。

* Reviewer 检查注入迹象。

### 角色越权

风险：

* Researcher 给最终建议、Reviewer 直接改文件、Synthesizer 重新搜索。

控制：

* role prompt 明确边界。

* 本地校验 role output。

* 单写者规则。

### 用户体验复杂

风险：

* timeline 太复杂。

控制：

* 默认只显示角色摘要。

* 详细过程折叠。

* blocking issue 重点展示。

### 失败兜底

策略：

* Coordinator 失败：回退 single\_agent。

* Executor 失败：failed 或 agent\_revision\_required。

* Reviewer 失败：降级本地 validation + acceptance。

* Synthesizer 失败：重试一次，然后走 parseAndRepair。

## 12. Rollout Plan

### M1：多角色协同 MVP

范围：

* 新增类型和编排器。

* 在 `goalTaskRunner` 增加 strategy 选择。

* 默认顺序执行 Coordinator → Executor → Reviewer → Synthesizer。

* 最终结果复用现有 TaskResult 和 artifact 链路。

* timeline 增加 role/handoff 展示。

不做：

* 不做角色级 runtime\_job。

* 不做服务端多任务并发。

* 不做多个 Executor 同时写文件。

* 不做跨任务长期 Agent 记忆。

### M2：角色级恢复与更强审阅

范围：

* 从最后 completed role 继续。

* Reviewer 打回后精准修订。

* `agent-orchestration` workspace 文件落盘。

### M2.5：目标级轻量审阅

范围：

* 新增 Goal Reviewer，只做跨任务一致性检查。

* 读取任务级结果摘要、artifactRefs、review decision、unresolved risks。

* 生成目标级缺口清单、冲突清单和下一步建议。

* 不直接改任务、不直接写业务产物、不自动重排任务。

### M3：服务端多任务并发

范围：

* `daemonConfig` 增加 `maxConcurrentJobs`。

* `taskDispatchWorker` 支持受控并发。

* `claimQueuedRuntimeJobs` 原子认领。

* 每个 job 独立 lease、abort、写回。

### M4：目标级 Coordinator 与角色级 DAG

范围：

* Goal Coordinator 支持任务重排、新增建议、暂停建议。

* role dependsOn。

* 并行 Researcher。

* 隔离 workspace 合并。

* 独立 `agent_runs` / `agent_handoffs` 表。

## 13. Verification

静态验证：

* `pnpm lint`。

* `pnpm build`。

* TypeScript 检查新增可选字段不破坏旧数据。

单元验证：

* strategy 选择：简单任务 single\_agent，mixed/webapp/file 任务 role\_collaboration。

* handoff 归一：缺字段能兜底。

* review 决策：blocking issue 会触发修订或 agent\_revision\_required。

* trajectory：旧 step 无 `agentRole` 仍可渲染。

手动验收：

* 普通 markdown 任务仍走单 Agent。

* mixed 任务出现角色 timeline，且 blocks + files 都存在。

* webapp 任务经过 Reviewer 检查后仍能预览。

* Reviewer 打回时不误推用户确认。

* 停止运行中任务时能中断当前角色。

效果评估：

* 结构完整率。

* 验收首次通过率。

* 修订次数。

* 用户介入分类准确率。

* 平均耗时和 token 成本。

## 14. Files To Change

新增：

* `src/types/agentOrchestration.ts`

* `src/lib/server/agentOrchestration/MultiAgentOrchestrator.ts`

* `src/lib/server/agentOrchestration/prompts.ts`

* `src/lib/server/agentOrchestration/strategy.ts`

* `src/lib/server/agentOrchestration/handoff.ts`

* `src/lib/server/agentOrchestration/review.ts`

修改：

* `src/lib/server/goalTaskRunner.ts`

* `src/types/executionTrajectory.ts`

* `src/types/taskResult.ts`

* `src/components/task/TaskExecutionTimeline.tsx`

* `src/components/task/GenericAgentResultView.tsx`

可选修改：

* `src/lib/goalSystemConfig.ts`

* `src/components/settings/SettingsModal.tsx`

* `src/lib/server/workspace/conversationWorkspace.ts`

## 15. Open Questions

这些问题可以在实施前锁定：

* 多 Agent 开关放在开发设置里，还是 runtime daemon config 里？

* `AgentRunPlan` MVP 是否只放 `result_json`，还是同时落 workspace 文件？

* Reviewer 打回默认 1 轮是否足够？

* 是否需要在 UI 明确显示“本任务使用多角色协同”？

* 首批启用多角色的任务类型是否只覆盖 mixed/webapp/file？

## Appendix：原始预研记录

## Summary

当前项目可以增加多 Agent 调度与协同，但建议先把“角色协同”和“多任务并发”拆开推进。

推荐 MVP 先做“单任务内的多角色协同”，即在一个任务实例中引入 Coordinator、Worker、Reviewer、Synthesizer 等角色，让任务从“单个 Agent 一次性产出”升级为“分工执行、交叉审阅、统一合成”的可观测流程。多任务并发属于调度吞吐能力，当前项目已有“多任务入队”基础，但服务端 daemon 仍是串行执行，不应与角色协同 MVP 混在一起。

核心结论：

* 角色协同有明显收益：降低单次输出偏差、补齐审阅环节、支持复杂任务分解、让用户看到不同角色的执行轨迹，并为后续“可执行小应用区”和文件产物质量把关。

* 当前并发状态是“队列可容纳多个任务，但服务端执行是单 worker 串行消费”。前端浏览器调度器有 `maxConcurrentTasks` 配置，但服务端 `taskDispatchWorker` 每轮 `limit: 1`，daemon 会 `await` 执行完成后再进入下一轮。

* 最稳妥路线是：先在现有 `goalTaskRunner` 外包一层 `MultiAgentOrchestrator`，复用 runtime\_jobs、trajectory、blocker、artifact、TaskResult 校验和恢复链路，不推倒重写。

* 数据模型应新增轻量的 `AgentRunPlan`、`AgentRoleRun`、`AgentHandoff`，先落在 `runtime_jobs.result_json` / `trajectory_json` 中，必要时第二阶段再加独立表。

## Current State Analysis

### 执行与调度现状

* `src/lib/daemon/daemonRunner.ts`

  * daemon 循环每轮执行：读取 goals → `runGoalSchedulerEngine` 入队 → `await runTaskDispatchWorker(config.deviceId)` → sleep。

  * 由于 `await runTaskDispatchWorker` 会等待任务执行完成，服务端后台执行链路实际是串行推进。

* `src/lib/server/worker/goalSchedulerEngine.ts`

  * 可一次扫描多个 ready task，并最多切出 50 个任务入队。

  * 调度维度是 task instance，不是 agent role，也没有角色级依赖、handoff 或审阅节点。

* `src/lib/server/worker/taskDispatchWorker.ts`

  * `claimQueuedRuntimeJobs({ limit: 1 })` 明确每轮只认领一个 job。

  * 使用租约续租与 `AbortController` 控制单个任务生命周期。

  * 结果写回依赖 `goalTelemetry`、`runtime_jobs`、goals snapshot 和 task run snapshot。

* `src/lib/server/repositories/runtimeJobsRepository.ts`

  * `RuntimeJobKind` 目前只有 `"goal_task"`。

  * `runtime_jobs` 已有 `trajectory_json`、`blocker_json`、`result_json`，足够承载 MVP 的多角色执行轨迹和汇总结果。

  * job id 使用 `job-${payload.instance.id}`，同一 task instance 去重，这对“角色拆成独立 job”的方案不友好，MVP 不建议把角色直接拆成 runtime\_jobs。

### Runner 与结果现状

* `src/lib/server/goalTaskRunner.ts`

  * 主 Runner 已包含：前置 readiness、自检、Claude CLI 流式执行、tool\_call 轨迹、JSON 解析、本地校验、自动修复、验收评审、阻塞点、产物落盘。

  * 这些能力是多角色协同的基础，不应重写。

  * 当前模型仍是单 Agent prompt 产出，再通过本地校验和验收补救。

* `src/lib/server/claudeCli.ts`

  * 已能流式捕获 session、delta、message、tool\_call、permission\_request、error、done。

  * 可复用它为不同角色分别发起 Claude CLI 调用。

* `src/types/executionTrajectory.ts`

  * 当前 `ExecutionTrajectoryStep` 有 system、assistant、tool\_call、tool\_result、approval、result、error，但没有 role 字段。

  * MVP 可先把 role 信息写入 `title` / `thought` / `toolCall.summary`，更完整方案应扩展类型。

* `src/types/kiki.ts`

  * 已有 `TaskCollaborationRequirements`，表达用户与 Agent 的协作职责。

  * 还没有表达“多个 Agent 角色之间如何分工”的字段。

* `src/lib/taskResult/parseAndRepair.ts` 与 `src/lib/taskResult/localValidation.ts`

  * 已支撑 `TaskResult`、blocks、artifactRefs 的归一与校验。

  * 多角色最终合成结果仍应走同一套校验，避免新增一条不可控产出通道。

### UI 与可观测性现状

* `src/components/task/TaskExecutionTimeline.tsx`

  * 现在按 step 展示执行链路，但状态文案仍偏单 Agent。

  * 多角色协同需要展示“角色、输入、输出、handoff、审阅意见、最终合成”。

* `src/components/task/GenericAgentResultView.tsx`

  * 已支持双区域呈现：交互渲染区 + 文件区域。

  * 多角色最终结果可以继续使用现有 `TaskResult` 和 artifactRefs 渲染，不需要新增结果 UI。

* `src/components/execution/SandboxedWebAppSurface.tsx`

  * 已有可执行小应用 iframe 和状态持久化能力。

  * 角色协同的 Reviewer 可专门检查 webapp/interactive surface 是否满足任务要求。

### 关于“当前是否已支持多任务并发”

严格区分三层：

* 队列层：支持多个任务进入 `runtime_jobs`，`goalSchedulerEngine` 一轮可创建多个 queued jobs。

* 前端实验层：`GoalSchedulerRuntime` 有 `settings.maxConcurrentTasks`，在浏览器调度模式下会同时发起多个 `startTaskRun` 请求。

* 服务端 daemon 层：不支持真正并发执行，`taskDispatchWorker` 每轮 `limit: 1`，且 daemon `await` 当前任务结束后才继续下一轮。

因此当前更准确的说法是：支持多任务排队和部分前端侧并发启动，但服务端后台 Worker 不是并发执行模型。

## Proposed Changes

### Architecture Decision：编排权放在 KiKi 任务层，而不是完全交给 Claude 自己

这里有两种落地方式：

* 方式 A：KiKi 在任务层发起多个角色运行，例如 Coordinator / Researcher / Executor / Reviewer / Synthesizer 分别由 KiKi 调用 Claude CLI，KiKi 负责记录状态、串联上下文、写 trajectory、处理取消和恢复。

* 方式 B：KiKi 只调用一次 Claude，让 Claude 在自己的执行过程中发起子 Agent，再由 Claude 汇总最终结果。

推荐采用“KiKi 任务层编排为主，Claude 内部子 Agent 为辅”的混合方案。

#### 方式 A：KiKi 任务层发起多个角色运行

优点：

* 可观测：每个角色的开始、结束、失败、handoff 都能写入 `trajectory_json`，UI 能展示“谁做了什么”。

* 可停止：用户点停止时，KiKi 能知道当前运行的是哪个角色，并通过现有 `AbortController` 中断当前 Claude CLI。

* 可恢复：未来可以从失败角色继续，例如只重跑 Reviewer 或 Synthesizer，而不是整次任务重跑。

* 可验收：只有 Synthesizer 的最终 JSON 进入现有 `TaskResult`、artifact、localValidation、acceptance 链路。

* 可控权限：Researcher / Reviewer / Synthesizer 可以强制 readonly，Executor 才继承任务 runtime permission。

* 可产品化：角色状态可以进入任务详情、结果摘要、通知判断和后续调度策略。

缺点：

* 工程复杂度更高，需要 KiKi 自己维护角色计划、上下文拼接、错误处理。

* 多次 Claude CLI 调用会增加延迟和 token 成本。

* 如果直接并发多个进程，会带来资源竞争、workspace 写入冲突、SQLite 写锁和取消隔离问题。

结论：

* 这是更适合 KiKi 产品化长程任务的主路径。

* MVP 建议“任务层拥有编排权，但角色先顺序执行”，不要一开始就并发多个进程。

#### 方式 B：让 Claude 自己发起子 Agent

优点：

* 接入快：KiKi 只需要发一次 prompt，Claude 自己决定是否拆子 Agent。

* 认知灵活：Claude 能根据上下文临时决定让子 Agent 搜索、阅读、分析或审阅。

* 成本低：不需要 KiKi 新增完整的角色状态机。

缺点：

* 黑箱：KiKi 只能看到 Claude 暴露出来的 tool\_call 或最终文本，无法稳定知道每个子 Agent 的完整输入、输出、状态和失败原因。

* 难恢复：如果 Claude 内部某个子 Agent 做错了，KiKi 很难只从那个子 Agent 继续。

* 难取消：用户点停止时，KiKi 只能中断整次 Claude CLI，不能产品化地显示“当前 Researcher 已停止，Reviewer 未开始”。

* 难约束权限：KiKi 难以按角色强制 readonly / execute 分层。

* 难验收：Claude 内部子 Agent 的中间结论通常不会天然进入 KiKi 的 `AgentRunPlan`、handoff、qualityReview。

* 难做 UI：任务详情页无法稳定展示角色级 timeline，只能展示一段合并后的执行过程。

结论：

* 适合做单次 Claude 调用内部的“临时增强能力”。

* 不适合作为 KiKi 多 Agent 协同的产品级真源。

#### 推荐混合边界

MVP 采用：

* KiKi 负责顶层角色编排：Coordinator → Executor → Reviewer → Synthesizer。

* Claude 可以在某个角色内部自行调用子 Agent，但这些内部子 Agent 只算该角色的内部实现细节。

* KiKi 只信任角色级输出，不把 Claude 内部子 Agent 当成产品状态源。

* 如果 Claude 内部调用了 Task / 子 Agent，KiKi 可以把它记录为该角色下的一条 tool\_call，但不承诺对子 Agent 做单独恢复和 UI 展示。

* 需要进入 UI、恢复、审阅、通知和产物校验的，必须由 KiKi 任务层角色输出结构化结果。

一句话判断：

* 如果目标是“让一次回答更强”，可以让 Claude 自己发起子 Agent。

* 如果目标是“做一个可停止、可恢复、可观察、可验收的长程任务系统”，编排权必须在 KiKi 任务层。

### Communication Model：多 Agent 之间怎么通信

不建议让多个 Agent 自由聊天，也不建议让它们共享一段不断膨胀的全文上下文。MVP 应采用“结构化移交 + 共享黑板 + 角色只读/单写”的通信模型。

#### 通信通道 1：结构化 Handoff

每个角色结束时，必须输出一份 `AgentHandoff`，交给下一个角色。

建议字段：

```ts
export type AgentHandoff = {
  fromRole: AgentRole;
  toRole: AgentRole;
  summary: string;
  claims: Array<{
    text: string;
    confidence: "low" | "medium" | "high";
    evidence?: string[];
  }>;
  decisions: string[];
  openQuestions: string[];
  risks: string[];
  filesTouched?: string[];
  artifactRefs?: string[];
  createdAt: string;
};
```

作用：

* Researcher 不把全部搜索过程塞给 Executor，只移交关键事实、来源、置信度和缺口。

* Executor 不把全部草稿塞给 Reviewer，只移交产出摘要、产物引用、关键设计决策。

* Reviewer 不直接重写结果，而是移交 issue list、严重程度、是否放行。

* Synthesizer 根据所有 handoff 合成最终 JSON。

#### 通信通道 2：共享黑板

在 task workspace 内维护一个轻量共享文件，例如：

```text
<taskWorkspaceDir>/agent-orchestration/
  run-plan.json
  blackboard.json
  handoffs/
    001-coordinator-to-executor.json
    002-executor-to-reviewer.json
    003-reviewer-to-synthesizer.json
```

`blackboard.json` 只存稳定信息：

* 任务目标和完成标准。

* 已确认的事实。

* 已生成的产物引用。

* 未解决问题。

* 当前放行状态。

MVP 也可以不先落文件，而是把这些结构放在 `runtime_jobs.result_json.agentRunPlan` 和 `trajectory_json` 中；落文件适合调试和后续恢复。

#### 通信通道 3：Trajectory

所有关键移交都写入 `ExecutionTrajectoryStep`：

* role started。

* role completed。

* handoff created。

* review failed / review passed。

* synthesis completed。

这样 UI 不需要理解所有内部细节，也能展示“发生了哪些角色协同”。

### Conflict Resolution：冲突怎么解决

冲突来源主要有三类：

* 事实冲突：Researcher 找到的信息互相矛盾。

* 方案冲突：Executor 的产出和 Coordinator 定义的完成标准不一致。

* 审阅冲突：Reviewer 认为不合格，但 Executor 认为已经完成。

MVP 的冲突解决规则：

1. 用户最新输入优先。
2. 任务 `expectedResult`、`collaboration`、surfaces、completionCriteria 优先于角色个人判断。
3. 有来源的高置信事实优先于无来源结论。
4. Reviewer 发现结构性缺失时优先级高，例如缺 blocks、缺 files、缺 webapp、artifactRefs 不完整。
5. 如果冲突能由 Agent 自我修订解决，进入 Executor 修订 → Reviewer 复查，最多 1 到 2 轮。
6. 如果冲突依赖用户偏好或外部现实确认，生成 `InteractionRequirement`，进入现有等待用户链路。
7. 如果冲突无法解决但不需要用户，标记 `agent_revision_required` 或 failed，不要伪装成完成。

建议新增审阅结果结构：

```ts
export type AgentReviewDecision = {
  passed: boolean;
  severity: "info" | "warning" | "blocking";
  issues: Array<{
    id: string;
    severity: "info" | "warning" | "blocking";
    message: string;
    expected: string;
    actual: string;
    suggestedFix?: string;
  }>;
  decisionReason: string;
};
```

冲突处理示例：

* Reviewer 发现 mixed 模式只有 blocks 没有 files：blocking，打回 Executor 补文件，不问用户。

* Reviewer 发现 SUV 推荐里两个车型保值率数据冲突：warning，如果有来源差异，Synthesizer 标注置信度；如果影响最终推荐，Researcher 补查。

* Reviewer 发现用户没有预算上限，但任务必须按预算推荐：生成 provide\_context，问用户补预算。

### File Editing Model：会不会编辑多个文件

会有编辑多个文件的情况，尤其是 webapp、小应用、代码产物、报告 + 数据文件这类任务。但 MVP 必须避免多个角色同时编辑同一批文件。

推荐“单写者规则”：

* Coordinator：不写业务产物，只写 run plan / handoff。

* Researcher：readonly，不写业务产物，只写研究摘要或 handoff。

* Executor：唯一允许写业务产物的角色，例如 markdown、html、json、csv、webapp 文件。

* Reviewer：readonly，不直接改文件，只输出 review issues 和 suggestedFix。

* Synthesizer：默认不改业务文件，只负责最终 JSON；如必须修正引用或 manifest，应走一次 Executor 修订。

这样可以避免：

* Researcher 和 Executor 同时改同一个文件。

* Reviewer 一边审一边改，导致审阅结果不可追踪。

* Synthesizer 为了“修一下”破坏已落盘产物和 artifactRefs 对齐。

多文件编辑的安全边界：

* 每个角色声明 `filesTouched`。

* `artifactStorage` 仍是产物落盘真源，文件最终必须通过现有 artifact 链路入库。

* 如果是代码任务，Executor 可以编辑多个文件，但 Reviewer 只能提出 patch 建议，不直接应用。

* 如果未来要并行执行多个 Executor，必须使用隔离 workspace 或分支目录，最后由 Synthesizer/merge role 合并，不能共享写同一个目录。

MVP 不建议：

* 不建议多个 Agent 同时写同一 workspace。

* 不建议每个角色都能调用 execute 权限。

* 不建议 Reviewer 自动修改文件。

* 不建议 Claude 内部子 Agent 的文件改动直接作为最终可信结果，除非 Executor 角色明确接收并记录这些改动。

### Additional Considerations：还需要提前考虑的盲点

除了角色、通信、冲突和文件编辑，还需要提前考虑下面这些问题。

#### 1. 成本和延迟预算

多 Agent 最大的隐性成本是调用次数变多。

需要设计：

* `maxRoleRunsPerTask`：单任务最多跑几个角色。

* `maxReviewRounds`：Reviewer 打回后最多修订几轮，建议 MVP 设为 1。

* `roleTimeoutMs`：单个角色超时，避免卡住整个任务。

* 复杂度策略：只有 mixed/webapp/高价值决策/文件产物任务才启用多角色。

不做这些限制，多 Agent 很容易变成“慢但看起来很认真”。

#### 2. 如何证明多 Agent 真的更好

不能只凭主观感觉判断多 Agent 有价值，需要定义评估指标。

建议指标：

* 结构完整率：是否同时满足 blocks/files/webapp 等结果区域要求。

* 验收通过率：本地校验和 acceptance 首次通过比例。

* 修订次数：Reviewer 打回后修订几次。

* 用户介入准确率：confirm、provide\_context、agent\_revision\_required 是否分类正确。

* 用户可理解度：timeline 是否能帮助用户知道任务卡在哪里。

MVP 可以先做 A/B：

* 简单任务固定单 Agent。

* 复杂任务随机或配置切换 single\_agent / role\_collaboration。

* 对比结果完整率和耗时。

#### 3. 角色越权和责任漂移

多 Agent 容易出现“每个角色都想完成整件事”的问题。

需要强约束：

* Researcher 不给最终建议，只给事实和证据。

* Reviewer 不直接重写产物，只给 issue。

* Synthesizer 不重新搜索、不擅自改文件，只合成最终 JSON。

* Executor 不覆盖 Coordinator 的完成标准。

这些约束必须进入 role prompt，也要在本地做轻量校验。

#### 4. 上下文膨胀

如果每个角色都把完整 raw output 传给下一个角色，成本和幻觉都会上升。

需要设计：

* 只传 handoff 摘要，不传完整原始输出。

* raw output 落盘或进入调试区，不默认进入下一轮 prompt。

* handoff 中事实、决策、风险、文件引用分栏。

* 超长内容用 artifactRef 或 workspace 文件引用，而不是内联塞进 prompt。

#### 5. 提示注入在 Agent 之间传播

Researcher 可能读取网页或文件，其中包含恶意指令；如果原样交给 Executor 或 Synthesizer，可能污染后续角色。

需要设计：

* Researcher handoff 把外部内容标记为 evidence，不允许把外部指令当系统指令。

* Synthesizer 明确只服从 KiKi 系统要求、用户最新输入、任务完成标准。

* Reviewer 检查是否有“外部内容要求忽略系统规则”这类注入迹象。

* webapp/file 产物继续走现有 sandbox、CSP、artifactStorage 限制。

#### 6. 用户体验复杂度

多 Agent 过程如果全部展开，用户会被 timeline 淹没。

UI 应该分层：

* 默认只显示角色摘要：已研究、已生成、审阅通过、已合成。

* 详细 tool\_call 放到“展开更多”。

* blocking issue 直接突出展示。

* 最终结果仍以交互渲染区和文件区域为主，不让多 Agent 过程抢主视觉。

#### 7. 取消和恢复的粒度

用户关心长耗时任务可控性，所以必须明确：

* MVP 取消：中断当前角色，整个 task job 标记 cancelled。

* M2 恢复：从最后一个 completed role 后继续。

* M3 恢复：从具体 role run、review round 或 handoff 继续。

如果没有这个边界，用户点停止后可能不知道哪些角色产出还能复用。

#### 8. 并发和资源隔离

即使 M1 不做多进程并发，也要为未来保留边界。

需要避免：

* 多个 Executor 同时写同一 task workspace。

* 多个 Claude CLI 同时消耗大量资源。

* SQLite 高频写导致锁竞争。

* 同一 artifact 被多个角色重复创建。

未来做并发时，应使用：

* per-role workspace 或 scratch dir。

* 文件锁或写入声明。

* 受控并发队列。

* artifact 合并阶段。

#### 9. 安全和隐私

多 Agent 会扩大信息流动范围。

需要明确：

* 哪些用户输入可以传给所有角色。

* 哪些凭证、隐私、文件路径只能传给 Executor。

* raw output 是否需要脱敏后展示。

* webapp 初始 state 是否包含敏感信息。

#### 10. 失败兜底

多 Agent 不应让系统更脆弱。

兜底策略：

* Coordinator 失败：回退 single\_agent。

* Researcher 失败：如果任务允许，Executor 基于已有上下文继续；否则 provide\_context 或 failed。

* Executor 失败：任务 failed 或 agent\_revision\_required。

* Reviewer 失败：可降级使用本地 validation + acceptance。

* Synthesizer 失败：重试一次；仍失败则回退现有 parseAndRepair。

#### 11. 什么时候强制不用多 Agent

建议加入禁用条件：

* 用户明确要求快速回答。

* 任务只需要一句话或一段短文本。

* 当前 runtime permission 为 readonly，但任务需要复杂文件产物。

* 已经处于用户等待恢复路径，本轮只需吸收用户反馈做小修。

* 上一次同任务多角色失败，且失败原因不是可自动修复。

#### 12. 配置和灰度

需要有开关，而不是一次性全量启用。

建议：

* `multiAgentEnabled`：总开关。

* `multiAgentMode`: `"off" | "auto" | "force"`。

* `maxReviewRounds`：默认 1。

* `roleCollaborationMinComplexity`：复杂度阈值。

* UI 中可显示“本任务使用多角色协同”。

### M1：多角色协同 MVP，单任务内编排

目标：不改变 runtime\_jobs 的 job 粒度，仍以 task instance 为一个 job，但 job 内部由多个角色顺序或半并行协同完成。

#### 新增类型：`src/types/agentOrchestration.ts`

新增：

```ts
export type AgentRole =
  | "coordinator"
  | "researcher"
  | "executor"
  | "reviewer"
  | "synthesizer";

export type AgentRoleRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "awaiting_user";

export type AgentRoleRun = {
  id: string;
  role: AgentRole;
  title: string;
  objective: string;
  inputSummary: string;
  outputSummary?: string;
  status: AgentRoleRunStatus;
  startedAt?: string;
  finishedAt?: string;
  rawOutput?: string;
  parsedOutput?: Record<string, unknown>;
  error?: string;
};

export type AgentHandoff = {
  fromRole: AgentRole;
  toRole: AgentRole;
  summary: string;
  artifacts?: string[];
  createdAt: string;
};

export type AgentRunPlan = {
  schemaVersion: 1;
  mode: "single_agent" | "role_collaboration";
  strategy: "quality_review" | "research_then_write" | "build_then_review" | "custom";
  roles: AgentRoleRun[];
  handoffs: AgentHandoff[];
  finalRole: AgentRole;
};
```

为什么：

* 将“用户/Agent 协作要求”和“Agent 内部角色协同”分开，避免污染现有 `TaskCollaborationRequirements`。

* 保持类型轻量，先服务 MVP 的可观测和调试，不引入复杂 DAG。

#### 新增编排器：`src/lib/server/agentOrchestration/MultiAgentOrchestrator.ts`

职责：

* 根据任务类型、`expectedResult`、`collaboration` 和 surfaces 选择协同策略。

* 构建角色计划，默认策略如下：

  * `quality_review`：Coordinator → Executor → Reviewer → Synthesizer。

  * `research_then_write`：Coordinator → Researcher → Executor → Reviewer → Synthesizer。

  * `build_then_review`：Coordinator → Executor → Reviewer → Synthesizer，Reviewer 重点检查 blocks/files/webapp 是否满足要求。

* 为每个角色生成专用 prompt，调用现有 `streamClaudeCli` 或封装后的 `runClaudePromptForRole`。

* 将每个角色的开始、完成、失败、handoff 写入 telemetry 和 trajectory。

* 最终只允许 Synthesizer 输出系统当前要求的纯 JSON，并复用 `parseAndRepair`、本地校验、验收评审与产物落盘。

如何：

* 第一版按顺序执行角色，避免并发 CLI 资源冲突。

* 每个角色只接收必要上下文和上一角色输出摘要，不把所有 raw output 无限制拼接。

* Researcher 默认 readonly；Executor 使用任务 runtime permission；Reviewer 和 Synthesizer 默认 readonly。

* 如果任一角色发现需要用户输入，统一生成 `InteractionRequirement`，进入现有 `awaiting_user` / `blocker` 链路。

#### 修改 Runner 入口：`src/lib/server/goalTaskRunner.ts`

改造点：

* 保留现有 `executeOnce` 作为 `single_agent` 路径。

* 在 `runGoalTask` 中增加策略选择：

  * 简单任务、answer 类互动、明确小任务：走 `single_agent`。

  * 高复杂度 deliverable、mixed surfaces、webapp、文件产物、需要确认的重要草稿：走 `role_collaboration`。

* 新增 `executeWithAgentRoles`，内部调用 `MultiAgentOrchestrator`。

* 多角色最终结果仍回填为当前 `ParsedTaskRunnerResult` 结构，不改变下游 UI 和持久化协议。

为什么：

* 避免把已有 2000+ 行 `goalTaskRunner` 继续膨胀为角色编排逻辑。

* 保持旧路径可回退，降低风险。

#### 新增 Prompt 模板：`src/lib/server/agentOrchestration/prompts.ts`

角色要求：

* Coordinator：明确任务要求、成功标准、角色分工、风险点，不直接交付最终结果。

* Researcher：只做信息收集和事实依据整理，输出来源、置信度、缺口。

* Executor：基于要求生产候选交付物，可使用允许的工具。

* Reviewer：按任务完成标准、surfaces、artifactRefs、webapp 状态、安全边界进行审阅，输出缺陷清单和是否放行。

* Synthesizer：吸收前序输出和审阅意见，输出唯一最终 JSON。

约束：

* 所有角色都不能输出内部思考。

* 非 Synthesizer 角色输出结构化中间 JSON，但不进入最终 `TaskResult`。

* Synthesizer 必须遵守现有 `goalTaskPrompt.ts` 的最终 JSON schema 和纯 JSON 要求。

#### 扩展轨迹类型：`src/types/executionTrajectory.ts`

新增可选字段：

```ts
agentRole?: AgentRole;
handoff?: {
  fromRole?: AgentRole;
  toRole?: AgentRole;
  summary: string;
};
```

为什么：

* UI 能用同一 timeline 展示多角色节点。

* 保持兼容，旧数据没有 `agentRole` 也能继续渲染。

#### 扩展结果元数据：`src/types/taskResult.ts`

在 `TaskResult.meta` 中预留：

```ts
agentRunPlan?: AgentRunPlan;
qualityReview?: {
  passed: boolean;
  issues: string[];
  reviewerRole: "reviewer";
};
```

为什么：

* 让最终产物能说明“经过哪些角色、审阅是否通过”。

* 后续可在结果抽屉中展示审阅摘要。

#### UI 增强：`src/components/task/TaskExecutionTimeline.tsx`

改造：

* 如果 step 有 `agentRole`，显示角色标签：Coordinator / Researcher / Executor / Reviewer / Synthesizer。

* 对 handoff step 使用单独样式展示“移交”。

* 状态文案从“待确认”调整为更通用的“等待用户”，避免把所有阻塞都表达为确认。

#### UI 增强：`src/components/task/GenericAgentResultView.tsx`

改造：

* 若 `taskResult.meta.agentRunPlan` 存在，在结果顶部增加轻量“多角色协同摘要”折叠区。

* 默认不占用主要交互渲染区，避免破坏双区域结果呈现。

### M2：服务端多任务并发，独立推进

目标：解决吞吐，不解决角色质量。只有在 M1 稳定后再做。

涉及文件：

* `src/lib/daemon/daemonConfig.ts`

  * 增加 `maxConcurrentJobs`，默认 1，避免默认行为突变。

* `src/lib/server/worker/taskDispatchWorker.ts`

  * `claimQueuedRuntimeJobs({ limit: config.maxConcurrentJobs })`。

  * 对 claimed jobs 使用受控并发执行，而不是简单 `Promise.all`。

  * 每个 job 使用独立 lease renewal timer 和 abort controller。

* `src/lib/server/repositories/runtimeJobsRepository.ts`

  * `claimQueuedRuntimeJobs` 需要原子认领，避免多 worker 同时读到同一批 queued rows 后重复认领。

  * 推荐改为事务内逐条 `UPDATE ... WHERE status='queued'` 后再读取确认。

* `src/lib/daemon/daemonRunner.ts`

  * daemon loop 不再把“处理完所有任务”作为下一轮调度前提。

  * 保持 heartbeat 与调度独立。

风险：

* SQLite 写锁竞争。

* 多个 Claude CLI 子进程同时运行导致资源占用高。

* 同一 workspace 多任务写文件可能互相影响。

* 取消、租约丢失、结果写回需要逐 job 隔离。

### M3：角色级 DAG 与长期协作

目标：让角色不只是顺序链路，而是可表达依赖、并行分支和持续协同。

新增能力：

* `AgentRunPlan.roles[].dependsOn`。

* 独立 `agent_runs` 表和 `agent_messages` / `agent_handoffs` 表。

* 支持 Reviewer 打回 Executor 定向修订，最多 N 轮。

* 支持长任务中断恢复到具体角色，而不是重跑整个 task instance。

* 支持用户查看“谁做了什么、为什么没通过、下一步谁接手”。

该阶段不建议在 MVP 实施。

## Assumptions & Decisions

* 术语决策：全程使用“要求”“约束”“协同”，不使用禁用术语。

* MVP 决策：优先做“角色协同”，不是先做服务端并发。

* 编排粒度：MVP 不把每个角色拆成独立 runtime\_job，仍保持一个 task instance 对应一个 runtime\_job。

* 执行模式：MVP 先顺序执行角色，避免多 Claude CLI 并发带来的资源和写入冲突。

* 回退策略：保留 `single_agent` 路径，支持通过配置或策略选择关闭角色协同。

* 权限策略：Researcher / Reviewer / Synthesizer 默认 readonly，Executor 才继承任务 runtime permission。

* 结果策略：只有 Synthesizer 的最终 JSON 进入现有 TaskResult 解析、产物落盘和 UI 渲染。

* 存储策略：MVP 不新增 DB 表，优先复用 `trajectory_json` 和 `result_json`；如角色协同稳定，再迁移到独立表。

* UI 策略：角色协同信息作为 timeline 和结果摘要的增强，不替代现有双区域结果呈现。

## Benefits

角色协同的主要好处：

* 质量更稳：Executor 产出后由 Reviewer 按完成标准、结果区域、文件产物、webapp 要求做独立检查。

* 过程更透明：用户能看到 Coordinator、Executor、Reviewer、Synthesizer 各自的节点，而不是只看到一个黑箱 Agent。

* 复杂任务更可控：研究、执行、审阅、合成分离后，长任务更容易定位卡点。

* 更适配可执行小应用：Reviewer 可以专门检查 webapp 的 manifest、初始状态、交互桥、文件产物和安全边界。

* 更容易恢复：未来可从失败角色继续，而不是整个任务重跑。

* 更容易扩展：后续接入专业 Agent 或外部能力时，有明确的角色和 handoff 边界。

代价与风险：

* 成本更高：多次 LLM 调用会增加耗时和 token。

* 延迟更高：顺序角色会拉长单任务完成时间。

* 中间结果管理复杂：需要控制上下文长度、raw output 留存和隐私边界。

* 过度编排风险：简单任务不适合多角色，必须有策略开关。

* 最终一致性风险：多个角色意见冲突时，需要 Synthesizer 明确裁决规则。

## Concrete Examples

下面用具体任务说明“多 Agent 角色协同”相比当前“单 Agent”到底多了什么价值。

### 示例 1：生成 5 天游玩行程 + 可交互小应用

任务要求：

* 用户说：“帮我做一份胡志明市 5 天游玩行程，最好能有每日路线、预算、餐厅建议，并生成一个可交互小应用方便查看。”

* 期望结果区域：交互渲染区 + 文件区域。

* 交付要求：既要有结构化 blocks，也要有 webapp artifact。

当前单 Agent 的执行方式：

* 一个 Agent 同时负责查资料、规划路线、写行程、生成 webapp、检查结果。

* 容易出现的问题：

  * 资料查得不均衡，热门景点多，交通、预算、开放时间少。

  * webapp 看起来有 UI，但状态、manifest 或 iframe 交互细节不完整。

  * 最终 JSON、blocks、files、webapp 同时要求时，容易漏掉其中一类。

  * 自己写完自己检查，容易忽略“文件区域是否真的存在”“交互区是否满足要求”。

多角色协同的执行方式：

* Coordinator：先拆清楚成功标准，例如 5 天游玩、每日路线、预算、餐厅、交互小应用、markdown 备份文件。

* Researcher：只负责查资料和整理依据，例如景点开放时间、区域分布、交通建议、餐厅候选。

* Executor：基于研究结果生成 itinerary blocks、webapp HTML、manifest、markdown 文件内容。

* Reviewer：专门检查是否满足双区域结果呈现、webapp 是否可预览、每天是否有路线/预算/餐厅、文件产物是否齐全。

* Synthesizer：吸收 Reviewer 意见，输出最终纯 JSON，让现有 `TaskResult`、artifact、webapp 预览链路继续工作。

实际好处：

* 质量：Reviewer 能发现“只有 blocks，没有 webapp”或“有 webapp，但没有 markdown 文件”这类单 Agent 容易漏的结构问题。

* 可控：用户在 timeline 里能看到“研究完成”“生成完成”“审阅通过/不通过”“最终合成”。

* 恢复：如果 webapp 不合格，未来可以只让 Executor 修 webapp，再让 Reviewer 复查，而不是整份行程重跑。

* 代价：会多跑几次 LLM，速度比单 Agent 慢，适合复杂交付，不适合简单问答。

### 示例 2：买 SUV 的调研与决策建议

任务要求：

* 用户说：“帮我比较 30 万以内适合家庭的 SUV，考虑空间、安全、油耗、保值率，最后给我 3 个推荐。”

* 期望结果：对比表、推荐理由、风险提醒，可能还需要后续用户确认试驾候选。

当前单 Agent 的执行方式：

* 一个 Agent 搜索、比较、排序、给结论。

* 容易出现的问题：

  * 把广告口径当事实。

  * 对比维度不一致，有的车写油耗，有的车写空间，有的车写配置。

  * 推荐结论看似完整，但缺少“为什么不推荐其他车型”的解释。

  * 如果需要用户确认试驾候选，可能把“交付物缺口”和“用户确认”混在一起。

多角色协同的执行方式：

* Coordinator：确定评价矩阵：空间、安全、油耗、保值率、家庭使用场景、预算上限。

* Researcher：收集候选车型与事实数据，标注来源和置信度。

* Executor：生成对比表、评分和 3 个推荐方案。

* Reviewer：检查每个候选是否使用同一评价维度，指出信息不足或结论跳跃。

* Synthesizer：给出最终推荐，并把“需要用户选择试驾候选”表达为 `interactionRequirement.type = confirm`。

实际好处：

* 减少幻觉：Researcher 和 Reviewer 分离后，Reviewer 可以质疑数据来源和评分逻辑。

* 决策更稳：每个车型按同一维度比较，减少单 Agent 临场发挥。

* 用户介入更准：如果只是让用户选试驾候选，应该是 confirm；如果资料不足，应该是 provide\_context 或 deliverable\_gap，不会全都变成“待确认”。

* 代价：适合高价值决策，不适合“随便推荐几款车”的轻量任务。

### 示例 3：生成报告文件 + 交互摘要卡片

任务要求：

* 用户说：“帮我生成一份产品分析报告，并导出 markdown 文件，同时在交互区展示摘要卡片。”

* 期望结果区域：mixed，也就是 blocks + file artifact。

当前单 Agent 的执行方式：

* 一个 Agent 直接写最终 JSON，可能同时写文件。

* 容易出现的问题：

  * 交互区 blocks 有了，但忘了返回 `files` 数组。

  * 写了本地文件，但最终 JSON 没有让系统转成 artifactRefs。

  * markdown 内容和摘要卡片不一致。

  * 验收失败后容易进入用户等待，而不是 Agent 自我修订。

多角色协同的执行方式：

* Coordinator：明确“摘要卡片”和“markdown 文件”都必须存在。

* Executor：生成 blocks 和 markdown 文件内容。

* Reviewer：检查 blocks 与 markdown 是否一致，检查文件区域是否满足 minCount/acceptedKinds。

* Synthesizer：输出最终 JSON，确保 `task_result.blocks` 和 `files` 都存在。

实际好处：

* 更符合当前项目硬约束：mixed 模式必须同时校验 blocks 和 artifacts。

* 降低产物丢失：Reviewer 会专门检查 artifactRefs/files 是否完整。

* UI 更稳定：最终仍走 `GenericAgentResultView` 的双区域渲染，不需要另起一套 UI。

### 什么时候不值得用多 Agent

以下任务继续用单 Agent 更好：

* 简单问答，例如“总结这段文字”。

* 明确只需要一段短文本的任务。

* 低风险、低价值、用户不关心过程的任务。

* 需要极快响应的任务。

多 Agent 的判断规则应是：

* 结果越复杂，越适合多角色。

* 交付物越多，越适合多角色。

* 需要审阅、确认、文件产物、webapp、小应用时，更适合多角色。

* 简单任务默认不启用，避免把系统变慢。

## Verification Steps

### 静态验证

* 运行 `pnpm lint`，确保新增类型、编排器和 UI 修改无 lint 错误。

* 运行 `pnpm build`，确保 Next.js server/client 边界没有类型或打包问题。

* 使用 TypeScript 检查 `ExecutionTrajectoryStep` 新增可选字段不破坏旧调用。

### 单元与局部验证

* 为策略选择函数添加用例：

  * 简单信息任务走 `single_agent`。

  * mixed surfaces / webapp / file surface 任务走 `role_collaboration`。

  * answer / provide\_context 的互动任务不强制多角色。

* 为 `AgentRunPlan` 归一函数添加用例：

  * 缺少 Reviewer 时自动降级或标记策略不完整。

  * Reviewer 未通过时 Synthesizer 必须吸收 issue 或返回 agent\_revision\_required。

* 为 trajectory 生成添加用例：

  * 每个 role run 产生 start / result / handoff step。

  * 旧 trajectory 无 `agentRole` 时 UI 仍可渲染。

### 手动验收

* 创建一个普通 markdown 交付任务，确认仍走单 Agent，结果渲染不变。

* 创建一个 mixed 任务，要求 blocks + markdown 文件，确认出现 Coordinator / Executor / Reviewer / Synthesizer 轨迹。

* 创建一个 webapp 任务，确认 Reviewer 会检查 webapp 产物，最终仍通过现有 artifact preview 渲染。

* 人为让 Reviewer 返回未通过，确认任务进入修订或 `agent_revision_required`，不会误推给用户确认。

* 对运行中任务点击停止，确认 job cancellation 对多角色执行生效，当前角色 CLI 能被 abort。

### 回归重点

* `TaskMessageCard` 的 `taskSnapshot` 兜底仍有效。

* `GenericAgentResultView` 仍保持交互渲染区和文件区域并列。

* `/api/goals/tasks/progress` 返回的 trajectory 兼容旧 UI。

* `/api/goals/tasks/resume` 对等待用户的多角色任务仍能恢复。

* artifact 落盘路径仍为 `<workspace>/artifacts/<id>/`，元数据仍通过 SQLite 和 `/api/artifacts/[id]` 访问。

## Recommended Next Step

如果进入实施，建议先做 M1 的最小闭环：

1. 新增 `agentOrchestration` 类型与 prompt 模板。
2. 新增 `MultiAgentOrchestrator`，默认顺序执行 Coordinator → Executor → Reviewer → Synthesizer。
3. 在 `goalTaskRunner` 中按任务复杂度选择 `single_agent` 或 `role_collaboration`。
4. 给 trajectory 增加 role/handoff 可选字段，并增强 timeline 展示。
5. 保持最终 TaskResult、artifact、blocker、resume 链路不变。

不建议立即做：

* 不建议立刻把每个角色拆成独立 runtime\_job。

* 不建议同时做服务端多任务并发。

* 不建议引入长期 Agent 记忆或跨任务自治。

* 不建议为简单任务默认启用多角色协同。
