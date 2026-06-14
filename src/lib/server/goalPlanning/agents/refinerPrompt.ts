import type { CriticDecisionPayload } from "@/lib/server/goalPlanning/topicInitSaga";

export type BuildTopicPlanRefinerPromptInput = {
  topicText: string;
  currentPlan: Record<string, unknown>;
  criticDecision: CriticDecisionPayload;
  conversationContext?: string;
  userContext?: Record<string, unknown>;
};

export function buildTopicPlanRefinerPrompt(input: BuildTopicPlanRefinerPromptInput) {
  return [
    "你是 Topic 初始化 Saga 的 Refiner 修正角色。",
    "Critic 已标记当前 Planner 草稿需要修正，请基于评审意见输出修正后的计划 JSON。",
    "",
    "硬性输出要求：",
    "1. 只能输出一个严格合法的 JSON 对象，禁止 Markdown、代码块、解释、前后缀文本。",
    "2. 优先保留 Planner 原 schema；如果当前计划使用 subGoals，就继续输出 subGoals；如果使用 threads，就继续输出 threads。",
    "3. 必须保留用户目标的核心意图，不得把计划改写成与 Topic 无关的内容。",
    "4. 只修正规划结构、任务种子、风险、执行顺序等决策层字段；不要输出展示文案、通知文案或虚构 deadline。",
    "5. 可以输出完整计划，也可以输出包含被修正顶层字段的局部计划；但必须包含非空 subGoals 或非空 threads。",
    "6. payload 必须控制在 8KB 以内。",
    "",
    "Topic：",
    input.topicText,
    "",
    "Conversation Context：",
    input.conversationContext?.trim() || "(none)",
    "",
    "User Context：",
    JSON.stringify(input.userContext ?? {}, null, 2),
    "",
    "Critic 决策：",
    JSON.stringify(input.criticDecision, null, 2),
    "",
    "当前 Planner 草稿：",
    JSON.stringify(input.currentPlan, null, 2),
    "",
    "修正重点：",
    "- 优先响应 Critic notes 中指出的缺口。",
    "- 补齐过粗、重复、遗漏或不可执行的 Thread/Task。",
    "- 保持 Thread 数量克制，避免制造空洞任务。",
    "- Task 必须是真正执行单元，包含 title/description/expectedOutcome/taskType/triggerRule 等关键字段。",
    "- 如果 Task 需要等待其他 Task 的产出，必须在 dependencies 中写被依赖任务的 id 或 title；不要只写在 triggerRule 文案里。",
    "- 如果 triggerRule 包含“已确认/已锁定/已预订/已交付/已反馈/完成后”等前置语义，请同步补齐 dependencies。",
    "",
    "现在只输出修正后的 JSON 对象：",
  ].join("\n");
}

export function validateRefinedTopicPlan(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("refiner 输出不是 JSON 对象");
  }

  const hasSubGoals = Object.prototype.hasOwnProperty.call(value, "subGoals");
  const hasThreads = Object.prototype.hasOwnProperty.call(value, "threads");
  if (!hasSubGoals && !hasThreads) {
    throw new Error("refiner 输出缺少 subGoals 或 threads");
  }

  if (hasSubGoals && !isNonEmptyArray(value.subGoals)) {
    throw new Error("refiner 输出 subGoals 不是非空数组");
  }
  if (hasThreads && !isNonEmptyArray(value.threads)) {
    throw new Error("refiner 输出 threads 不是非空数组");
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyArray(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}
