# 待确认信息与最终产出物边界修复计划

## Summary

当前问题不是“为什么会先生成候选内容”，而是系统没有区分：

- **候选产出**：用于让用户确认、选择或审核的中间结果。
- **最终产出物**：用户确认后，Agent 已完成后续执行并满足验收标准的结果。
- **等待用户信息**：阻塞执行所必需的用户输入。

截图里的“越南主要旅游城市对比分析报告”属于 `after_agent_output` 协作节点的候选内容：它本身不依赖用户确认信息，可以先由 Agent 调研生成；用户确认的是后续要深入的城市组合。真正不合理的是该候选内容被放进了右侧的“产出物”区域，看起来像最终结果，同时确认后恢复执行期间，旧候选结果仍被写回 running 进度并继续显示为产出物。

目标：建立清晰的状态边界，保证“待确认时不展示最终产出物；确认后继续执行期间不展示旧候选产物；只有任务真正完成后才显示产出物”。

## Current State Analysis

### 1. Prompt 允许 after_agent_output 先产出候选

文件：[goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts)

相关逻辑：

- `buildStepZeroPrompt()` 明确规定：
  - `before_execution` 缺必要信息时不能执行。
  - `during_execution / after_agent_output` 时，Agent 应先产出候选方案、对比或候选集，再通过 `interaction_requirement` 说明需要用户确认。

结论：

- 对“城市调研与对比”这种任务，先生成候选报告是符合当前设计的。
- 这类候选报告不是最终结果，而是“供确认的草稿/候选内容”。

### 2. 后端解析层把 interaction_requirement 推导成 awaiting_user，但保留 done 结果

文件：[goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts)

相关逻辑：

- `parseTaskRunnerResult()` 中：
  - 即使 Agent 输出 `awaiting_user: false`，只要存在 `interaction_requirement.type !== "none"`，系统就会推导 `awaitingUser = true`。
  - 但同时会保留 Agent 输出的 `task_result`，包括 `status: "done"`。

本次数据证据：

- 运行目录：
  - `data/workspaces/conversations/conv-new-1779009317391/tasks/goal-1779012464490-_5_-goal-_5_-sg-1-task-1/...`
- `trajectory.json` 中 Agent 输出包含：
  - `awaiting_user:false`
  - `interaction_requirement.type:"confirm"`
  - `interaction_requirement.timing:"after_agent_output"`
  - `task_result.status:"done"`
- 系统随后追加了 `approval/awaiting_user` 轨迹。

结论：

- 后端状态已进入 awaiting_user，但 `taskResult.status` 仍是 done。
- 这导致前端无法判断它是“候选草稿”还是“最终产出物”。

### 3. 前端产出物显示条件只看是否有 blocks，不看任务是否等待确认

文件：[ExecutionResultBody.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/ExecutionResultBody.tsx)

相关逻辑：

- `hasGenericDeliverableContent()` 只判断 `taskResult.blocks` 或 `artifactRefs` 是否存在。
- `shouldDeferConcreteResultUntilUserInput()` 对 `confirm + after_agent_output` 明确返回 `false`。
- 因此等待确认期间，右侧仍会显示“产出物”。

问题：

- `confirm + after_agent_output` 确实需要展示候选内容给用户看。
- 但不应该以“产出物”标题展示，更不应该和最终结果共用同一语义。

### 4. 恢复接口在确认后把旧候选结果继续写回 running 进度

文件：[route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/tasks/resume/route.ts)

相关逻辑：

- 非 `complete_on_approve` 分支中，确认后会构造：
  - `status: "running"`
  - `awaitingUser: false`
  - `taskResult: buildSubmittedTaskResult(basePayload.taskResult, ...)`
- `buildSubmittedTaskResult()` 会把旧候选 `taskResult.blocks` 保留下来，并插入“提交状态”块。

结果：

- 用户点击“确认并继续”后，Agent 还在继续执行，但右侧已经展示旧候选报告。
- 这会让用户误以为“最终产出物已经生成”，和 running 状态冲突。

### 5. 通知文案把待确认候选误称为任务已完成

数据证据：

- `result.json/progress.json` 中 notification 包含：
  - `reason: "任务已完成，建议你确认结果后继续推进。"`
  - `snippet: "[需要确认] 任务已完成，建议你确认结果后继续推进。"`

问题：

- 对 `after_agent_output` 的确认节点，语义应是“候选结果已生成，等待确认后继续”，而不是“任务已完成”。

## Proposed Changes

### 1. 后端规范 awaiting_user + after_agent_output 的 taskResult 状态

文件：[goalTaskRunner.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskRunner.ts)

做法：

- 新增 `normalizePendingConfirmationResult(result)` 或类似函数。
- 当满足以下条件时：
  - `result.awaitingUser === true`
  - `result.interactionRequirement.type === "confirm"`
  - `result.interactionRequirement.timing === "after_agent_output"`
  - `result.taskResult` 存在
- 将 `taskResult.status` 从 `done` 规范为 `pending_user`。
- 在 `taskResult.meta` 中增加轻量标记：
  - `pendingConfirmation: true`
  - `candidateResult: true`
- 不删除 blocks，因为用户需要看到候选内容来确认。

为什么：

- 后端数据层先把语义纠正，避免 UI 只能靠状态猜测。
- `pending_user` 与现有 `TaskResultStatus` 类型兼容。

### 2. 前端把待确认候选显示为“待确认草稿”，不显示为“产出物”

文件：[ExecutionResultBody.tsx](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/components/task/ExecutionResultBody.tsx)

做法：

- 调整 `shouldDeferConcreteResultUntilUserInput()`：
  - 不再简单对 `confirm + after_agent_output` 返回 `false`。
  - 改为判断它是否为候选确认状态。
- 新增候选结果渲染分支：
  - 当 `instance.awaitingUser` 存在，且 `interactionRequirement.timing === "after_agent_output"`，且有 `taskResult.blocks`：
    - 用标题 `待确认草稿` 或 `候选结果`
    - 在草稿区域内渲染 `GenericAgentResultView`
    - 下方显示 `AwaitingUserResumePanel`
- 最终“产出物”区域只在以下条件显示：
  - `instance.status === "completed"`，或
  - `taskResult.status === "done"` 且没有 `instance.awaitingUser`

为什么：

- 用户仍能阅读候选报告并完成确认。
- 视觉上不再误导为最终产出物。

### 3. 确认后 running 阶段不把旧候选结果作为 taskResult 写回

文件：[route.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/app/api/goals/tasks/resume/route.ts)

做法：

- 在非 `complete_on_approve` 分支中，确认后进入 running 时：
  - 不再把 `buildSubmittedTaskResult(basePayload.taskResult, ...)` 写入 `resultPayload.taskResult` 作为当前产出物。
  - 改为：
    - `taskResult: undefined` 或保留原值到 `structuredOutput.previousCandidateResult`
    - `interactionSubmission` 继续保留
    - `structuredOutput.interactionSubmission` 继续保留
    - `structuredOutput.previousCandidateResult` 保存旧候选，供 resume prompt 或调试使用，但前端不当作产出物渲染。
- 如需展示用户提交状态，前端使用现有 `SubmittedInteractionPanel`，不通过伪造 `taskResult` 展示。

为什么：

- running 期间不应该出现最终产出物。
- 旧候选可以作为上下文留给后端，但不进入前端最终产物通道。

兼容注意：

- `complete_on_approve` 分支可以保留现状，因为该分支语义是“用户确认即可完成”，无需再跑 Agent。
- 非 `complete_on_approve` 才需要隐藏旧候选。

### 4. Store 同步时避免旧 taskResult 残留

文件：[goalStore.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/stores/goalStore.ts)

做法：

- 当前 `syncTaskInstanceRun()` 使用：
  - `taskResult: taskResult ?? instance.result?.taskResult`
- 这会导致后端 running 进度不带 `taskResult` 时，前端仍保留旧候选结果。
- 调整为：
  - 如果 `progress.status === "running"` 且 `progress.resultPayload?.awaitingUser !== true` 且 `interactionSubmission` 存在，则允许清空旧的 pending_user/candidate taskResult。
  - 或更稳妥地引入 `resultPayload.clearTaskResult === true`，由 resume route 明确告诉前端清空旧产物。
- 推荐使用显式字段 `clearTaskResult`，避免误清除其他运行态展示。

为什么：

- 仅修改后端不够，前端 store 的 fallback 会把旧结果“续命”回来。

### 5. 通知文案区分“任务完成”和“候选待确认”

文件：[resultNotificationJudge.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/resultNotificationJudge.ts)

做法：

- 增加对 `result.awaitingUser && interactionRequirement.timing === "after_agent_output"` 的分支。
- 文案从：
  - `任务已完成，建议你确认结果后继续推进。`
- 改为：
  - `候选结果已生成，等待你确认后继续推进。`
  - `任务「X」需要你确认候选结果或选择下一步。`

为什么：

- 避免任务卡片、通知摘要把候选状态误称为完成。

### 6. Prompt 层补充状态规范，减少 Agent 输出 done + waiting 的矛盾

文件：[goalTaskPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/goalTaskPrompt.ts)

做法：

- 在输出格式说明中增加：
  - 如果设置了 `interaction_requirement.type != "none"` 且需要用户确认后才能继续，则 `task_result.status` 必须是 `pending_user`，不能是 `done`。
  - `done` 仅用于无需用户参与或用户参与已完成后的最终结果。

为什么：

- 从源头减少矛盾状态，但不能只依赖 prompt，仍需要后端规范化兜底。

## Assumptions & Decisions

- `after_agent_output` 允许生成候选内容，因为这类候选内容通常不依赖用户确认的信息。
- “等待确认”的候选内容可以展示，但不能叫“产出物”，不能被视为最终交付。
- 只有 `instance.status === "completed"` 或无 awaiting_user 且 `taskResult.status === "done"` 时，才进入最终产出物区域。
- `complete_on_approve` 语义保持不变：如果用户确认本身就是完成条件，则确认后可以直接完成。
- 非 `complete_on_approve` 的恢复执行期间，不展示旧候选为产出物。
- 不引入数据库迁移；新增字段放在现有 JSON `meta/structuredOutput/resultPayload` 中，保持兼容。

## Verification Steps

1. 复现 `after_agent_output` 任务：
   - 生成一个需要“先给候选、再让用户确认”的任务。
   - 确认右侧不再出现“产出物”标题。
   - 确认候选内容显示在“待确认草稿/候选结果”区域。

2. 验证等待确认状态：
   - 任务卡显示“需要确认”。
   - 详情区显示确认面板。
   - `taskResult.status` 应为 `pending_user`。
   - 通知文案不再说“任务已完成”。

3. 验证确认后继续执行：
   - 点击“确认并继续”。
   - 任务进入 `in_progress/running`。
   - 右侧不显示旧候选报告为“产出物”。
   - 可以看到已提交信息和执行链路。

4. 验证最终完成：
   - Agent 继续执行并返回最终结果。
   - 只有此时右侧显示“产出物”。
   - `taskResult.status` 为 `done`。

5. 回归 `before_execution` 缺信息：
   - 缺用户前置信息时不生成候选方案。
   - 只显示补充信息面板。
   - 不显示“产出物”。

6. 回归 `complete_on_approve`：
   - 用户确认即可完成的任务，确认后仍能直接 completed。
   - 不误触发 running 阶段隐藏逻辑。

7. 静态检查：
   - 对修改文件运行 VS Code diagnostics。
   - 如项目已有可用脚本，再运行相关 typecheck/lint。
