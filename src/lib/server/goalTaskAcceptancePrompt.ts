import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { AcceptanceReport, LocalValidationIssueCode, LocalValidationReport } from "@/types/taskAcceptance";

function json(value: unknown) {
  return JSON.stringify(value ?? null, null, 2);
}

function formatTaskInfo(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
}) {
  const { goal, subGoal, task, instance } = input;
  return {
    goalTitle: goal.title,
    goalSummary: goal.summary || "",
    subGoalTitle: subGoal.title,
    taskId: task.id,
    instanceId: instance.id,
    taskTitle: task.title,
    taskDescription: task.description,
    executionObjective: task.executionObjective || task.description,
    expectedOutcome: task.expectedOutcome,
    completionCriteria: task.expectedResult?.completionCriteria || "完成任务核心目标，并提供可验证、可复用的主产出。",
    presentation: task.expectedResult?.presentation || (task.expectedResult?.type === "information" ? "visual_report" : "document"),
    requiredBlocks: task.expectedResult?.requiredBlocks || [],
    workingDirectory: task.recommendedWorkingDirectory || "",
  };
}

function buildIssueSpecificInstructionCodes(issueCodes: LocalValidationIssueCode[]) {
  const instructions: string[] = [];
  if (issueCodes.includes("json_parse_failed")) {
    instructions.push(
      "本轮只修复 JSON 格式，不要改变原始含义，不要新增事实，不要省略已有内容。",
    );
  }
  if (issueCodes.includes("artifact_only")) {
    instructions.push(
      "上一轮结果只存在 artifacts、summary 或 final_message 中，这不算完成。请把其中有效内容转换为 task_result.blocks；如果 artifact 指向本地文件，请读取该文件内容并转换，而不是只展示文件名。",
    );
  }
  if (issueCodes.includes("empty_blocks")) {
    instructions.push(
      "task_result.blocks 为空，请根据上一轮已有内容补齐完整 blocks；如果内容不足，请明确说明缺失项，不要假装完成。",
    );
  }
  if (issueCodes.includes("missing_required_blocks")) {
    instructions.push(
      "当前缺少任务要求的 block 类型，请补齐缺失 blocks，并确保这些 blocks 承载真实内容，而不是占位提示。",
    );
  }
  if (issueCodes.includes("invalid_block_schema")) {
    instructions.push(
      "当前 blocks 结构不符合系统支持的字段。请保留原内容，只修正 kind 和字段结构，不要发明新的 block 类型。",
    );
  }
  if (issueCodes.includes("blocked_state_invalid")) {
    instructions.push(
      "当前等待用户状态不一致。如果缺少用户输入，必须明确说明需要补充什么；如果不缺用户输入，则直接返回完整 task_result.blocks。",
    );
  }
  if (issueCodes.includes("deliverable_check_invalid")) {
    instructions.push(
      "请根据修复后的 task_result.blocks 重新填写 deliverable_check，确保它与实际产出一致。",
    );
  }
  return instructions;
}

export function buildLocalValidationRepairPrompt(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  rawAgentOutput: string;
  parsedResult: unknown;
  report: LocalValidationReport;
}) {
  const info = formatTaskInfo(input);
  const issueCodes = input.report.issues.map((item) => item.code);
  const issueInstructions = buildIssueSpecificInstructionCodes(issueCodes);

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
7. 如果 repairMode 是 format_repair、structure_repair 或 presentation_repair，不要重新调研，不要新增未经验证的事实；但如果 allowToolCalls=true 且 artifact 指向本地文件，允许只读读取该文件来转换已有产出。
8. 只有 allowToolCalls=true 时，才可以使用只读工具获取上一轮已经生成的本地文件内容；是否允许重新搜索、重新分析，以系统本地校验报告为准。
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
}

export function buildAcceptanceJudgePrompt(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  localValidationReport: LocalValidationReport;
  currentResult: unknown;
}) {
  const info = formatTaskInfo(input);
  return `你是 KiKi 的任务验收员。你不负责执行任务，不负责补做任务，不允许为了“看起来差不多”而判定通过。

你的唯一职责是：根据任务完成标准，检查当前执行结果是否已经满足要求，并输出结构化验收报告。

验收原则：
1. 以任务完成标准和预期产出为最高优先级，而不是以 summary / final_message 为准。
2. 必须检查 task_result.blocks 是否已经承载主产出。
3. 如果主产出缺失、内容不完整、只给摘要、只给 artifact、缺少 requiredBlocks，都不能判定为完成。
4. 如果问题只涉及呈现方式、结构化不足、某些 blocks 缺失，但核心内容大体已存在，可判定为 needs_repair。
5. 如果缺的是用户才能提供的关键信息，判定为 needs_user，不要要求 Agent 猜测补齐。
6. 如果同一轮发现多个需要用户确认、选择或补充的问题，必须全部写入 userBlockers 数组，不能只返回第一个；系统会在同一张交互卡片里一次性询问。
7. 你必须明确指出：哪些标准已通过，哪些未通过，证据是什么，下一轮应该保留什么、补什么、不要改什么。
8. 只输出 JSON。

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
  "userBlockers": ["需要用户补充或确认的问题 1", "需要用户补充或确认的问题 2"]
}`;
}

export function buildSemanticRepairPrompt(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  currentResult: unknown;
  acceptanceReport: AcceptanceReport;
}) {
  const info = formatTaskInfo(input);
  return `你是 KiKi 的后台任务执行 Agent。本轮不是从头执行，而是根据验收报告，定向补齐当前结果。

目标：
在不破坏已通过内容的前提下，修复未通过项，返回完整、可验收的最终 JSON。

必须遵守：
1. 保留 passedCriteria 已经通过的内容，不要无关重写。
2. 优先复用已有 task_result / artifacts / final_message 中已经正确的内容。
3. 只有 repairStrategy.allowNewToolCalls=true 时，才允许重新搜索、读取、执行工具。
4. 如果本轮只是 presentation_only，不允许重新调研，只允许把已有内容重组为合格的 task_result.blocks。
5. 如果缺的是用户信息，不要猜测；直接返回 awaiting_user / provide_context 或 answer，并一次性列出本轮已知的全部用户问题，不要拆成多轮逐个追问。
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
}
