# Project Prompts Inventory

本文档按“基本信息 / 原始 Prompt”整理当前项目中会发送给 Claude CLI / 模型的 prompt。除基本定位信息外，不对原始 prompt 做二次解释、摘要或改写。

> 范围说明：本文只收录实际进入模型调用链的 prompt 或 prompt fragment；普通 UI 文案、`window.prompt()` 这类浏览器输入提示不计入模型 prompt。

> 说明：信息收集是否继续由本地轮数规则判断；如果还需要继续收集，下一轮补充问题由“目标补充问题 Prompt”结合目标和历史问答生成。

## 1. Claude 会话包装 Prompt

### 基本信息
- 名称：`会话包装 Prompt`
- 入口：`buildPrompt`
- 调用方：`streamClaudeCli`
- 源文件：`src/lib/server/claudeCli.ts`
- 源码范围：`L75-L89`

### 原始 Prompt
```ts
function buildPrompt(
  message: string,
  quotedMessage?: ClaudeStreamOptions["quotedMessage"],
) {
  const parts: string[] = [];
  if (quotedMessage) {
    parts.push(
      `以下是当前用户引用的上下文，请优先参考：`,
      `[${quotedMessage.roleLabel}] ${quotedMessage.content}`,
      "",
    );
  }
  parts.push(`当前用户消息：`, message);
  return parts.join("\n");
}
```

## 2. 目标澄清 Prompt

### 基本信息
- 名称：`目标澄清 Prompt`
- 入口：`buildGoalClarificationPrompt`
- 调用方：`generateGoalClarificationQuestionsWithClaude`
- 源文件：`src/lib/server/goalPlanning.ts`
- 源码范围：`L206-L226`

### 原始 Prompt
```ts
function buildGoalClarificationPrompt(goalText: string, conversationContext?: string) {
  return `你是 KiKi 的目标澄清助手。用户刚发起一个长期目标，请先判断为了生成可靠规划，最需要补充哪些背景信息。

用户目标：
${goalText}

${conversationContext ? `会话上下文：\n${conversationContext}\n` : ""}
要求：
1. 只能输出严格 JSON，不要包含 Markdown、代码块或额外解释。
2. 生成 1-3 个澄清问题，问题必须具体、自然、便于用户一次性回答。
3. 优先询问：成功标准、当前基础/资源、截止时间/频率、重要约束。
4. 如果目标已经非常明确，也至少问 1 个确认关键约束的问题。

JSON schema：
{
  "questions": [
    "你希望这个目标最终达到什么可衡量的结果？",
    "你目前的基础和每周可投入时间大概是多少？"
  ]
}`;
}
```

## 3. 目标补充问题 Prompt

### 基本信息
- 名称：`目标补充问题 Prompt`
- 入口：`buildGoalFollowUpQuestionsPrompt`
- 调用方：`generateGoalFollowUpQuestionsWithClaude`
- 源文件：`src/lib/server/goalPlanning.ts`
- 源码范围：`L228-L262`

### 原始 Prompt
```ts
function buildGoalFollowUpQuestionsPrompt(input: {
  goalText: string;
  conversationContext?: string;
  history: GoalInfoCollectionHistoryItem[];
  answeredRounds: number;
  minRounds: number;
  maxRounds: number;
}) {
  return `你是 KiKi 的目标信息收集助手。系统已通过代码规则决定：当前还需要继续收集一轮信息。你的唯一任务是结合目标和已收集信息，提出下一轮最有价值的补充问题。

目标：
${input.goalText}

已完成回答轮数：${input.answeredRounds}
最小信息收集轮数：${input.minRounds}
最大信息收集轮数：${input.maxRounds}

历史问答：
${JSON.stringify(input.history, null, 2)}

${input.conversationContext ? `会话上下文：\n${input.conversationContext}\n` : ""}
要求：
1. 只能输出严格 JSON，不要包含 Markdown、代码块或额外解释。
2. 只生成下一轮 1-3 个补充问题，不要判断是否可以进入规划。
3. 问题必须基于“目标 + 历史问答”中仍缺失或不清楚的信息，避免重复询问已经回答过的内容。
4. 优先补齐：成功标准、时间线、资源/投入、关键约束、主要风险、用户偏好。
5. 问题必须具体、自然、便于用户一次性回答。

JSON schema：
{
  "questions": [
    "结合已有回答后，下一轮最需要补充的问题"
  ]
}`;
}
```

## 4. 背景摘要 Prompt

### 基本信息
- 名称：`背景摘要 Prompt`
- 入口：`buildCollectedInfoSummaryPrompt`
- 调用方：`summarizeCollectedInfoWithClaude`
- 源文件：`src/lib/server/goalPlanning.ts`
- 源码范围：`L264-L293`

### 原始 Prompt
```ts
function buildCollectedInfoSummaryPrompt(
  goalText: string,
  collectedInfo: string,
  conversationContext?: string,
) {
  return `你正在为一个长程目标系统整理用户背景信息。请把用户补充的内容整理为结构化摘要，便于后续子目标拆解和任务规划。

目标：
${goalText}

用户补充信息：
${collectedInfo}

${conversationContext ? `会话上下文：\n${conversationContext}\n` : ""}
要求：
1. 只能输出严格 JSON，不要包含 Markdown、代码块或额外解释。
2. 尽量提炼为可执行规划所需的关键信息。
3. 如果用户没有提供某部分信息，对应字段可以留空字符串。

JSON schema：
{
  "goalDetails": "更具体的目标描述",
  "timeline": "时间限制、截止时间、频率要求",
  "resources": "可投入时间、预算、工具、人力、基础条件",
  "constraints": "约束、限制、不能接受的条件",
  "challenges": "当前障碍、风险、薄弱点",
  "preferences": "用户偏好、优先级、风格要求",
  "summary": "2-3 句中文摘要"
}`;
}
```

## 5. 子目标拆解 Prompt

### 基本信息
- 名称：`子目标拆解 Prompt`
- 入口：`buildDecomposePrompt`
- 调用方：`decomposeGoalWithClaude`
- 源文件：`src/lib/server/goalPlanning.ts`
- 源码范围：`L295-L372`

### 原始 Prompt
```ts
function buildDecomposePrompt(input: {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  config: EasterEggSettings;
}) {
  return `# Role
你是一位资深目标规划与战略拆解专家，擅长运用 MECE 原则和逆向推演法，将复杂目标拆解为可执行、可度量的子目标。

# Context
## MECE 原则
MECE (Mutually Exclusive, Collectively Exhaustive) 要求：
- 子目标之间相互独立，无重叠
- 所有子目标完全覆盖目标范围，无遗漏

## 逆向推演法
从终态倒推，识别关键里程碑：
1. 定义成功的最终状态
2. 倒推达成终态的前置条件
3. 识别关键依赖和风险点
4. 形成可执行的阶段序列

# Instructions
## 拆解前思考
在拆解前，请先思考：
1. 这个目标的核心意图是什么？
2. 成功达成后的状态是什么样的？
3. 有哪些隐含的假设和前提条件？
4. 可能遇到哪些风险和阻碍？

## 拆解原则
1. 独立性：每个子目标应该可独立交付价值
2. 渐进性：子目标应呈现递进关系，逐步逼近最终目标
3. 可度量性：每个子目标必须有明确的完成标准
4. 依赖明确：清晰标注子目标间的依赖关系
5. 风险可见：识别可能的风险点和应对策略

## 边界处理
- 子目标数量建议 ${input.config.minSubGoals}-${input.config.maxSubGoals} 个，根据目标复杂度调整
- 避免过度拆解导致管理成本过高
- 避免拆解不足导致子目标过于庞大
- 对于模糊目标，优先明确成功标准

# Goal Information
目标: ${input.goalTitle}
描述: ${input.goalDescription}
用户背景信息:
${JSON.stringify(input.userContext, null, 2)}

# Output Format
请严格按照以下 JSON 格式返回，确保所有必填字段完整：
{
  "goalAnalysis": {
    "coreIntent": "核心意图：一句话概括目标的本质",
    "successState": "成功状态：描述达成后的理想状态",
    "assumptions": ["假设1：隐含的前提条件", "假设2：..."]
  },
  "subGoals": [
    {
      "id": 1,
      "name": "子目标名称（简洁有力）",
      "description": "详细描述：包含具体内容和边界",
      "why": "必要性说明：为什么需要这个子目标",
      "priority": "critical|high|medium|low",
      "weight": 0.25,
      "dependencies": [],
      "estimatedDurationMinutes": 480,
      "successCriteria": [
        { "description": "完成标准1", "type": "milestone" },
        { "description": "完成标准2", "type": "deliverable" }
      ]
    }
  ],
  "executionOrder": "执行顺序建议：说明子目标的推荐执行顺序和理由",
  "risks": ["风险点1：可能的问题和应对策略", "风险点2：..."],
  "reasoning": "拆解理由：整体拆解思路和关键考量"
}`;
}
```

## 6. 子目标任务生成 Prompt

### 基本信息
- 名称：`子目标任务生成 Prompt`
- 入口：`buildTaskGenerationPrompt`
- 调用方：`generateTasksForSubGoalWithClaude`
- 源文件：`src/lib/server/goalPlanning.ts`
- 源码范围：`L374-L470`

### 原始 Prompt
```ts
function buildTaskGenerationPrompt(input: {
  goalTitle: string;
  goalDescription: string;
  userContext: Record<string, unknown>;
  subGoalName: string;
  subGoalDescription: string;
  successCriteria: string[];
  config: EasterEggSettings;
}) {
  return `请为以下子目标生成具体的执行任务。

子目标: ${input.subGoalName}
描述: ${input.subGoalDescription}
完成标准:
${input.successCriteria.length > 0 ? input.successCriteria.map((item) => `- ${item}`).join("\n") : "无明确标准"}
所属目标: ${input.goalTitle}
目标补充说明: ${input.goalDescription}
用户背景: ${JSON.stringify(input.userContext, null, 2)}

要求:
1. 每个任务应该是具体可执行的
2. 明确每个任务的预期产出
3. 任务优先级要合理
4. task_type 只能是 repeat(重复任务) | one_shot(一次性任务)
5. execution_mode 只能是 standard(标准) | interactive(需用户交互) | monitoring(持续监控) | event_triggered(事件触发)
6. hierarchy_level 只能是 task | sub_task | action
7. execution_kind 只能是 ${allowedExecutionKinds.join("、")}
8. 覆盖所有关键完成标准，同时避免冗余任务
9. 每个子目标尽量生成 ${input.config.minTasksPerSubGoal}-${input.config.maxTasksPerSubGoal} 个任务，过少会导致执行不可落地，过多会导致管理成本过高
10. 必须明确每个任务的 Agent / 用户职责分工，写入 collaboration
11. 必须明确交付形式：expected_output.presentation、primary_format、exportable_formats、required_blocks 都必须填写
12. 信息类任务（type=information）默认使用 presentation=visual_report、primary_format=structured_blocks、exportable_formats 至少包含 html，避免只交付 markdown 长文
13. 对比/研究/攻略/方案类任务必须优先要求 comparison_table、callout、key_value 等 blocks，形成可视化报告

协作模式规则:
- agent_autonomous: Agent 可自主完成，用户只需知悉结果
- agent_with_user_confirmation: Agent 自主产出，但需要用户确认、采纳或提出修改建议
- agent_user_collaborative: Agent 与用户共同完成，用户作答、选择或补充是任务完成的一部分
- user_primary_agent_assistive: 用户主要完成，Agent 负责建议、提醒、检查和记录

请按 JSON 格式返回：
{
  "sub_goal_analysis": {
    "core_deliverable": "核心交付物描述",
    "work_categories": ["分类1", "分类2"],
    "completion_checklist": ["检查项1", "检查项2"]
  },
  "tasks": [
    {
      "id": "task-1",
      "title": "任务标题",
      "description": "详细描述",
      "task_type": "repeat|one_shot",
      "execution_mode": "standard|interactive|monitoring|event_triggered",
      "execution_kind": "generic_result",
      "recurrence": "重复任务触发时机(仅 repeat/monitoring 需要)",
      "trigger_condition": "触发条件描述(仅 event_triggered 需要)",
      "hierarchy_level": "task|sub_task|action",
      "parent_id": "父任务ID(可选)",
      "priority": "critical|high|medium|low",
      "dependencies": ["依赖任务ID"],
      "expected_output": {
        "type": "information|deliverable|decision|action|confirmation",
        "description": "预期产出描述",
        "format": "json|markdown|table|text|code|other",
        "presentation": "summary_card|visual_report|comparison_table|checklist|timeline|document|dashboard|handoff_package",
        "primary_format": "structured_blocks|json|markdown|html|text|code",
        "exportable_formats": ["html", "markdown"],
        "required_blocks": ["heading", "callout", "comparison_table", "key_value"],
        "completion_criteria": "完成判定标准"
      },
      "collaboration": {
        "mode": "agent_autonomous|agent_with_user_confirmation|agent_user_collaborative|user_primary_agent_assistive",
        "agent_responsibilities": ["Agent 负责准备、分析、生成或提醒的事项"],
        "user_responsibilities": ["用户需要确认、作答、补充或线下完成的事项；如不需要则为空数组"],
        "user_interaction_type": "none|confirm|answer|provide_context|perform_offline_action",
        "user_interaction_timing": "not_required|before_execution|during_execution|after_agent_output|core_task_step",
        "user_facing_action_label": "给用户看的动作文案，例如 查看结果 / 确认结果 / 开始作答 / 补充信息",
        "should_notify_user": true,
        "completion_owner": "agent|user|shared",
        "completion_definition": "这个任务如何才算完成"
      },
      "estimated_duration_minutes": 60
    }
  ],
  "execution_plan": {
    "suggested_order": ["task-1", "task-2"],
    "critical_path": ["task-1"],
    "total_estimated_hours": 8
  },
  "coverage_validation": {
    "is_sufficient": true,
    "explanation": "覆盖度说明",
    "uncovered_risks": ["未覆盖风险1"]
  }
}`;
}
```

## 7. 任务 Review Prompt

### 基本信息
- 名称：`任务 Review Prompt`
- 入口：`buildTaskReviewPrompt`
- 调用方：`reviewTasksWithClaude`
- 源文件：`src/lib/server/goalPlanning.ts`
- 源码范围：`L472-L505`

### 原始 Prompt
```ts
function buildTaskReviewPrompt(input: {
  goalTitle: string;
  subGoalTitle: string;
  goalDescription: string;
  tasksJson: string;
}) {
  return `请 Review 以下任务是否与目标对齐：

目标: ${input.goalTitle}
子目标: ${input.subGoalTitle}
目标描述: ${input.goalDescription}

待 Review 任务:
${input.tasksJson}

请评估每个任务：
1. 与最终目标的对齐程度（critical/high/medium/low）
2. 与子目标的对齐程度（critical/high/medium/low）
3. 是否需要调整或删除

请按 JSON 格式返回：
{
  "reviewResults": [
    {
      "taskId": "task-id",
      "goalContribution": "critical|high|medium|low",
      "subGoalContribution": "critical|high|medium|low",
      "aligned": true,
      "reasoning": "评估理由",
      "suggestions": ["建议1", "建议2"]
    }
  ]
}`;
}
```

## 8. 规划摘要 Prompt

### 基本信息
- 名称：`规划摘要 Prompt`
- 入口：`buildPlanPresentationPrompt`
- 调用方：`buildPlanPresentationWithClaude`
- 源文件：`src/lib/server/goalPlanning.ts`
- 源码范围：`L507-L545`

### 原始 Prompt
```ts
function buildPlanPresentationPrompt(input: {
  goalText: string;
  collectedInfoSummary: CollectedInfoSummaryPayload;
  decomposition: DecompositionPayload;
  taskPlanningSummary: Array<{
    subGoalName: string;
    taskCount: number;
    uncoveredRisks?: string[];
  }>;
}) {
  return `你正在为 KiKi 的目标规划 UI 生成最终展示摘要。请基于已经完成的收集信息、子目标拆解和任务规划结果，输出一份适合前端展示的计划头部信息。

原始目标：
${input.goalText}

信息摘要：
${JSON.stringify(input.collectedInfoSummary, null, 2)}

子目标拆解：
${JSON.stringify(input.decomposition, null, 2)}

任务规划概况：
${JSON.stringify(input.taskPlanningSummary, null, 2)}

要求：
1. 只能输出严格 JSON，不要包含 Markdown、代码块或额外解释。
2. goalTitle 适合在对话卡片和目标页展示，简洁但明确。
3. summary 用 2-3 句概括整体推进思路。
4. deadline 必须是 ISO 字符串；如果无法从信息中可靠判断，使用 ${DEFAULT_DEADLINE}。
5. notificationStrategy 描述后续提醒与推进策略，贴近长期任务系统。

JSON schema：
{
  "goalTitle": "适合展示的目标标题",
  "summary": "2-3 句摘要",
  "deadline": "${DEFAULT_DEADLINE}",
  "notificationStrategy": "后续提醒与推进策略"
}`;
}
```

## 9. JSON 修复 Prompt

### 基本信息
- 名称：`JSON 修复 Prompt`
- 入口：`repairMalformedJsonWithClaude`
- 调用方：`parseClaudeJson`
- 源文件：`src/lib/server/goalPlanning.ts`
- 源码范围：`L755-L779`

### 原始 Prompt
```ts
async function repairMalformedJsonWithClaude(input: {
  runtimeEnv: RuntimeEnvironment;
  malformedJson: string;
  signal?: AbortSignal;
}) {
  const prompt = `你是 JSON 修复助手。请把下面这段不合法或不完整的 JSON 修复为严格合法的 JSON。

要求：
1. 只能输出修复后的严格 JSON。
2. 不要输出 Markdown、解释、代码块或额外说明。
3. 尽量保留原始字段和值语义，不要擅自改写业务含义。

待修复内容：
${input.malformedJson}`;

  const stdout = await runClaudeJson({
    runtimeEnv: input.runtimeEnv,
    prompt,
    signal: input.signal,
    abortMessage: "JSON 修复已中断",
    failureMessage: "Claude CLI JSON 修复失败",
  });

  return stripJsonFences(extractTextFromPayload(stdout));
}
```

## 10. 后台任务执行 Prompt

### 基本信息
- 名称：`后台任务执行 Prompt`
- 入口：`buildGoalTaskRunnerPrompt`
- 调用方：`runGoalTaskRunnerAttempt`
- 源文件：`src/lib/server/goalTaskPrompt.ts`
- 源码范围：`L67-L190`

### 原始 Prompt
```ts
export function buildGoalTaskRunnerPrompt(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  resumeContext?: string;
}) {
  const { goal, subGoal, task, instance, resumeContext } = input;
  return `你是 KiKi 的后台任务执行 Agent。请以“交付物要求”为核心真实推进任务，而不是只给建议或只总结过程。

你的任务不是证明自己做过事情，而是交付与任务要求一致的可验收产物。

目标：${goal.title}
目标摘要：${goal.summary || "无"}
子目标：${subGoal.title}
任务标题：${task.title}
任务描述：${task.description}
任务执行目标：${task.executionObjective || task.description}
建议工作目录：${task.recommendedWorkingDirectory || "使用 Runtime 当前 working directory"}
依赖任务：
${formatTaskDependencies(task, goal)}

交付物要求（必须满足）：
- 预期结果：${task.expectedOutcome}
${formatExpectedResult(task)}

协作要求（必须遵守）：
${formatCollaborationRequirements(task)}

${resumeContext ? `用户恢复上下文（必须纳入本轮执行）：\n${resumeContext}\n` : ""}

执行约束：
1. 优先直接执行、检索、分析、生成结果。
2. 主交付物必须放在 task_result.blocks 中，作为前端可组件化渲染的唯一主产出；不能只返回 artifacts、summary 或 final_message。
3. 必须遵守“主格式/呈现形态/必须包含的 blocks”：信息类任务默认做成 visual_report，用 heading、callout、comparison_table、key_value、list 等 blocks 组织为可视化报告，不能只输出 markdown 长文。
4. 如果可导出格式包含 html，表示该结构化产物必须具备 HTML 渲染/导出的语义；不要直接输出未清洗的 HTML 作为主产物，主产物仍然是 task_result.blocks。
5. summary/final_message 只能概括交付结果，不能替代主交付物。
6. 如果无法满足交付物要求，不要假装完成；必须设置 interaction_requirement.type=agent_revision_required 或 deliverable_gap，并在 deliverable_check.missing_deliverables 中说明缺口。
7. 如果需要用户确认、作答、补充关键上下文或完成线下动作，请根据协作要求设置 interaction_requirement.type，不要把所有场景都写成确认。
8. 如果缺少用户才能提供的关键输入（例如出发城市、账号信息、个人偏好、预算上限、目标选择等），必须立即停止产出最终交付物：
   - awaiting_user 必须为 true。
   - interaction_requirement.type 必须为 provide_context 或 answer，不能写成 confirm。
   - interaction_requirement.question 必须写清楚需要用户补充什么。
   - interaction_requirement.options 必须给出 2-5 个可直接点击的候选项；如果候选项不确定，也要给出“补充具体信息”“补充约束/偏好”等动作型选项。
   - task_result.status 必须为 pending_user 或 blocked，blocks 只呈现“需要补充的信息”和“为什么需要”，不要输出基于猜测的方案。
   - artifacts 必须为空数组，禁止输出参考方案、假设方案、示例方案或看似完成的主交付物。
   - deliverable_check.matched 必须为 false，missing_deliverables 必须包含缺失的用户输入。
9. 禁止猜测或幻想关键事实。可以说明“缺少信息，无法继续”，但不能用默认城市、默认预算、默认偏好代替用户输入。
10. 最终输出必须是一个 JSON 对象，不要加代码块，不要输出额外解释。

${TASK_RESULT_PROMPT_FRAGMENT}

验收规则：
1. 逐条检查“预期结果”和“完成标准”是否被最终产物覆盖。
2. deliverable_check.matched 只有在 task_result.blocks 组件化主产出真实覆盖预期结果且没有关键缺口时才能为 true。
3. 只生成过程描述、泛泛总结、计划、待办列表，不算满足交付物要求。
4. 如果任务产物是表格/代码/文案/方案/摘要/清单，必须把完整内容放入 task_result.blocks；artifacts 只能作为导出镜像，不能作为唯一产出。

返回 JSON 格式：
{
  "summary": "本轮执行结果摘要",
  "final_message": "面向用户的一段自然语言总结",
  "result_view_kind": "generic_result|reading_digest|draft_review|confirm_action|flashcard|listening_qa",
  "awaiting_user": false,
  "awaiting_reason": "如需用户确认则填写原因，否则留空",
  "interaction_requirement": {
    "type": "none|confirm|answer|provide_context|perform_offline_action|deliverable_gap|agent_revision_required",
    "timing": "not_required|before_execution|during_execution|after_agent_output|core_task_step",
    "reason": "为什么需要用户或 Agent 继续处理；无需介入时留空",
    "question": "需要用户确认/作答/补充的问题；无需介入时留空",
    "options": ["可选选项1", "可选选项2"],
    "suggested_actions": ["建议动作1", "建议动作2"],
    "should_notify_user": false
  },
  "suggested_actions": ["用户下一步建议1", "用户下一步建议2"],
  "artifacts": [
    {
      "label": "产物标题",
      "kind": "markdown|text|json|code|link|other",
      "content": "正文内容，若为链接可留空",
      "href": "可选链接"
    }
  ],
  "task_result": {
    "schemaVersion": 1,
    "taskId": "${task.id}",
    "instanceId": "${instance.id}",
    "title": "结构化产物标题",
    "status": "done|draft|pending_user|blocked|failed",
    "blocks": [
      { "kind": "heading", "text": "核心结论", "level": 2 },
      { "kind": "paragraph", "text": "直接可验收的产物正文。" }
    ],
    "meta": {
      "producedAt": "ISO 时间",
      "presentation": "${task.expectedResult?.presentation || (task.expectedResult?.type === "information" ? "visual_report" : "document")}",
      "primaryFormat": "${task.expectedResult?.primaryFormat || "structured_blocks"}",
      "exportableFormats": ${JSON.stringify(task.expectedResult?.exportableFormats || ["markdown"])}
    }
  },
  "deliverable_check": {
    "matched": true,
    "confidence": "high|medium|low",
    "delivered_artifacts": ["已交付的产物名称"],
    "missing_deliverables": [],
    "criteria_results": [
      {
        "criterion": "验收标准",
        "status": "passed|failed|unknown",
        "evidence": "通过或不通过的证据"
      }
    ],
    "gap_reason": "如果 matched=false，说明未满足的核心原因；否则留空"
  },
  "structured_output": {
    "key": "value"
  }
}

当前实例信息：
- instanceId: ${instance.id}
- dateLabel: ${instance.dateLabel}
- instanceIntro: ${instance.intro}`;
}
```

## 11. 结构化产物要求片段

### 基本信息
- 名称：`结构化产物要求片段`
- 入口：`TASK_RESULT_PROMPT_FRAGMENT`
- 调用方：`buildGoalTaskRunnerPrompt`
- 源文件：`src/lib/taskResult/schemaForPrompt.ts`
- 源码范围：`L1-L43`

### 原始 Prompt
```ts
export const TASK_RESULT_PROMPT_FRAGMENT = `
结构化产物要求（必须返回 task_result）：
1. task_result 是本任务的主结果对象，必须直接覆盖“预期结果/核心交付物”。
2. task_result.blocks 只能使用以下 kind：
   - heading：标题，字段 { kind, text, level }
   - paragraph：普通段落，字段 { kind, text }
   - markdown：富文本正文，字段 { kind, content }
   - list：清单，字段 { kind, ordered, items }
   - key_value：属性对，字段 { kind, entries: [{ label, value, emphasis }] }
   - comparison_table：对比表，字段 { kind, columns, rows, highlight }
   - decision：决策点，字段 { kind, question, options, selectedOptionId }
   - callout：提示/风险/结论，字段 { kind, tone, text }
3. 需要对比多个方案时优先用 comparison_table；需要用户选择时用 decision；风险、结论、重要提醒用 callout。
4. 不要发明新的 block kind；不确定的信息形态用 paragraph 或 markdown 兜底。
5. task_result.meta 必须写入 presentation、primaryFormat、exportableFormats；信息类报告优先使用 presentation=visual_report、primaryFormat=structured_blocks、exportableFormats=["html","markdown"]。
6. 所有任务的执行结果都必须以 task_result.blocks 作为可组件化渲染的主产出；只返回 artifact、summary 或 final_message 一律不算完成。
7. artifacts 只能作为导出/下载/兼容镜像，不能作为唯一产出；如果 artifacts 有内容，必须能在 task_result.blocks 中看到同等完整的用户可读产出。

task_result 示例：
{
  "schemaVersion": 1,
  "taskId": "当前任务 ID",
  "instanceId": "当前实例 ID",
  "title": "产物标题",
  "status": "done",
  "blocks": [
    { "kind": "heading", "text": "核心结论", "level": 2 },
    { "kind": "paragraph", "text": "这里写直接可验收的结论。" },
    {
      "kind": "comparison_table",
      "columns": ["方案", "优点", "风险", "建议"],
      "rows": [
        { "方案": "A", "优点": "成本低", "风险": "维护成本高", "建议": { "text": "谨慎", "tone": "warn" } }
      ]
    }
  ],
  "meta": {
    "producedAt": "ISO 时间",
    "presentation": "visual_report",
    "primaryFormat": "structured_blocks",
    "exportableFormats": ["html", "markdown"]
  }
}
`.trim();
```

## 12. 本地校验修复 Prompt

### 基本信息
- 名称：`本地校验修复 Prompt`
- 位置：`src/lib/server/goalTaskAcceptancePrompt.ts`
- 入口：`buildLocalValidationRepairPrompt`
- 用途：本地硬校验失败后，修复 JSON、task_result、blocks、artifact-only 等结构问题。

### 原始 Prompt

```ts
return `你是 KiKi 的任务结果修复 Agent。

本轮不是重新开始做任务，而是根据系统本地校验报告，修复上一轮输出，使其成为可被系统接收、可展示、可判断完成的完整结果。

你必须优先复用上一轮已经产生的有效内容，不要无关重写。

任务信息：
${json(info)}

系统本地校验报告：
${json(input.report)}

上一轮 Claude 原始输出：
${input.rawAgentOutput}

上一轮已解析结果：
${json(input.parsedResult)}

修复目标：
1. 修复所有 critical 和 major 问题。
2. 返回一个完整 JSON 对象，不要只返回修改片段。
3. 主产出必须放在 task_result.blocks。
4. summary 和 final_message 只能做简短说明，不能替代主产出。
5. artifacts 只能作为导出或兼容镜像，不能作为唯一产出。
6. 如果已有 artifacts / final_message / summary 中包含有效内容，必须把它们转换或整理进 task_result.blocks。
7. 如果 repairMode 是 format_repair、structure_repair 或 presentation_repair，不要重新调研，不要新增未经验证的事实。
8. 只有 allowToolCalls=true 时，才可以重新获取资料或重新分析。
9. 如果缺少用户才能提供的信息，不要猜测；必须返回 awaiting_user=true，并设置 interaction_requirement.type 为 provide_context 或 answer。
10. 如果无法修复，不要假装完成；返回 deliverable_check.matched=false，并说明仍缺什么。

问题专项要求：
${issueInstructions.length ? issueInstructions.map((item, index) => `${index + 1}. ${item}`).join("\n") : "1. 按本地校验报告逐项修复。"}

允许的 block 类型：
- heading
- paragraph
- markdown
- list
- key_value
- comparison_table
- decision
- callout

输出要求：
- 只输出完整 JSON
- 不要输出代码块
- 不要输出额外解释`;
```

## 13. 任务验收员 Prompt

### 基本信息
- 名称：`任务验收员 Prompt`
- 位置：`src/lib/server/goalTaskAcceptancePrompt.ts`
- 入口：`buildAcceptanceJudgePrompt`
- 用途：本地硬校验通过后，独立判断任务结果是否达到完成标准。

### 原始 Prompt

```ts
return `你是 KiKi 的任务验收员。你不负责执行任务，不负责补做任务，不允许为了“看起来差不多”而判定通过。

你的唯一职责是：根据任务完成标准，检查当前执行结果是否已经满足要求，并输出结构化验收报告。

验收原则：
1. 以任务完成标准和预期产出为最高优先级，而不是以 summary / final_message 为准。
2. 必须检查 task_result.blocks 是否已经承载主产出。
3. 如果主产出缺失、内容不完整、只给摘要、只给 artifact、缺少 requiredBlocks，都不能判定为完成。
4. 如果问题只涉及呈现方式、结构化不足、某些 blocks 缺失，但核心内容大体已存在，可判定为 needs_repair。
5. 如果缺的是用户才能提供的关键信息，判定为 needs_user，不要要求 Agent 猜测补齐。
6. 你必须明确指出：哪些标准已通过，哪些未通过，证据是什么，下一轮应该保留什么、补什么、不要改什么。
7. 只输出 JSON。

任务信息：
${json(info)}

本地硬校验结果：
${json(input.localValidationReport)}

当前执行结果 JSON：
${json(input.currentResult)}

请输出 JSON：
{
  "verdict": "pass | needs_repair | needs_user | fail",
  "confidence": "high | medium | low",
  "summary": "一句话结论",
  "hardFailures": [],
  "passedCriteria": [
    { "criterion": "xxx", "evidence": "xxx" }
  ],
  "failedCriteria": [
    {
      "criterion": "xxx",
      "evidence": "xxx",
      "severity": "critical | major | minor",
      "repairableByAgent": true,
      "requiresUserInput": false
    }
  ],
  "blockAssessment": {
    "keepBlocks": [],
    "rewriteBlocks": [],
    "missingBlocks": []
  },
  "repairStrategy": {
    "mode": "presentation_only | content_gap | restructure | rerun_with_tools",
    "reuseExistingContent": true,
    "allowNewToolCalls": false
  },
  "repairInstructions": [],
  "userBlockers": []
}`;
```

## 14. 内容补齐 Prompt

### 基本信息
- 名称：`内容补齐 Prompt`
- 位置：`src/lib/server/goalTaskAcceptancePrompt.ts`
- 入口：`buildSemanticRepairPrompt`
- 用途：验收员返回 `needs_repair` 后，指导执行 Agent 定向补齐未通过项。

### 原始 Prompt

```ts
return `你是 KiKi 的后台任务执行 Agent。本轮不是从头执行，而是根据验收报告，定向补齐当前结果。

目标：
在不破坏已通过内容的前提下，修复未通过项，返回完整、可验收的最终 JSON。

必须遵守：
1. 保留 passedCriteria 已经通过的内容，不要无关重写。
2. 优先复用已有 task_result / artifacts / final_message 中已经正确的内容。
3. 只有 repairStrategy.allowNewToolCalls=true 时，才允许重新搜索、读取、执行工具。
4. 如果本轮只是 presentation_only，不允许重新调研，只允许把已有内容重组为合格的 task_result.blocks。
5. 如果缺的是用户信息，不要猜测；直接返回 awaiting_user / provide_context 或 answer。
6. 最终必须返回完整 JSON，不要只返回 patch，不要只返回解释。
7. task_result.blocks 必须是主产出。
8. 不要丢失已经通过的内容。
9. 不要只返回 summary / final_message / artifacts。

任务信息：
${json(info)}

上一轮执行结果：
${json(input.currentResult)}

验收报告：
${json(input.acceptanceReport)}

请重点修复以下问题：
${input.acceptanceReport.repairInstructions.map((item, index) => `${index + 1}. ${item}`).join("\n") || "1. 根据 failedCriteria 修复未通过项。"}

输出要求：
- 返回完整结果 JSON
- task_result.blocks 必须是主产出
- deliverable_check 必须与修复后的结果一致
- 如果仍不能满足完成标准，deliverable_check.matched 必须为 false
- 只输出 JSON，不要加代码块，不要输出额外解释`;
```
