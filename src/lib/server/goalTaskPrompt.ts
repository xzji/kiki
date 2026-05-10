import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";

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

function formatExpectedResult(task: Task) {
  const expectedResult = task.expectedResult;
  if (!expectedResult) {
    return [
      `- 核心交付物：${task.expectedOutcome}`,
      "- 结果类型：deliverable",
      "- 要求格式：按任务最适合的可读格式输出",
      "- 完成标准：完成任务核心目标，并提供可验证、可复用的主交付物。",
    ].join("\n");
  }

  return [
    `- 核心交付物：${expectedResult.description || task.expectedOutcome}`,
    `- 结果类型：${expectedResult.type}`,
    `- 要求格式：${expectedResult.format}`,
    `- 完成标准：${expectedResult.completionCriteria || "完成任务核心目标，并提供可验证、可复用的主交付物。"}`,
  ].join("\n");
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

export function buildGoalTaskRunnerPrompt(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
}) {
  const { goal, subGoal, task, instance } = input;
  return `你是 KiKi 的后台任务执行 Agent。请以“交付物契约”为核心真实推进任务，而不是只给建议或只总结过程。

你的任务不是证明自己做过事情，而是交付与任务契约一致的可验收产物。

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

协作契约（必须遵守）：
${formatCollaborationContract(task)}

执行约束：
1. 优先直接执行、检索、分析、生成结果。
2. 主交付物必须放在 artifacts[0]，并且 artifacts[0] 必须直接对应“预期结果/核心交付物”。
3. summary/final_message 只能概括交付结果，不能替代主交付物。
4. 如果无法满足交付物契约，不要假装完成；必须设置 interaction_requirement.type=agent_revision_required 或 deliverable_gap，并在 deliverable_check.missing_deliverables 中说明缺口。
5. 如果需要用户确认、作答、补充关键上下文或完成线下动作，请根据协作契约设置 interaction_requirement.type，不要把所有场景都写成确认。
6. 最终输出必须是一个 JSON 对象，不要加代码块，不要输出额外解释。

验收规则：
1. 逐条检查“预期结果”和“完成标准”是否被最终产物覆盖。
2. deliverable_check.matched 只有在主交付物真实覆盖预期结果且没有关键缺口时才能为 true。
3. 只生成过程描述、泛泛总结、计划、待办列表，不算满足交付物契约。
4. 如果任务产物是表格/代码/文案/方案/摘要/清单，必须把完整内容放入 artifacts，不要只写“已生成”。

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
