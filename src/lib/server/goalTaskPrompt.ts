import { TASK_RESULT_PROMPT_FRAGMENT } from "@/lib/taskResult/schemaForPrompt";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Goal, SubGoal, Task, TaskExpectedResult, TaskInstance } from "@/types/kiki";

function formatTaskDependencies(task: Task, goal: Goal) {
  if (!task.dependencies?.length) return "无依赖任务。";
  const taskMap = new Map(goal.subGoals.flatMap((subGoal) => subGoal.tasks).map((item) => [item.id, item]));
  return task.dependencies
    .map((dependencyId) => {
      const dependency = taskMap.get(dependencyId);
      if (!dependency) return `- ${dependencyId}`;
      return `- ${dependency.title}: ${dependency.expectedOutcome}`;
    })
    .join("\n");
}

function normalizeResultPresentation(expectedResult?: TaskExpectedResult) {
  if (!expectedResult) return "document";
  const presentation = expectedResult.presentation;
  if (!presentation) return expectedResult.type === "information" ? "visual_report" : "document";
  if (presentation === "comparison_table") {
    return expectedResult.type === "deliverable" ? "document" : "visual_report";
  }
  return presentation;
}

function resolveExportableFormats(task: Task) {
  return task.expectedResult?.exportableFormats?.length ? task.expectedResult.exportableFormats : ["markdown"];
}

function resolveRequiredBlocks(task: Task) {
  return task.expectedResult?.requiredBlocks?.length
    ? task.expectedResult.requiredBlocks
    : (["heading", "paragraph"] as const);
}

function formatExpectedResult(task: Task) {
  const expectedResult = task.expectedResult;
  const normalizedPresentation = normalizeResultPresentation(expectedResult);
  if (!expectedResult) {
    return [
      `- 核心交付物：${task.expectedOutcome}`,
      "- 结果类型：deliverable",
      "- 主格式：structured_blocks",
      `- 结果级呈现：${normalizedPresentation}`,
      "- 可导出格式：markdown",
      "- 完成标准：完成任务核心目标，并提供可验证、可复用的主交付物。",
    ].join("\n");
  }

  const lines = [
    `- 核心交付物：${expectedResult.description || task.expectedOutcome}`,
    `- 结果类型：${expectedResult.type}`,
    `- 原始格式提示：${expectedResult.format}`,
    `- 主格式：${expectedResult.primaryFormat || "structured_blocks"}`,
    `- 结果级呈现：${normalizedPresentation}`,
  ];

  if (expectedResult.presentation === "comparison_table") {
    lines.push("- 主视图 block：comparison_table");
  }

  lines.push(
    `- 可导出格式：${resolveExportableFormats(task).join("、")}`,
    `- 必须包含的 blocks：${resolveRequiredBlocks(task).join("、")}`,
    `- 完成标准：${expectedResult.completionCriteria || "完成任务核心目标，并提供可验证、可复用的主交付物。"}`,
  );

  return lines.join("\n");
}

function formatMachineReadableContract(task: Task) {
  const expectedResult = task.expectedResult;
  return JSON.stringify(
    {
      resultType: expectedResult?.type || "deliverable",
      primaryFormat: expectedResult?.primaryFormat || "structured_blocks",
      presentation: normalizeResultPresentation(expectedResult),
      ...(expectedResult?.presentation === "comparison_table" ? { mainBlock: "comparison_table" } : {}),
      requiredBlocks: resolveRequiredBlocks(task),
      completionCriteria:
        expectedResult?.completionCriteria || "完成任务核心目标，并提供可验证、可复用的主交付物。",
      exportableFormats: resolveExportableFormats(task),
    },
    null,
    2,
  );
}

function formatCollaborationContract(task: Task) {
  const collaboration = task.collaboration;
  if (!collaboration) {
    return [
      "- 协作模式：agent_autonomous",
      "- Agent 负责：完成任务并交付结果",
      "- 用户负责：查看结果",
      "- 用户介入类型：none",
      "- 用户介入时机：not_required",
      "- 完成归属：agent",
    ].join("\n");
  }

  return [
    `- 协作模式：${collaboration.mode}`,
    `- Agent 负责：${collaboration.agentResponsibilities.length ? collaboration.agentResponsibilities.join("；") : "完成任务并交付结果"}`,
    `- 用户负责：${collaboration.userResponsibilities.length ? collaboration.userResponsibilities.join("；") : "无需用户参与"}`,
    `- 用户介入类型：${collaboration.userInteractionType}`,
    `- 用户介入时机：${collaboration.userInteractionTiming}`,
    `- 用户动作文案：${collaboration.userFacingActionLabel}`,
    `- 是否主动通知用户：${collaboration.shouldNotifyUser ? "是" : "否"}`,
    `- 完成归属：${collaboration.completionOwner}`,
    `- 完成定义：${collaboration.completionDefinition}`,
  ].join("\n");
}

function buildStepZeroPrompt(isResume: boolean) {
  return `【第一步：执行前提自检（必须先做）】
先看你当前任务的“协作契约 / 用户介入时机 / 用户介入类型”，按以下规则判断：

A. 如果 协作模式=agent_user_collaborative 且 用户介入时机=before_execution 且 用户介入类型 ∈ {answer, provide_context}：
   1. 列出任务“用户负责”清单中所有需要用户提供的字段。
   2. 对照“目标 / 目标摘要 / 任务描述 / 依赖任务${isResume ? " / 恢复上下文" : ""}”判断这些字段是否已经具备。
   3. 任一关键字段缺失：不要做检索，不要给方案，不要输出占位对比表。
      直接按“输出模板 B（等待用户）”返回，并一次性列出所有缺失字段。
   4. 全部前提已满足：进入正常执行，按“输出模板 A（正常完成）”返回。

B. 如果 协作模式=agent_autonomous：
   1. 只检查是否存在无法靠检索、推理或执行补齐的硬缺口（例如：用户从未设定目标方向、凭证缺失）。
   2. 没有硬缺口：直接进入正常执行，按“输出模板 A”产出。
   3. 有硬缺口：才允许走“输出模板 B”，且 interaction_requirement.type 应为 deliverable_gap。

C. 如果 用户介入时机 ∈ {during_execution, after_agent_output}：
   1. Agent 应先产出候选方案、对比或候选集，填入 task_result.blocks。
   2. 再在 interaction_requirement 中说明需要用户在哪个节点选择、审核或回答。

D. 如果本轮是恢复执行模式：
   1. 仅针对上一轮新暴露的缺口执行本自检。
   2. 已由上一轮用户回答的字段严禁重复提问。`;
}

export function buildGoalTaskRunnerPrompt(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  resumeContext?: string;
  initialTrajectory?: ExecutionTrajectoryStep[];
}) {
  const { goal, subGoal, task, instance, resumeContext, initialTrajectory } = input;
  const isResume = Boolean(resumeContext) || (initialTrajectory?.length ?? 0) > 0;
  const previousToolCalls = (initialTrajectory ?? [])
    .filter((step) => step.type === "tool_call" && step.toolCall)
    .map((step, index) => {
      const toolName = step.toolCall?.name ?? "tool";
      const summary = step.toolCall?.summary ?? step.title ?? "";
      return `${index + 1}. ${toolName}${summary ? `：${summary}` : ""}`;
    })
    .slice(-20)
    .join("\n");
  const previousAssistantOutputs = (initialTrajectory ?? [])
    .filter((step) => step.type === "assistant" || step.type === "result")
    .slice(-3)
    .map((step) => `- ${step.title ?? ""}${step.thought ? `\n  ${step.thought.slice(0, 600)}` : ""}`)
    .join("\n");
  const resumeBlock = isResume
    ? `

【恢复执行模式（增量续跑，禁止重新规划）】
本次调用是已经执行过部分轨迹后的“恢复执行”。你必须遵守以下增量续跑约束：
1. 严禁重新规划任务、重新拆解步骤、重新构造执行路线，也不要再写一份“整体计划”作为输出。
2. 严禁重复已经做过的工具调用（特别是 WebSearch / WebFetch / Grep / Read 等只读检索类操作）；如果信息已在前序轨迹中获取，直接复用前序结论，不要再次搜索。
3. 严禁丢弃前序产出。前序已经形成的数据、结论、blocks，必须在本轮 task_result.blocks 中沿用与组合，不要重起炉灶。
4. 你的本轮重点是“补差 / 重组 / 校验”：识别上一轮未满足验收的部分，仅针对该缺口产出最小增量。
5. 只有当前序信息确实不足以补齐缺口时，才允许触发新的工具调用，且必须在 final_message 中说明“为什么必须补抓 X 信息”。
6. 如果用户在恢复上下文中追加了新输入或新约束，必须吸收进本轮结果，但仍只做增量更新，不要从零开始。
7. 只有恢复执行后新发现的缺口才允许再次 awaiting_user；已由上一轮用户回答的字段不得重复提问。
${resumeContext ? `\n用户恢复上下文（必须纳入本轮执行）：\n${resumeContext}\n` : ""}${previousToolCalls ? `\n前序已经调用过的工具（避免重复执行）：\n${previousToolCalls}\n` : ""}${previousAssistantOutputs ? `\n前序 Agent 已产出的关键内容（必须沿用与重组，不允许丢弃）：\n${previousAssistantOutputs}\n` : ""}`
    : "";
  const normalizedPresentation = normalizeResultPresentation(task.expectedResult);

  return `你是 KiKi 的后台任务执行 Agent。请以“交付物契约”为核心真实推进任务，而不是只给建议或只总结过程。

你的任务不是证明自己做过事情，而是交付与任务契约一致的可验收产物。

${buildStepZeroPrompt(isResume)}

总原则：无论正常完成、等待用户还是存在缺口，主产出都必须放在 task_result.blocks 中；summary / final_message / artifacts 只能辅助说明，不能替代主产出。

目标：${goal.title}
目标摘要：${goal.summary || "无"}
子目标：${subGoal.title}
任务标题：${task.title}
任务描述：${task.description}
任务执行目标：${task.executionObjective || task.description}
建议工作目录：${task.recommendedWorkingDirectory || "使用 Runtime 当前 working directory"}
依赖任务：
${formatTaskDependencies(task, goal)}

交付物契约（必须满足）：
- 预期结果：${task.expectedOutcome}
${formatExpectedResult(task)}

【交付物契约机器可读视图】(请把它逐项映射到最终 deliverable_check.criteria_results)
${formatMachineReadableContract(task)}

协作契约（必须遵守）：
${formatCollaborationContract(task)}

${resumeBlock}

执行约束：
1. 先执行“第一步：执行前提自检”。只有确认前提已满足，才允许直接检索、分析、生成最终交付物。
2. 如果可导出格式包含 html，表示结构化产物必须具备 HTML 渲染/导出的语义；不要直接输出未清洗的 HTML 作为主产物，主产物仍然是 task_result.blocks。
3. 如果无法满足交付物契约，不要假装完成；必须设置 interaction_requirement.type=agent_revision_required 或 deliverable_gap，并在 deliverable_check.missing_deliverables 中说明缺口。
4. 如果需要用户确认、作答、补充关键上下文或完成线下动作，请根据协作契约设置 interaction_requirement.type，不要把所有场景都写成 confirm。
5. 如果缺少用户才能提供的关键输入（例如出发城市、账号信息、个人偏好、预算上限、目标选择等），必须立即停止产出最终完成态交付物：
   - awaiting_user 必须为 true。
   - interaction_requirement.question 必须一次性列出本轮所有已知缺失项，不能只问第一个。
   - interaction_requirement.options 必须给出恰好 3 个可直接点击的候选项，而且必须与问题本身直接对应，优先给“可直接回答问题”的具体值，而不是泛化动作。
     例如：问“偏好的住宿区域和酒店类型”时，应给“海滩区 + 度假酒店 / 市中心 + 高性价比酒店 / 度假区 + 一站式酒店”，不要写“补充具体信息 / 补充约束或偏好”。
     只有在系统完全无法从任务上下文判断候选维度时，才允许使用动作型兜底项。UI 会自动补 1 个“自己填写”。
   - task_result.status 必须为 pending_user 或 blocked，blocks 只呈现“需要补充的信息”和“为什么需要”，不要输出基于猜测的方案。
   - deliverable_check.matched 必须为 false，missing_deliverables 必须包含本轮全部缺失用户输入。
   - artifacts 必须为空数组；如果 awaiting_user=true，顶层 suggested_actions 默认也应为空数组，除非确有必要给出补充行动建议。
6. 禁止猜测或幻想关键事实。可以说明“缺少信息，无法继续”，但不能用默认城市、默认预算、默认偏好代替用户输入。
7. 最终输出必须是一个 JSON 对象，不要加代码块，不要输出额外解释。

${TASK_RESULT_PROMPT_FRAGMENT}

验收规则：
1. 逐条检查“预期结果”和“完成标准”是否被最终产物覆盖。
2. deliverable_check.matched 只有在 task_result.blocks 组件化主产出真实覆盖预期结果且没有关键缺口时才能为 true。
3. 只生成过程描述、泛泛总结、计划、待办列表，不算满足交付物契约。

输出模板 A（正常完成，适用于 done / draft）：
{
  "summary": "本轮执行结果摘要",
  "final_message": "面向用户的一段自然语言总结",
  "result_view_kind": "generic_result|reading_digest|draft_review|confirm_action|flashcard|listening_qa",
  "awaiting_user": false,
  "awaiting_reason": "",
  "interaction_requirement": {
    "type": "none|confirm|answer|provide_context|perform_offline_action|deliverable_gap|agent_revision_required",
    "timing": "not_required|before_execution|during_execution|after_agent_output|core_task_step",
    "reason": "为什么需要用户或 Agent 继续处理；无需介入时留空",
    "question": "",
    "options": [],
    "suggested_actions": [],
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
    "status": "done|draft|failed",
    "blocks": [
      { "kind": "heading", "text": "核心结论", "level": 2 },
      { "kind": "paragraph", "text": "直接可验收的产物正文。" }
    ],
    "meta": {
      "producedAt": "ISO 时间",
      "presentation": "${normalizedPresentation}",
      "primaryFormat": "${task.expectedResult?.primaryFormat || "structured_blocks"}",
      "exportableFormats": ${JSON.stringify(resolveExportableFormats(task))}
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
    "gap_reason": ""
  },
  "structured_output": {
    "key": "value"
  }
}

输出模板 B（等待用户，适用于执行前提不足）：
说明：当 awaiting_user=true 时，interaction_requirement.options 必须恰好给 3 个候选项，并且这 3 个候选项必须能直接回答当前问题。优先给具体答案，不要给泛化动作。只有完全无法判断候选维度时，才使用“补充具体信息”“补充约束/偏好”“说明暂时无法提供”兜底。UI 会自动补 1 个“自己填写”。
{
  "summary": "需要用户补充关键信息后才能继续",
  "final_message": "请用户补充本轮全部缺失信息，并说明为什么这些信息会影响主交付物。",
  "result_view_kind": "generic_result",
  "awaiting_user": true,
  "awaiting_reason": "缺少用户才能提供的关键输入",
  "interaction_requirement": {
    "type": "provide_context|answer|confirm|perform_offline_action|deliverable_gap",
    "timing": "before_execution|during_execution|after_agent_output|core_task_step",
    "reason": "缺少用户输入，暂时无法完成主交付物",
    "question": "请一次性列出本轮所有缺失字段，用自然语言提问。",
    "options": ["候选项1", "候选项2", "候选项3"],
    "suggested_actions": [],
    "should_notify_user": true
  },
  "suggested_actions": [],
  "artifacts": [],
  "task_result": {
    "schemaVersion": 1,
    "taskId": "${task.id}",
    "instanceId": "${instance.id}",
    "title": "等待用户补充：结构化产物标题",
    "status": "pending_user|blocked",
    "blocks": [
      { "kind": "heading", "text": "需要你补充的信息", "level": 2 },
      { "kind": "list", "ordered": true, "items": ["缺失项1", "缺失项2", "缺失项3"] },
      { "kind": "callout", "tone": "info", "text": "补充完这些信息后，Agent 会继续完成主交付物。" }
    ],
    "meta": {
      "producedAt": "ISO 时间",
      "presentation": "visual_report",
      "primaryFormat": "structured_blocks",
      "exportableFormats": ["markdown"]
    }
  },
  "deliverable_check": {
    "matched": false,
    "confidence": "high|medium|low",
    "delivered_artifacts": [],
    "missing_deliverables": ["缺失项1", "缺失项2", "缺失项3"],
    "criteria_results": [
      {
        "criterion": "验收标准",
        "status": "failed",
        "evidence": "用户关键输入缺失，尚无法完成主交付物。"
      }
    ],
    "gap_reason": "用户必需输入缺失，尚无法产出主交付物"
  },
  "structured_output": {}
}

当前实例信息：
- instanceId: ${instance.id}
- dateLabel: ${instance.dateLabel}
- instanceIntro: ${instance.intro}`;
}
