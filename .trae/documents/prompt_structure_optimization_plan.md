# 当前 Prompt 结构优化分析与方案

## Summary

* 目标：参考用户提供的 5 段 Prompt structure 模板，分析当前项目中的 prompt 是否存在优化空间，并给出可执行的优化方案。

* 范围：本计划聚焦 prompt 结构与内容组织，不直接改业务逻辑。

* 结论：当前 prompt 的约束覆盖很强，尤其是 JSON 输出、交付物验收、用户介入判断、多 Agent 禁止过程污染结果等规则都比较完整；主要优化空间不在“缺少规则”，而在“结构一致性、动态上下文隔离、重复约束收敛、示例缺失、关键指令复述位置”。

## Current State Analysis

### 1. 当前主要 Prompt 入口

* `src/lib/server/goalTaskPrompt.ts`

  * 核心函数：`buildGoalTaskRunnerPrompt`

  * 用途：后台任务执行 Agent 的主 prompt，负责产出最终 KiKi 任务 JSON。

  * 当前结构：

    * 角色定位和任务目标。

    * 执行前提自检。

    * 输出硬性格式。

    * 动态任务上下文。

    * 交付物要求、机器可读要求、协作要求。

    * 恢复执行上下文。

    * 执行约束。

    * 产物片段规则。

    * 验收规则。

    * 输出模板 A / B。

* `src/lib/server/agentOrchestration/prompts.ts`

  * 核心函数：`buildRolePrompt`

  * 用途：Coordinator / Researcher / Executor / Reviewer / Synthesizer 多角色 prompt。

  * 当前结构：

    * 先拼任务上下文。

    * 再根据角色拼角色职责、前序移交、前序输出、严格要求、输出 JSON 字段。

    * Synthesizer 复用 `buildGoalTaskRunnerPrompt`，再追加多角色上下文和额外要求。

* `src/lib/server/goalPlanning.ts`

  * 核心函数：`buildDecomposePrompt`、`buildTaskGenerationPrompt`、`buildTaskReviewPrompt` 等。

  * 用途：目标澄清、拆解、任务生成、任务评审、展示摘要。

  * 当前结构差异较大：

    * `buildDecomposePrompt` 已接近标准结构：`# Role`、`# Context`、`# Instructions`、`# Goal Information`、`# Output Format`。

    * `buildTaskGenerationPrompt` 结构相对扁平：先给动态输入，再给要求、规则和 JSON schema。

* `src/lib/server/goalTaskAcceptancePrompt.ts`

  * 核心函数：`buildLocalValidationRepairPrompt`、`buildAcceptanceJudgePrompt`、`buildSemanticRepairPrompt`

  * 用途：本地校验修复、验收判断、语义修复。

  * 当前结构：

    * 角色与目标清晰。

    * 动态输入和要求混合度中等。

    * 输出 schema 明确。

### 2. 对照模板的差距

* 模板结构：

  * 1-2 句建立角色和高层任务描述。

  * Dynamic / retrieved content。

  * Detailed task instructions。

  * Examples / n-shot。

  * Repeat critical instructions。

* 当前优点：

  * 角色和任务目标基本清晰。

  * 动态内容覆盖充分，尤其任务、交付物、协作、恢复上下文、前序轨迹都已注入。

  * 详细任务规则很完整。

  * JSON schema 明确，降低输出格式漂移。

  * 多处重复“只输出 JSON、不要代码块”，能减少格式错误。

* 当前问题：

  * 结构不统一：规划 prompt 有 `# Role/# Context/# Instructions`，执行 prompt 使用中文段落标题，多 Agent prompt 更扁平。

  * 动态内容位置分散：任务上下文、交付物要求、恢复上下文、webapp 上下文、前序轨迹穿插在规则中，模型不容易区分“事实输入”和“行为指令”。

  * 规则过长且层级混合：`buildGoalTaskRunnerPrompt` 同时承担前提判断、执行约束、交付物区域规则、用户交互规则、输出模板、验收规则，模型可能优先记住后面的 schema 而弱化前面的决策规则。

  * 示例不足：很多高风险场景只有文字规则，没有 few-shot 示例，例如信息类任务不等待用户、mixed 模式必须 blocks + files、等待用户时 options 必须是答案不是动作。

  * 关键指令重复但不成体系：`只输出 JSON` 在多处出现是必要的，但类似“不要把过程写入 task\_result.blocks”“information 类型不要 awaiting\_user=true”等关键规则更适合作为末尾复述清单。

  * 多 Agent 命名仍有历史痕迹：UI 已采用 Presenter，但 prompt 内部仍使用 Synthesizer 文案；如果只是内部类型兼容可接受，但面向模型的角色命名会影响轨迹和输出一致性。

  * 工具过程信息的 prompt 结构尚未对齐 UI：当前执行链路 UI 希望展示 thought / tool input / tool output，但主执行 prompt 对“工具调用如何摘要、输入输出如何留在轨迹而非结果区”没有明确结构化要求。

## Proposed Changes

### 1. 引入统一 Prompt 骨架

* 建议新建轻量 prompt 结构规范，不一定立即抽成代码模板，但所有核心 prompt 逐步按同一顺序组织：

  * `# Role`

  * `# Task`

  * `# Dynamic Context`

  * `# Instructions`

  * `# Output Format`

  * `# Examples`

  * `# Critical Reminders`

* 适用文件：

  * `src/lib/server/goalTaskPrompt.ts`

  * `src/lib/server/agentOrchestration/prompts.ts`

  * `src/lib/server/goalPlanning.ts`

  * `src/lib/server/goalTaskAcceptancePrompt.ts`

* 目的：

  * 让模型先建立身份和任务，再读取动态事实，最后执行规则和输出格式。

  * 降低 prompt 维护成本，后续新增规则能放在固定位置。

### 2. 优先优化主执行 Prompt

* 文件：`src/lib/server/goalTaskPrompt.ts`

* 函数：`buildGoalTaskRunnerPrompt`

* 建议结构：

  * `# Role`

    * 你是 KiKi 后台任务执行 Agent。

    * 你的目标是交付满足任务要求的可验收产物，而不是总结过程。

  * `# Dynamic Context`

    * 目标、子目标、任务、依赖任务。

    * 交付物要求。

    * 机器可读要求。

    * 协作要求。

    * 恢复上下文。

    * webapp 交互上下文。

  * `# Instructions`

    * 执行前提自检。

    * 正常执行规则。

    * 用户输入缺失规则。

    * information 类型任务完成规则。

    * expectedSurfaces 规则。

    * 禁止过程污染结果区规则。

  * `# Output Format`

    * 输出模板 A。

    * 输出模板 B。

  * `# Examples`

    * mixed 模式通过示例：同时有 blocks 和 files。

    * 等待用户示例：options 是具体答案，不是“补充信息”动作。

    * information 类型完成示例：awaiting\_user=false，反馈放 suggested\_actions。

  * `# Critical Reminders`

    * 只能输出 JSON。

    * 不要代码块。

    * 不要在 task\_result.blocks 写工具过程、Agent 过程、审阅过程。

    * deliverable\_check 必须和实际交付一致。

    * information 类型已满足完成标准时不能等待用户确认。

* 优化收益：

  * 保留现有强约束，但减少“规则散落”的认知负担。

  * 对最近多 Agent UI 的过程展示更友好：过程进入轨迹，产物进入结果区。

### 3. 多 Agent Prompt 命名和结构对齐

* 文件：`src/lib/server/agentOrchestration/prompts.ts`

* 函数：`buildRolePrompt`

* 建议优化：

  * 保留内部 `synthesizer` 类型兼容，但 prompt 面向模型的角色文案改为 `Presenter`。

  * 每个角色 prompt 使用统一骨架：

    * `# Role`

    * `# Dynamic Context`

    * `# Role-Specific Instructions`

    * `# Output Format`

    * `# Critical Reminders`

  * Coordinator / Researcher / Executor / Reviewer 的 JSON schema 建议单独列成完整示例，而不是只写“字段为 xxx”。

  * Reviewer 加一个 n-shot 迷你示例：

    * `passed=false` 时 issues 应包含 expected / actual / suggestedFix。

    * mixed 模式缺 files 时必须 blocking。

  * Presenter 段落强调：

    * 前序角色输出只是素材。

    * 最终结果不展示协同过程。

    * 过程信息只进入 execution trajectory / agentRunPlan。

* 优化收益：

  * 降低角色输出漂移。

  * 与已经确定的 UI 术语 `Presenter` 一致。

### 4. 规划 Prompt 分层补齐

* 文件：`src/lib/server/goalPlanning.ts`

* 建议优化对象：

  * `buildTaskGenerationPrompt`

  * `buildGoalFollowUpQuestionsPrompt`

  * `buildCollectedInfoSummaryPrompt`

  * `buildTaskReviewPrompt`

* 建议做法：

  * `buildDecomposePrompt` 已较接近模板，可作为其他规划 prompt 的结构参考。

  * `buildTaskGenerationPrompt` 应把动态输入从规则中拆出来：

    * `# Dynamic Context` 放子目标、目标、用户背景、成功标准。

    * `# Instructions` 放任务生成原则、协作模式规则、信息类任务规则。

    * `# Output Format` 放 JSON schema。

    * `# Critical Reminders` 重复最关键的 3-5 条。

  * 加 1 个信息类任务 few-shot 示例：

    * 对比/调研/攻略类任务默认 `agent_autonomous`。

    * completion 不依赖用户“确认满意”。

    * expected\_output 要包含结构化 blocks。

* 优化收益：

  * 减少任务生成阶段把信息类任务误判为等待用户确认的概率。

  * 保持此前已修复的任务分类规则稳定。

### 5. 验收与修复 Prompt 增加“保留/改动边界”

* 文件：`src/lib/server/goalTaskAcceptancePrompt.ts`

* 建议优化：

  * 在 `buildLocalValidationRepairPrompt` 和 `buildSemanticRepairPrompt` 中增加固定段落：

    * `# Keep`

    * `# Fix`

    * `# Do Not Change`

  * 对 repair 场景特别强调：

    * 保留已通过内容。

    * 只修 failedCriteria。

    * 不允许无关重写。

    * 不允许把 summary/final\_message 当作结果区域。

  * 在 `buildAcceptanceJudgePrompt` 末尾复述 critical reminders：

    * 缺结果区域不能 pass。

    * 缺用户信息判 needs\_user，不要求 Agent 猜。

    * 所有失败项要一次性列出。

* 优化收益：

  * 减少修复时“重跑一遍”或破坏已通过内容。

  * 更符合当前反馈重跑逻辑：修订必须创建新实例，保留原结果。

### 6. 补充工具轨迹相关 Prompt 约束

* 背景：当前 UI 已确定执行过程展示为 Step、多轮 thought/tool use，且工具胶囊会展示工具名、输入、折叠输出。

* 建议在执行和多 Agent prompt 中增加约束：

  * 工具调用过程不要写入 `task_result.blocks`。

  * 工具输入输出由 execution trajectory 记录。

  * 面向用户的结果只保留结论，不展开工具原始输出。

  * 如果需要总结工具结果，只写结论摘要，不重复工具名和参数。

* 适用文件：

  * `src/lib/server/goalTaskPrompt.ts`

  * `src/lib/server/agentOrchestration/prompts.ts`

* 优化收益：

  * 避免 UI 里出现工具名、动作和参数重复。

  * 让 prompt 与已确定的执行链路 UI 数据模型对齐。

## Assumptions & Decisions

* 不建议一次性重写所有 prompt，以免引入行为回归。

* 推荐分阶段推进：

  * 第一阶段：只重构结构，不改语义规则。

  * 第二阶段：补 few-shot 示例。

  * 第三阶段：引入共享 prompt section helper，减少重复维护。

* 当前最值得优先优化的是 `buildGoalTaskRunnerPrompt` 和 `buildRolePrompt`：

  * 前者决定最终任务是否完成、是否等待用户、产物区域是否正确。

  * 后者决定多 Agent 过程是否干净、Presenter 是否与 UI 命名一致。

* `只输出 JSON` 这类硬约束可以继续重复，但要集中在 `Output Format` 和 `Critical Reminders`，避免散落在多个段落导致维护困难。

* 示例要少而准，不建议塞大量 few-shot；每类高风险场景 1 个最小示例即可。

## Suggested Rollout

* M1：文案结构重排，不改变规则含义。

  * `goalTaskPrompt.ts` 重排为 5 段模板结构。

  * `agentOrchestration/prompts.ts` 重排角色 prompt，并把模型可见角色名从 Synthesizer 改为 Presenter。

* M2：增加 3 个关键 few-shot。

  * mixed blocks + files 成功示例。

  * awaiting\_user=true 的 3 个具体答案 options 示例。

  * information 类任务完成后不等待用户确认示例。

* M3：规划 prompt 对齐。

  * `buildTaskGenerationPrompt` 按模板重排。

  * 补信息类任务默认自主完成的示例。

* M4：验收修复 prompt 增强。

  * 加 `Keep/Fix/Do Not Change` 边界段。

  * 强化 failedCriteria 一次性列出。

## Verification Steps

* 静态验证：

  * 检查所有 prompt 函数仍返回字符串。

  * TypeScript 编译通过。

* 行为验证：

  * 信息调研任务：产出报告后 `awaiting_user=false`。

  * mixed 任务：最终结果同时包含 blocks 和 files。

  * 用户输入缺失任务：一次性列出所有缺失项，options 为 3 个具体答案。

  * 多 Agent 任务：Presenter 最终结果不包含角色过程，过程只在执行链路中展示。

  * 修复任务：保留已通过内容，只补缺失区域。

* 回归验证：

  * 使用现有 mock goal 和多 Agent mock case。

  * 如有可复现历史案例，重点验证“越南旅游城市对比”“TOEFL 听力分析 mixed 产物”两类场景。

