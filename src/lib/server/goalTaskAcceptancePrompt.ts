import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { AcceptanceReport, LocalValidationIssueCode, LocalValidationReport } from "@/types/taskAcceptance";
import { resolveExpectedSurfaces } from "@/lib/taskResult/surfaces";

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
    expectedSurfaces: resolveExpectedSurfaces(task.expectedResult),
    interactiveSurfaceKind: task.expectedResult?.interactiveSurface?.kind || "blocks",
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
  if (issueCodes.includes("missing_interactive_surface")) {
    instructions.push(
      "任务要求交互渲染区。如果 interactiveSurfaceKind=webapp，请返回顶层 webapp 对象并设置 task_result.meta.interactiveSurfaceKind=webapp；否则请把上一轮有效内容整理到 task_result.blocks。如果同时要求文件区域，也要保留 files。",
    );
  }
  if (issueCodes.includes("missing_file_surface")) {
    instructions.push(
      "任务要求文件区域。请返回 files 数组，每项包含 filename、mime、content；如果同时要求交互渲染区，也要保留 task_result.blocks。",
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
3. 必须满足任务 expectedSurfaces：interactive 按 interactiveSurfaceKind 对应 task_result.blocks 或顶层 webapp 对象，files 对应 files 数组。
4. summary 和 final_message 只能做简短说明，不能替代被要求的结果区域。
5. 如果只要求文件区域，可以只返回 files；如果要求双区域，必须同时返回对应 interactive surface 和 files。
6. 如果已有 artifacts / final_message / summary 中包含有效内容，必须按 expectedSurfaces 转换或整理进对应区域。
7. 如果 repairMode 是 format_repair、structure_repair 或 presentation_repair，不要重新调研，不要新增未经验证的事实；但如果 allowToolCalls=true 且 artifact 指向本地文件，允许只读读取该文件来转换已有产出。
8. 只有 allowToolCalls=true 时，才可以使用只读工具获取上一轮已经生成的本地文件内容；是否允许重新搜索、重新分析，以系统本地校验报告为准。
9. 如果缺少用户才能提供的信息，不要猜测；必须返回 awaiting_user=true，并设置 interaction_requirement.type 为 provide_context 或 answer。
10. 如果无法修复，不要假装完成；返回 deliverable_check.matched=false，并说明仍缺什么。

# Keep
- 保留上一轮已经有效的 task_result、files、artifacts、summary、final_message 中可复用内容。
- 保留已经满足 expectedSurfaces 和完成标准的部分。
- 保留用户已经提供过的上下文，不要重复询问。

# Fix
- 只修复系统本地校验报告中的 critical 和 major 问题。
- 如果缺少结果区域，把已有有效内容整理到对应区域，而不是重写整份结果。
- 如果 deliverable_check 与实际交付不一致，必须同步修正。

# Do Not Change
- 不要无关重写已通过内容。
- 不要重新调研或新增未经验证的事实，除非报告明确允许且 allowToolCalls=true。
- 不要把 summary 或 final_message 当作结果区域替代 task_result.blocks、webapp 或 files。

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
2. 必须检查任务 expectedSurfaces 要求的区域是否齐全：interactive 按 interactiveSurfaceKind 检查 task_result.blocks 或 webapp，files 检查 files/artifactRefs。
3. 如果被要求的结果区域缺失、内容不完整、只给摘要，不能判定为完成。
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
4. 如果本轮只是 presentation_only，不允许重新调研，只允许把已有内容重组为任务要求的结果区域。
5. 如果缺的是用户信息，不要猜测；直接返回 awaiting_user / provide_context 或 answer，并一次性列出本轮已知的全部用户问题，不要拆成多轮逐个追问。
6. 最终必须返回完整 JSON，不要只返回 patch，不要只返回解释。
7. 必须满足 expectedSurfaces：interactive 按 interactiveSurfaceKind 使用 task_result.blocks 或 webapp，files 使用 files 数组或 artifactRefs。
8. 不要丢失已经通过的内容。
9. 不要只返回 summary / final_message，除非任务确实仍在等待用户输入。

# Keep
- 保留 acceptanceReport.passedCriteria 对应的内容和证据。
- 保留当前结果中已经符合 expectedSurfaces 的区域。
- 保留用户输入、已生成文件和已通过 blocks。

# Fix
- 只补齐 failedCriteria、missingBlocks、rewriteBlocks 和 repairInstructions 指向的问题。
- 如果 repairStrategy.mode 是 presentation_only，只允许结构化重组，不新增事实。
- 如果 repairStrategy.allowNewToolCalls=false，不要重新搜索、重新读取外部网页或重新分析。

# Do Not Change
- 不要从头重写整份结果。
- 不要破坏已通过的 blocks、files 或 artifactRefs。
- 不要把执行过程、工具调用、审阅过程写入最终结果区。

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
- 结果区域必须满足 expectedSurfaces
- deliverable_check 必须与修复后的结果一致
- 如果仍不能满足完成标准，deliverable_check.matched 必须为 false
- 只输出 JSON，不要加代码块，不要输出额外解释`;
}
