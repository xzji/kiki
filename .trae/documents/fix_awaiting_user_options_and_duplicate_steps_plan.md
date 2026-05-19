# 等待用户确认选项与重复步骤问题修复计划

## Summary

本计划针对当前任务暴露出的两个问题制定完整修复方案：

1. 用户询问“越南 5 日游城市组合”时，后端 `interactionRequirement.options` 已返回越南城市组合，但前端卡片展示了 `上海/广州/北京出发`。
2. 缺少城市信息后，执行轨迹中出现 step9/step10/step11 多段相似内容，且这次运行还出现了两个 `开始第 1 次执行`，造成“执行多次才推卡片”的观感。

目标是让等待用户确认卡片稳定展示正确候选项、避免错误候选项覆盖、减少重复过程噪音，并避免 lease 过期造成同一任务误判为增量续跑。

## Current State Analysis

### 真实运行产物

- `data/workspaces/conversations/conv-new-1779009317391/tasks/goal-1779012464490-_5_-goal-_5_-sg-1-task-2/goal-1779012464490-_5_-goal-_5_-sg-1-task-2-05-19-run-1779121019653-6fxdmu/progress.json`
- `interactionRequirement.options` 是正确的越南组合：
  - `河内+下龙湾（北部经典线，世界遗产）`
  - `岘港+会安（中部风情线，古城海滩）`
  - `胡志明市+美奈（南部都市线，海滨度假）`
- 同一结果中的 `structuredOutput.taskReadiness.missingUserInfo[0].options` 是错误的中国出发城市：
  - `上海出发（航班多）`
  - `广州出发（华南方便）`
  - `北京出发（北方方便）`

### 前端展示路径

- 文件：`src/components/task/AwaitingUserResumePanel.tsx`
- 当前逻辑：
  - `missingItems.length > 0` 时，主 `options` 直接返回空数组。
  - UI 只渲染 `optionsForMissingItem(item)`。
  - `optionsForMissingItem` 只读取 `item.options`。
- 结果：只要存在 `taskReadiness.missingUserInfo`，正确的 `interactionRequirement.options` 就不会被展示。
- 定性：这不是普通兜底逻辑，而是“结构化缺失字段优先渲染逻辑”。它的设计目的应是支持多个缺失字段分别展示不同候选项；但当前在单缺失字段场景下没有处理 `interactionRequirement.options` 与 `item.options` 的冲突，导致更准确的全局候选项被错误覆盖。

### 后端候选项合并路径

- 文件：`src/lib/server/goalTaskRunner.ts`
- `coerceMissingUserContextBlocker` 会在识别缺少用户信息时，把 `taskReadiness` 写入 `structuredOutput`。
- `buildReadinessFromUserBlockers` 会把 `deliverableCheck.missingDeliverables` 转为 `missingUserInfo`。
- `generateOptionsForReadinessItems` / `applyGeneratedOptionsToReadiness` 会把候选项写入 `TaskReadinessInfoItem.options`。
- 当前缺少候选项一致性校验：即使 `interactionRequirement.options` 已经存在且更准确，错误的 `taskReadiness.options` 仍可能被前端优先展示。

### 重复步骤观感

- 文件：`src/lib/server/goalTaskRunner.ts`
- `streamClaudeCli` 的 delta 输出会通过 `flushAssistantProcessOutput` 写入多条 `Agent 过程输出（非最终结果）`。
- 当 Agent 输出较长 JSON 时，会被拆成多个过程 step，看起来像 step9/step10/step11 重复执行。
- 实际等待卡片在最终解析、校验、构造 blocker 后才产生；过程 step 不是确认卡片推送前的多次执行。

### lease 重入问题

- 文件：`src/lib/server/repositories/runtimeJobsRepository.ts`
- `releaseExpiredRuntimeJobLeases` 会把过期的 `running` job 改回 `queued`。
- 文件：`src/lib/server/worker/taskDispatchWorker.ts`
- worker 再次领取同一 job 时，把已有 `job.trajectory` 传给 `runGoalTask` 的 `initialTrajectory`。
- 文件：`src/lib/server/goalTaskRunner.ts`
- `executeOnce` 只要 `initialTrajectory.length > 0` 就进入 `isResumeRun`，即使没有用户反馈，也会产生“恢复执行模式（增量续跑）”和第二个 `开始第 1 次执行`。

## Proposed Changes

### 1. 修复确认卡片候选项优先级

文件：`src/components/task/AwaitingUserResumePanel.tsx`

改动：

- 新增一个候选项解析函数，用于 missing item 场景：
  - 优先使用与当前问题更一致的 `requirement.options`。
  - 当 `missingItems.length === 1` 且 `requirement.options` 非空时，默认展示 `requirement.options`。
  - 仅当 `requirement.options` 为空时，才回退到 `item.options`。
- 对 `requirement.options` 做动作类选项过滤保护：
  - 如果候选项主要是 `确认继续`、`需要修改`、`重新执行任务`、`调整任务完成标准` 等确认/修订动作，不把它当作 missing item 的字段候选项。
  - 这类动作仍走无 missing item 的全局交互按钮/选项逻辑。
- 保持多 missing item 场景仍按 `item.options` 展示，避免把同一组选项错误复制给多个字段。
- 提交时仍保留当前格式：`item.label：option`，这样恢复执行链路不需要改 API。

为什么：

- 本次问题的根因是 `interactionRequirement.options` 正确但被 `taskReadiness.options` 覆盖。
- 前端应把“结构化缺失字段渲染”与“全局交互问题候选项”做冲突处理，而不是在存在 missing item 时无条件丢弃 `interactionRequirement.options`。
- 这能立即阻断错误展示，即使后端候选项生成偶发误判，也不会再把明显冲突的 readiness options 展示给用户。

边界：

- 如果单 missing item 没有 `requirement.options`，仍展示后端生成的 `item.options`。
- 如果单 missing item 的 `requirement.options` 是确认/修订动作，而不是字段答案，仍回退到 `item.options` 或自定义输入。
- 如果用户手动输入，仍提交自定义文本。
- 已落盘的旧数据即使 `taskReadiness.options` 仍是错误候选项，前端也能通过 `requirement.options` 优先策略展示正确候选项。

### 2. 后端合并时把 seed options 写入 readiness，避免错误候选覆盖

文件：`src/lib/server/goalTaskRunner.ts`

改动：

- 在 `coerceMissingUserContextBlocker` 中，当 `rawOptions` 非空、且构建出的 `readiness` 只有一个 `missingUserInfo` 时，将 `rawOptions` 注入该 missing item：
  - `items[].options = rawOptions`
  - `missingUserInfo[].options = rawOptions`
  - `optionQuestion = interactionRequirement.question`
- 对已有 `structuredOutput.taskReadiness` 也执行同样的归一化，而不是仅对 fallback readiness 生效。
- 保留 `suggestedActions = uniqueStrings([...options, ...result.suggestedActions]).slice(0, 5)`。
- 新增 typed guard / normalizer 处理 `result.structuredOutput?.taskReadiness`：
  - 只有确认其满足 `TaskReadinessCheck` 基本结构后才做 options 注入。
  - 不直接修改 unknown 对象，统一返回新对象，避免运行时类型不稳。
- 注入时只使用 `interactionRequirement.options`，不使用 `suggestedActions` 中的 `都不是，我自己描述`。

为什么：

- `interactionRequirement` 是 Agent 明确面向用户的问题与候选项，语义上比从 `missingDeliverables` 推断出的 readiness item 更贴近用户输入。
- 让后端持久化结果本身一致，前端、API、调试产物看到的 options 都一致。

边界：

- 多 missing item 不自动注入全局 `rawOptions`，避免把同一组选项复制到多个字段。
- `rawOptions` 仍使用现有 `normalizeConfirmationOptionLabels` 限制数量和长度。
- `都不是，我自己描述` 保持由 UI 自定义输入入口提供，不进入后端结构化候选项。

### 3. 增加候选项一致性保护，降低“出发城市/目的地城市”混淆

文件：`src/lib/server/goalTaskRunner.ts`

改动：

- 新增轻量函数判断 `generatedOptions` 是否与 `seedOptions` 冲突：
  - 如果 `seedOptions` 非空且 missing item 数量为 1，优先使用 seed options。
  - 如果 generated options 包含 `出发`，但 question / reason / label 包含 `游览|目的地|城市组合|选定城市`，并且 seed options 非空，则丢弃 generated options。
- 在 `applyGeneratedOptionsToReadiness` 或调用前应用该规则。

为什么：

- 本次错误正是“用户选定城市列表”被生成成“出发城市”。
- 该规则不是硬编码越南，而是针对“出发城市”和“目的地/游览城市”的语义错配。

边界：

- 如果任务本身问的是 `出发城市`，不会丢弃 `上海出发/广州出发/北京出发`。
- 如果没有 seed options，仍允许候选项生成器提供候选，但前端仍有自定义输入兜底。

### 4. 减少流式 JSON 过程输出造成的重复 step

文件：`src/lib/server/goalTaskRunner.ts`

改动：

- 在 `flushAssistantProcessOutput` 前增加判断：
  - 仅当 pending 内容高度疑似最终协议 JSON 时，才抑制或合并过程 step。
  - 不使用“包含某个 key 就过滤”的宽松规则，避免误伤正常自然语言解释。
  - 建议判定条件：
    - trim 后以 `{` 开头，或内容中 JSON key 密度较高。
    - 同时命中至少 2 个协议字段，例如 `"summary"`、`"final_message"`、`"interaction_requirement"`、`"task_result"`、`"deliverable_check"`、`"structured_output"`。
    - 或者可被 `extractJsonObject` 提取出对象，且对象包含上述协议字段。
  - 最终 `Agent 已返回最终消息` 仍保留，便于调试。
- 或者将这类片段合并为一条简短 step：`Agent 正在整理最终结果`，不展示 JSON 内容。

为什么：

- step9/10/11 不是实际多次执行，而是长 JSON 被拆成多段过程输出。
- 对用户而言这些片段没有可读价值，还会造成误解。

边界：

- 普通自然语言过程输出仍保留。
- tool call 轨迹不受影响。
- 如果 Agent 在自然语言中提到 `summary` 等普通词，不应被过滤，必须满足“协议 JSON 片段”判定。

### 5. 避免 lease 过期重入造成假“恢复执行”

文件：`src/lib/server/worker/taskDispatchWorker.ts`

改动：

- 调用 `runGoalTask` 时，只有存在 `job.payload.resumeContext` 才传入 `initialTrajectory`。
- 对因 lease 过期重新领取的同一 job：
  - `resumeContext` 为空时，不把旧 `job.trajectory` 作为 `initialTrajectory` 传入执行器。
  - 旧 trajectory 仍可用于最终写回合并，但不驱动 `isResumeRun`。
- 明确 resume 链路：
  - `src/app/api/goals/tasks/resume/route.ts` 在用户提交补充信息后，会把 `resumeContext` 写回 job payload，并保留 `trajectory`。
  - 只有这种“用户补充触发恢复”的场景，才应把 `job.trajectory` 传给 `initialTrajectory`。
- 明确 feedback 重跑链路：
  - `src/app/api/goals/tasks/feedback/route.ts` 会创建新的修订实例并写入 `resumeContext`，通常没有旧 trajectory。
  - 该场景可继续作为带上下文的重跑，不应被 lease 重入修复影响。

建议实现：

```ts
const shouldResumeWithTrajectory = Boolean(job.payload.resumeContext);
await runGoalTask({
  ...
  resumeContext: job.payload.resumeContext,
  initialTrajectory: shouldResumeWithTrajectory ? job.trajectory : undefined,
  signal: abortController.signal,
});
```

为什么：

- 当前 `executeOnce` 将 `initialTrajectory.length > 0` 等价于恢复执行。
- lease 过期重入不是用户反馈恢复，不应触发“增量续跑模式”。

边界：

- 真正由用户补充信息触发的恢复执行仍保留历史轨迹。
- runtime job 最终写回时仍会合并 `job.trajectory` 与最新 `resultPayload.trajectory`，不丢历史。
- lease 过期重入不会再仅因为旧 `trajectory` 存在而显示 `进入恢复执行模式（增量续跑）`。
- 用户通过 `resume/route.ts` 提交补充信息后，仍应显示恢复执行模式并携带历史上下文。

### 6. 加强 lease 领取安全性

文件：`src/lib/server/repositories/runtimeJobsRepository.ts`

改动：

- `claimQueuedRuntimeJobs` 更新 job 时增加状态条件：

```sql
WHERE id = ?
  AND status = 'queued'
```

- 更新后检查 `changes > 0`，只有成功 claim 的 row 才返回。

为什么：

- 当前先 SELECT 再 UPDATE，UPDATE 没有 `status='queued'` 条件。
- 多 worker 或快速轮询时，存在并发领取同一 job 的风险。

边界：

- 单 worker 行为不变。
- 并发 worker 下避免重复启动同一 job。

## Assumptions & Decisions

- 本次修复范围包含：
  - 选项错乱根因修复。
  - 等待用户卡片展示兜底。
  - 过程 step 噪音治理。
  - lease 重入导致的假恢复治理。
- 不改任务规划提示词本身，优先修复运行时数据合并和展示链路。
- 不硬编码越南城市，使用通用规则处理“目的地城市”和“出发城市”的语义错配。
- 保持现有 `resumeTaskRun` API 和提交字段格式不变，降低改动面。
- UI 样式不作为本次重点，不额外调整视觉样式。
- 计划兼容历史落盘数据：旧的 `taskReadiness.options` 即使错误，也应通过前端优先级和后端后续归一化逐步修正展示。
- JSON 过程输出降噪只处理最终协议 JSON 片段，不过滤普通自然语言过程说明。

## Verification Steps

### 静态检查

- 运行 TypeScript/ESLint 检查：

```bash
pnpm lint
```

- 当前 `package.json` 没有 `typecheck` script，因此不使用 `pnpm typecheck` 作为验收命令。
- 使用 Next 构建作为类型和构建层验证：

```bash
pnpm build
```

### 单元/脚本验证

- 为 `goalTaskRunner` 中新增的候选项合并/过滤函数补充轻量单元测试或脚本验证：
  - 单 missing item + `interactionRequirement.options` 为越南组合 + generated options 为中国出发城市 → 最终 readiness options 使用越南组合。
  - 多 missing item + 全局 options → 不复制到每个 missing item。
  - 真实出发城市问题 → 保留 `上海出发/广州出发/北京出发`。
  - 单 missing item + `requirement.options` 为 `确认继续/需要修改` → 不把动作类选项注入字段候选项。
  - `suggestedActions` 包含 `都不是，我自己描述` → 不进入后端 `readiness.options`。

### 手动复现验证

- 使用相同越南 5 日游任务复现：
  - 卡片标题仍是“请问您计划游览越南哪些城市？”
  - 候选项显示越南城市组合。
  - 不显示 `上海出发/广州出发/北京出发`。
  - 选择一个越南组合后，提交内容格式为 `用户选定的城市列表：河内+下龙湾...`，任务可以继续执行。
- 使用旧落盘数据打开同一任务：
  - 即使 `structuredOutput.taskReadiness.missingUserInfo[0].options` 仍是中国出发城市，卡片也优先展示 `interactionRequirement.options` 中的越南组合。
- 使用真实出发城市缺失任务复现：
  - 当问题确实询问出发城市时，仍可以展示 `上海出发/广州出发/北京出发` 等出发地候选。

### 轨迹验证

- 观察执行轨迹：
  - 长 JSON 不再被拆成 step9/step10/step11 多条无意义过程输出。
  - 最终仍有一条 `Agent 已返回最终消息` 或 `approval` step。
  - 普通 tool call 仍正常展示。
  - 普通自然语言过程输出仍可展示，不因包含 `summary` 等普通词被误过滤。

### lease 验证

- 人为让任务执行超过 2 分钟或模拟 lease 过期：
  - 不应因为旧 trajectory 存在而显示“进入恢复执行模式（增量续跑）”。
  - 不应出现两个 `开始第 1 次执行`。
  - 真正用户补充信息后的恢复执行仍应携带历史轨迹和 resume context。
- 通过 `resume/route.ts` 提交等待用户卡片：
  - job payload 应包含 `resumeContext`。
  - 再次执行时允许传入 `initialTrajectory`。
  - `resume_mode_started` 日志应只在该类用户恢复场景出现。
- 通过 `feedback/route.ts` 触发修订重跑：
  - 新实例应正常带 `revisionContext` 执行。
  - 不应因本次 lease 修复而丢失反馈上下文。

## Rollout Notes

- 建议按顺序实施：
  1. 前端候选项优先级兜底。
  2. 后端 readiness options 归一化。
  3. 候选项一致性保护。
  4. 过程 step 降噪。
  5. lease 重入与并发 claim 修复。
- 前两项是解决错误选项的核心路径，优先级最高。
- 后三项解决用户对“执行多次”的感知和潜在运行时稳定性问题。
- 实施前可先用旧 `progress.json` 做只读对照，确保旧数据兼容策略覆盖当前线上已产生的错误结果。
