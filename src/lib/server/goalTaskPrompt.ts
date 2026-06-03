import { EXTERNAL_EMBED_PROMPT_FRAGMENT, FILE_ARTIFACT_PROMPT_FRAGMENT, TASK_RESULT_PROMPT_FRAGMENT, WEBAPP_ARTIFACT_PROMPT_FRAGMENT } from "@/lib/taskResult/schemaForPrompt";
import { resolveExpectedSurfaces } from "@/lib/taskResult/surfaces";
import {
  renderDependencyReuseInstruction,
  renderDependencySection,
  renderWorkspaceHint,
} from "@/lib/server/taskExecution/contextRenderer";
import type { TaskExecutionContext } from "@/lib/server/taskExecution/types";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Task, TaskExpectedResult } from "@/types/kiki";

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
  if (!resolveExpectedSurfaces(task.expectedResult).includes("interactive")) return [];
  if (task.expectedResult?.interactiveSurface?.kind === "webapp") return [];
  return task.expectedResult?.requiredBlocks?.length
    ? task.expectedResult.requiredBlocks
    : (["heading", "paragraph"] as const);
}

function formatExpectedResult(task: Task) {
  const expectedResult = task.expectedResult;
  const normalizedPresentation = normalizeResultPresentation(expectedResult);
  const expectedSurfaces = resolveExpectedSurfaces(expectedResult);
  if (!expectedResult) {
    return [
      `- 核心交付物：${task.expectedOutcome}`,
      "- 结果类型：deliverable",
      "- 主格式：structured_blocks",
      "- 结果呈现区域：interactive",
      `- 结果级呈现：${normalizedPresentation}`,
      "- 可导出格式：markdown",
      "- 完成标准：完成任务核心目标，并提供可验证、可复用的主交付物。",
    ].join("\n");
  }

  const lines = [
    `- 核心交付物：${expectedResult.description || task.expectedOutcome}`,
    `- 结果类型：${expectedResult.type}`,
    `- 原始格式提示：${expectedResult.format}`,
    `- 结果呈现区域：${expectedSurfaces.join("、")}`,
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

function formatMachineReadableRequirements(task: Task) {
  const expectedResult = task.expectedResult;
  return JSON.stringify(
    {
      resultType: expectedResult?.type || "deliverable",
      surfaces: resolveExpectedSurfaces(expectedResult),
      interactiveSurface: expectedResult?.interactiveSurface ?? { required: resolveExpectedSurfaces(expectedResult).includes("interactive"), kind: "blocks" },
      fileSurface: expectedResult?.fileSurface ?? { required: resolveExpectedSurfaces(expectedResult).includes("files") },
      legacyDeliveryMode: expectedResult?.deliveryMode || "inline",
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

function formatCollaborationRequirements(task: Task) {
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
先看你当前任务的“协作要求 / 用户介入时机 / 用户介入类型”，按以下规则判断：

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
   3. 但如果任务的结果类型是 information，且完成标准只是生成报告、调研、对比、分析或清单，则用户查看、确认是否满意、选择下一步只属于产出反馈/下游输入，不是当前任务完成条件。此时必须按“输出模板 A（正常完成）”返回，awaiting_user=false，并把下一步建议写入 suggested_actions。

D. 如果本轮是恢复执行模式：
   1. 仅针对上一轮新暴露的缺口执行本自检。
   2. 已由上一轮用户回答的字段严禁重复提问。`;
}

export function buildGoalTaskRunnerPrompt(input: {
  context: TaskExecutionContext;
  resumeContext?: string;
  initialTrajectory?: ExecutionTrajectoryStep[];
  webAppInteractionContext?: string;
}) {
  const { context, resumeContext, initialTrajectory } = input;
  const { goal, subGoal, task, instance } = {
    goal: context.inputs.goal,
    subGoal: context.inputs.subGoal,
    task: context.inputs.task,
    instance: context.inputs.instance,
  };
  if (!instance) {
    throw new Error("buildGoalTaskRunnerPrompt requires an execution context with instance.");
  }
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
  const expectedSurfaces = resolveExpectedSurfaces(task.expectedResult);
  const requiresInteractiveSurface = expectedSurfaces.includes("interactive");
  const requiresFileSurface = expectedSurfaces.includes("files");
  const interactiveSurfaceKind = task.expectedResult?.interactiveSurface?.kind ?? (requiresInteractiveSurface ? "blocks" : undefined);
  const requiresWebAppSurface = requiresInteractiveSurface && interactiveSurfaceKind === "webapp";
  const webAppInteractionContext = input.webAppInteractionContext ?? "";

  return `# Role
你是 KiKi 的后台任务执行 Agent。请以“交付物要求”为核心真实推进任务，而不是只给建议或只总结过程。

你的任务不是证明自己做过事情，而是交付与任务要求一致的可验收产物。

# Dynamic Context
目标：${goal.title}
目标摘要：${goal.summary || "无"}
子目标：${subGoal.title}
任务标题：${task.title}
任务描述：${task.description}
任务执行目标：${task.executionObjective || task.description}
建议工作目录：${context.workspace?.taskWorkspaceDir || task.recommendedWorkingDirectory || "使用 Runtime 当前 working directory"}
${renderWorkspaceHint(context)}
依赖任务：
${renderDependencySection(context)}

交付物要求（必须满足）：
- 预期结果：${task.expectedOutcome}
${formatExpectedResult(task)}

【交付物要求机器可读视图】(请把它逐项映射到最终 deliverable_check.criteria_results)
${formatMachineReadableRequirements(task)}

协作要求（必须遵守）：
${formatCollaborationRequirements(task)}

${resumeBlock}

${webAppInteractionContext}

# Instructions
${buildStepZeroPrompt(isResume)}

总原则：最终结果必须满足“结果呈现区域”要求。交互渲染区可以由 task_result.blocks 或 webapp 承载；文件区域当前放在 files 数组中，由系统转成 task_result.artifactRefs。两类区域可以同时存在，也可以只存在其中一种。

最终回复硬性格式：
1. 只能输出一个完整 JSON 对象。
2. 不要输出 Markdown 代码块。
3. 不要在 JSON 前后输出任何自然语言解释、执行过程、思考过程或附加说明。
4. 可以在 workspace 内写文件作为副本，但最终回复仍必须把完整 JSON 输出到消息中；如果任务要求文件区域，必须返回 files 数组，不能只返回本地文件路径。
5. 如果需要用户确认，仍必须按“输出模板 B”输出完整 JSON，并设置 awaiting_user=true。
6. information 类型任务如果已经满足 completion_criteria，不要为了收集用户反馈或选择下一步而设置 awaiting_user=true 或 interaction_requirement.confirm；应设置 awaiting_user=false，并在 suggested_actions 中给出可选下一步。
7. task_result.blocks 是给用户看的最终交付结果，只能包含结论、报告、表格、建议、清单、可交互内容等交付物本身。
8. 不要把执行过程、工具调用过程、Agent 自我说明、审阅过程、角色分工、协同过程写进 task_result.blocks；这些过程信息应留在执行轨迹或极简 final_message 中。

执行约束：
1. 先执行“第一步：执行前提自检”。只有确认前提已满足，才允许直接检索、分析、生成最终交付物。
2. 如果结果呈现区域包含 interactive 且 interactiveSurface.kind=blocks，必须返回可页面渲染的 task_result.blocks；如果 interactiveSurface.kind=webapp，必须返回顶层 webapp 对象，task_result.blocks 可作为降级摘要。
3. 如果无法满足交付物要求，不要假装完成；必须设置 interaction_requirement.type=agent_revision_required 或 deliverable_gap，并在 deliverable_check.missing_deliverables 中说明缺口。
4. 如果需要用户确认、作答、补充关键上下文或完成线下动作，请根据协作要求设置 interaction_requirement.type，不要把所有场景都写成 confirm。
5. 如果缺少用户才能提供的关键输入（例如出发城市、账号信息、个人偏好、预算上限、目标选择等），必须立即停止产出最终完成态交付物：
   - awaiting_user 必须为 true。
   - interaction_requirement.question 只用于多字段总问题；如果本轮只有 1 个 field，不要把该 field.question 复制到顶层 question。
   - 同一个问题只能出现在一个字段里：顶层 question、field.question、final_message、summary 不要互相复述；如果 field.question 已经完整表达问题，顶层 question 应留作总问题或留空。
   - interaction_requirement.fields 必须为每个缺失字段各输出 1 个对象，包含 id、label、question、description、options、inputPlaceholder、inputKind。
   - field.inputKind 是 UI 输入形态的权威来源，只能取 text、image、file、image_or_text：纯文本/事实填写用 text；必须上传截图或照片用 image；必须上传文档或附件用 file；截图或文字记录均可用 image_or_text。
   - field.inputKind 为 text 或 image_or_text 时，必须优先给 3 个可直接点击的候选答案；只有在字段确实需要用户输入精确事实、无法合理枚举时，才允许返回空数组并提供 inputPlaceholder。
   - field.inputKind 为 image 或 file 时，field.options 必须为空数组，避免把上传动作伪装成候选答案。
   - 候选项必须是“答案”，不是“动作”：禁止写“补充具体信息 / 补充约束或偏好 / 说明暂时无法提供 / 填写其他信息”。
   - 候选项之间要互斥，并覆盖常见主流分支；每项必须自带区分参数（时长、价格、适用场景、条件等），控制在 8-25 字。
     例如：问“偏好的住宿区域和酒店类型”时，应给“海滩区+度假酒店（放松） / 市中心+四星酒店（便利） / 度假区+五星酒店（省心）”。
     例如：问“选哪种越南签证”时，应给“电子签 e-Visa（90天） / 落地签（需邀请函） / 贴纸签（使馆办理）”。
   - UI 会为每个 field 自动补 1 个“都不是，我自己描述”，你不要把这个兜底项放进 options。
   - task_result.status 必须为 pending_user 或 blocked；如果要求交互渲染区，blocks 只呈现“需要补充的信息”和“为什么需要”，不要输出基于猜测的方案；UI 在等待用户态会隐藏这类归档占位 blocks，避免和表单重复。
   - deliverable_check.matched 必须为 false，missing_deliverables 必须包含本轮全部缺失用户输入。
   - artifacts 必须为空数组；如果 awaiting_user=true，顶层 suggested_actions 默认也应为空数组，除非确有必要给出补充行动建议。
6. 禁止猜测或幻想关键事实。可以说明“缺少信息，无法继续”，但不能用默认城市、默认预算、默认偏好代替用户输入。
7. 最终输出必须是一个 JSON 对象，不要加代码块，不要输出额外解释。
${renderDependencyReuseInstruction(context)}

${TASK_RESULT_PROMPT_FRAGMENT}

${requiresWebAppSurface ? `${WEBAPP_ARTIFACT_PROMPT_FRAGMENT}\n\n${EXTERNAL_EMBED_PROMPT_FRAGMENT}` : ""}

${requiresFileSurface ? FILE_ARTIFACT_PROMPT_FRAGMENT : ""}

验收规则：
1. 逐条检查“预期结果”和“完成标准”是否被最终产物覆盖。
2. deliverable_check.matched 只有在所有要求的结果呈现区域都真实覆盖预期结果且没有关键缺口时才能为 true。
3. 只生成过程描述、泛泛总结、计划、待办列表，不算满足交付物要求。

# Output Format
输出模板 A（正常完成，适用于 done / draft）：
{
  "summary": "本轮执行结果摘要",
  "final_message": "面向用户的一段自然语言总结",
  "result_view_kind": "generic_result",
  "awaiting_user": false,
  "awaiting_reason": "",
  "interaction_requirement": {
    "type": "none|confirm|answer|provide_context|perform_offline_action|deliverable_gap|agent_revision_required",
    "timing": "not_required|before_execution|during_execution|after_agent_output|core_task_step",
    "reason": "为什么需要用户或 Agent 继续处理；无需介入时留空",
    "question": "",
    "options": [],
    "fields": [],
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
  "files": ${requiresFileSurface ? "[{\"filename\":\"result.md\",\"mime\":\"text/markdown; charset=utf-8\",\"content\":\"# 文件正文\\n\\n这里写完整文件内容。\"}]" : "[]"},
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
      "surfaces": ${JSON.stringify(expectedSurfaces)},
      "interactiveSurfaceKind": ${JSON.stringify(requiresInteractiveSurface ? interactiveSurfaceKind : null)},
      "fileSurfaceRequired": ${JSON.stringify(requiresFileSurface)},
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
说明：当 awaiting_user=true 时，interaction_requirement.fields 是权威结构；每个缺失字段必须给 1 个 field。候选项生成模板如下：
1. 每个 field.question 必须是完整自然问句，不要只写字段名。
2. 每个 field.description 必须说明为什么这个信息会影响任务结果。
3. text/image_or_text 字段必须优先给 3 个具体答案，降低用户填写成本；field.options 必须是该问题的具体答案，不是“补充信息/提供偏好/说明暂时无法提供”这类动作；image/file 字段必须返回空数组。
4. 同一 field 内候选项之间应互斥，覆盖 2-3 个主流答案。
5. 每项自带关键参数（时长 / 价格 / 适用场景 / 条件），让用户不点开也能判断。
6. 每项 8-25 字，口语化，不要写“方案 A / 选项一”。
7. UI 会为 text/image_or_text 字段自动追加“都不是，我自己描述”，不要把该兜底项写进 options。
8. 每个 field.inputKind 必须根据用户实际要采取的动作填写，只能取 text、image、file、image_or_text；禁止让 UI 依赖字段文案猜测输入形态。
9. 顶层 question、每个 field.question、summary、final_message 之间禁止逐字或近义重复；summary/final_message 只说明状态，不复述具体问题。
提交前自检：如果任一 field.options 中仍有“补充 XX / 提供 XX / 填写其他信息”等元操作描述，或同一句问题同时出现在顶层 question 与 field.question 中，必须重写后再输出。
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
    "options": [],
    "fields": [
      {
        "id": "departure_city",
        "label": "出发城市",
        "question": "你打算从哪个城市出发？",
        "description": "查询交通、住宿或行程安排需要明确出发地。",
        "options": ["北京", "上海", "广州"],
        "inputPlaceholder": "请输入城市名，如 成都",
        "inputKind": "text",
        "source": "user"
      }
    ],
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

# Examples
示例 1：mixed 模式正常完成
- 如果交付物要求同时包含 interactive 和 files，最终 JSON 必须同时提供 task_result.blocks 和 files。
- task_result.blocks 用于页面内阅读，files 用于文件区域和下载；只提供其中一个都不算完整完成。
- deliverable_check.criteria_results 必须逐项说明 blocks 和 files 都已覆盖。

示例 2：等待用户补充信息
- 如果缺少用户才能提供的关键输入，awaiting_user=true。
- interaction_requirement.fields 必须按缺失字段分组；text/image_or_text 字段应优先给 3 个具体答案，例如“海滩区+度假酒店（放松）/ 市中心+四星酒店（便利）/ 度假区+五星酒店（省心）”；image/file 字段必须为空数组。
- 每个 field.inputKind 必须显式声明 UI 输入形态，例如“截图或确认记录”应返回 image_or_text，“账号文本”应返回 text。
- 禁止把任一 field.options 写成“补充信息 / 提供偏好 / 填写其他内容”这类动作。
- 禁止把同一句问题同时写进 interaction_requirement.question 和 fields[].question；单字段时优先保留 fields[].question，顶层 question 写“请补充以下信息”或留空。

示例 3：information 类型任务已完成
- 如果任务只是生成报告、调研、对比、分析或清单，且完成标准已经满足，awaiting_user=false。
- 用户是否满意、是否选择下一步、是否继续修订，属于结果反馈或下游输入，不是当前任务完成条件。
- 可把“查看结果、提出修改、继续深入分析”等写入 suggested_actions。

# Critical Reminders
1. 只能输出一个完整 JSON 对象，不要输出 Markdown 代码块。
2. 不要在 JSON 前后输出任何自然语言解释、执行过程、思考过程或附加说明。
3. task_result.blocks 只能包含用户真正需要的最终交付内容，不能包含工具调用、Agent 协同、审阅打回或移交过程。
4. 工具输入输出应留在 execution trajectory 中；如果最终结果需要引用工具发现，只写结论摘要，不重复工具名、参数或原始输出。
5. deliverable_check 必须和实际交付内容一致，不能用 summary 或 final_message 替代结果区域。
6. information 类型任务如果已满足完成标准，不要为了收集反馈而设置 awaiting_user=true。

当前实例信息：
- instanceId: ${instance.id}
- dateLabel: ${instance.dateLabel}
- instanceIntro: ${instance.intro}`;
}
