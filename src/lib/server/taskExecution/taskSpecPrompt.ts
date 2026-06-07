import type { TaskCollaborationRequirements, TaskExpectedResult } from "@/types/kiki";

export type SpecWriterTaskInput = {
  taskId: string;
  title: string;
  description: string;
  expectedOutcome: string;
  taskType: "repeat" | "one_shot";
  triggerRule?: string;
  expectedResult?: TaskExpectedResult;
  collaboration?: TaskCollaborationRequirements;
};

export type SpecWriterGoalContext = {
  goalTitle: string;
  goalSummary?: string;
  subGoalTitle?: string;
};

function renderExpectedResult(expectedResult: TaskExpectedResult | undefined) {
  if (!expectedResult) return "";
  const lines = [
    `- 预期结果类型：${expectedResult.type}`,
    `- 预期结果描述：${expectedResult.description}`,
    `- 格式：${expectedResult.format}`,
  ];
  if (expectedResult.surfaces?.length) lines.push(`- 结果呈现区域：${expectedResult.surfaces.join(", ")}`);
  if (expectedResult.primaryFormat) lines.push(`- 主格式：${expectedResult.primaryFormat}`);
  if (expectedResult.presentation) lines.push(`- 展示形态：${expectedResult.presentation}`);
  if (expectedResult.requiredBlocks?.length) {
    lines.push(`- 必须包含内容块：${expectedResult.requiredBlocks.join(", ")}`);
  }
  if (expectedResult.completionCriteria) {
    lines.push(`- 系统完成标准（SSOT）：${expectedResult.completionCriteria}`);
  }
  return lines.join("\n");
}

function renderCollaboration(collaboration: TaskCollaborationRequirements | undefined) {
  if (!collaboration) return "";
  return JSON.stringify(collaboration, null, 2);
}

function renderTask(task: SpecWriterTaskInput) {
  const contextSections = [
    `- 任务类型：${task.taskType}`,
    task.triggerRule ? `- 触发规则：${task.triggerRule}` : "",
    renderExpectedResult(task.expectedResult),
    renderCollaboration(task.collaboration)
      ? `- 协作要求：\n${renderCollaboration(task.collaboration)}`
      : "",
  ].filter(Boolean);

  return [
    `## Task ${task.taskId}`,
    `- taskId：${task.taskId}`,
    "- 任务主题：",
    `  - 标题：${task.title}`,
    `  - 描述：${task.description}`,
    `  - 预期产出：${task.expectedOutcome}`,
    "- 系统已确定的约束与上下文（权威，不可推翻）：",
    contextSections.length ? contextSections.join("\n") : "  - 无额外约束",
  ].join("\n");
}

export function buildTaskSpecPrompt(
  tasks: SpecWriterTaskInput[],
  goalContext: SpecWriterGoalContext,
) {
  return [
    "你是 KiKi 的任务规格设计师。你将收到一个任务列表，请对每个任务产出一份可被后台执行 Agent 直接消费的《任务内容规格》。",
    "只输出一个 JSON 对象，禁止 Markdown 代码块、解释、寒暄。",
    'JSON schema: { "specs": [{ "taskId": "string", "content": "Markdown 任务内容规格正文" }] }',
    "必须为每个输入 taskId 返回一条 specs；content 全文中文，不超过 800 字。",
    "",
    "# 目标上下文",
    `- 目标：${goalContext.goalTitle}`,
    goalContext.goalSummary ? `- 目标摘要：${goalContext.goalSummary}` : "",
    goalContext.subGoalTitle ? `- 子目标：${goalContext.subGoalTitle}` : "",
    "",
    "# 输入任务",
    tasks.map(renderTask).join("\n\n"),
    "",
    "# 每条 content 的生成规则",
    "你不是执行任务，而是把已规划出的任务定义扩写成任务内容要求。质量标准是：执行 Agent 仅凭你的规格（无需追问）就能产出与用户真实预期一致的结果。",
    "",
    "内部工作步骤（不要输出过程）：",
    "1. 意图还原：识别这个任务真正想要的结果。",
    "2. 任务分类：判断写作/编码/调研/分析/设计/运维/数据处理等类型，并按类型决定执行要求。",
    "3. 缺口识别：找出影响结果的关键变量。",
    "4. 缺口处理：非关键协作缺口给出合理默认假设；需用户提供的关键字段标注“执行时需向用户确认”。",
    "5. 边界界定：明确做什么和不做什么。",
    "6. 验收前置：只能细化系统给定 completionCriteria / requiredBlocks，不得新增、放宽或替换。",
    "",
    "每条 content 必须严格使用以下 Markdown 结构：",
    "## 任务目标",
    "- 一段话说明本任务最终要交付什么、解决什么问题。若为周期任务，说明每次执行交付什么。",
    "",
    "## 执行要求 / 步骤",
    "- 分点列出关键步骤或必须满足的要求。只写能改变执行 Agent 行为的方法与要点。",
    "",
    "## 范围",
    "- ✅ 包含：明确纳入的工作项",
    "- 🚫 不包含：明确排除、避免发散的部分",
    "",
    "## 交付物结构",
    "- 在系统已声明的产出呈现区域与格式之内，补充内容结构，不得另行指定文件格式或新增产出形态。",
    "",
    "## 验收标准（细化自系统完成标准）",
    "- 把 completionCriteria 细化为可 yes/no 判定的 checklist；requiredBlocks 必须逐项列入。",
    "",
    "## 关键假设",
    "- 列出所有假设；属于执行时需向用户确认的，单独标注。结尾提示：如有不符，请修正任务定义后重新执行。",
    "",
    "# 硬性规则",
    "- 自包含：不依赖未写明的信息。",
    "- 尊重权威：系统上下文为权威，规格只能细化，不可推翻或放宽。",
    "- 协作优先：需用户提供的关键输入不能用假设替代。",
    "- 可验证：目标与验收标准必须客观、可判定。",
    "- 不替执行：不要给最终答案/成品，不进行检索。",
    "- 适配类型：根据任务类型调整内容，不要千篇一律。",
  ].filter(Boolean).join("\n");
}
