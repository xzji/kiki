import type { TaskPriority } from "@/types/kiki";
import type { TaskDraft } from "./taskDraftSchema";

export type DecompositionSubGoalContext = {
  id: number;
  name: string;
  description: string;
  criteria: string[];
  priority?: TaskPriority;
};

/**
 * @deprecated 旧版本 review 输出，包含 reasoning/suggestions 等长字段，易在 token 上限处被截断。
 * 新链路使用 TaskDraftReviewDecisionPayload；此类型仅保留用于 legacy checkpoint 兼容。
 */
export type TaskDraftReviewPayload = {
  reviewResults: Array<{
    taskId: string;
    goalContribution: TaskPriority;
    subGoalContribution: TaskPriority;
    aligned: boolean;
    reasoning: string;
    suggestions?: string[];
  }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Decision Layer：极小 JSON 输出，仅包含枚举/布尔/短 ID，几乎无截断风险。
// 与 Presentation Layer 解耦——长篇解释由独立的 plain text 通道异步生成。
// ─────────────────────────────────────────────────────────────────────────────

export type TaskDraftReviewDecision = {
  taskId: string;
  aligned: boolean;
  goalContribution: TaskPriority;
  subGoalContribution: TaskPriority;
};

export type TaskDraftReviewDecisionPayload = {
  results: TaskDraftReviewDecision[];
  /** 仅当走保守降级时为 true，业务逻辑不读，仅供 telemetry/dogfooding 复盘 grep。 */
  _degraded?: boolean;
};

/**
 * @deprecated 旧版 review prompt，输出体积大、易截断。新链路请使用 buildTaskDraftReviewDecisionPrompt。
 */
export function buildTaskDraftReviewPrompt(input: {
  goalTitle: string;
  subGoalTitle: string;
  goalDescription: string;
  drafts: TaskDraft[];
}) {
  return `请 Review 以下 TaskDraft 是否与目标和子目标对齐。

目标：${input.goalTitle}
子目标：${input.subGoalTitle}
目标描述：${input.goalDescription}

TaskDraft：
${JSON.stringify(input.drafts.map((draft, index) => ({ index: draft.index ?? index + 1, ...draft })), null, 2)}

要求：
1. 只能输出严格 JSON 对象，不要包含 Markdown、代码块或额外解释。
2. reviewResults 必须覆盖每个 TaskDraft，taskId 使用 TaskDraft 的 index 字符串。
3. goalContribution/subGoalContribution 只能是 critical/high/medium/low。

JSON schema：
{
  "reviewResults": [
    {
      "taskId": "1",
      "goalContribution": "high",
      "subGoalContribution": "high",
      "aligned": true,
      "reasoning": "评估理由",
      "suggestions": ["建议"]
    }
  ]
}`;
}

/**
 * 决策层 prompt：仅要求模型输出极简枚举/布尔结果，不允许 reasoning/suggestions/explanation。
 * 通过软约束限制输出长度，配合 Decision schema 简化，把 token 截断概率降到接近 0。
 */
export function buildTaskDraftReviewDecisionPrompt(input: {
  goalTitle: string;
  subGoalTitle: string;
  goalDescription: string;
  drafts: TaskDraft[];
}) {
  const draftsBrief = input.drafts.map((draft, index) => ({
    index: draft.index ?? index + 1,
    title: draft.title,
    objective: draft.objective,
    deliverable: draft.deliverable,
  }));
  return `你是一个对齐度评估器。请只输出极简 JSON 决策结果，不要任何解释。

目标：${input.goalTitle}
子目标：${input.subGoalTitle}
目标描述：${input.goalDescription}

TaskDraft（仅 title/objective/deliverable）：
${JSON.stringify(draftsBrief, null, 2)}

要求：
1. 只能输出严格 JSON 对象。禁止 Markdown、代码块、reasoning、suggestions、explanation 字段。
2. results 必须覆盖每个 TaskDraft，taskId 使用 TaskDraft 的 index 字符串。
3. aligned: boolean；goalContribution / subGoalContribution: "critical" | "high" | "medium" | "low"。
4. 输出限制：本次回复必须 ≤ 50 行、≤ 2000 字符；只输出 results 数组的极简 JSON。

JSON schema：
{
  "results": [
    { "taskId": "1", "aligned": true, "goalContribution": "high", "subGoalContribution": "high" }
  ]
}`;
}

/**
 * 展示层 prompt：plain markdown 文本，给用户看的解释，**不输出 JSON**。
 * 失败/超时不影响主链路。
 */
export function buildTaskDraftReviewPresentationPrompt(input: {
  goalTitle: string;
  subGoalTitle: string;
  goalDescription: string;
  drafts: TaskDraft[];
  decision: TaskDraftReviewDecisionPayload;
}) {
  const decisionMap = new Map(input.decision.results.map((item) => [item.taskId, item]));
  const taskLines = input.drafts.map((draft, index) => {
    const id = String(draft.index ?? index + 1);
    const dec = decisionMap.get(id);
    return `- Task ${id}：${draft.title}（aligned=${dec?.aligned ?? "?"}, goalContribution=${dec?.goalContribution ?? "?"}, subGoalContribution=${dec?.subGoalContribution ?? "?"}）`;
  });
  return `请基于以下 TaskDraft 与已经做出的对齐度判断，用中文写一段简洁的 markdown 解释，给用户阅读。
不要输出 JSON、代码块或字段名。每个 task 用 ## 二级标题，下面写"评估理由"与"改进建议"两段，每段不超过 200 字。

目标：${input.goalTitle}
子目标：${input.subGoalTitle}
目标描述：${input.goalDescription}

TaskDraft 列表与判断：
${taskLines.join("\n")}

只输出 markdown 文本。`;
}

export function validateTaskReviewDecision(value: unknown): TaskDraftReviewDecisionPayload {
  if (!isObject(value)) {
    throw new Error("review 决策结果不是 JSON 对象");
  }
  // 优先读新字段 results；兼容旧字段 reviewResults（dual-key 读取，§8.2）
  const rawResults = Array.isArray(value.results)
    ? value.results
    : Array.isArray(value.reviewResults)
      ? value.reviewResults
      : null;
  if (!rawResults) {
    throw new Error("review 决策结果缺少 results");
  }
  const results: TaskDraftReviewDecision[] = rawResults
    .filter(isObject)
    .map((item) => ({
      taskId: typeof item.taskId === "string" ? item.taskId.trim() : "",
      aligned: Boolean(item.aligned),
      goalContribution: normalizePriority(item.goalContribution),
      subGoalContribution: normalizePriority(item.subGoalContribution),
    }))
    .filter((item) => item.taskId);
  return { results };
}

/** 当决策层失败时返回的保守降级 payload：默认全部对齐、贡献度 medium。 */
export function buildDegradedReviewDecision(drafts: TaskDraft[]): TaskDraftReviewDecisionPayload {
  return {
    results: drafts.map((draft, index) => ({
      taskId: String(draft.index ?? index + 1),
      aligned: true,
      goalContribution: "medium",
      subGoalContribution: "medium",
    })),
    _degraded: true,
  };
}

/**
 * dual-key 适配：从新版 results 或旧版 reviewResults 中读取项数组。
 * 1 周后 dogfooding 稳定时移除旧路径。
 */
function readReviewItems(
  review: TaskDraftReviewDecisionPayload | TaskDraftReviewPayload,
): Array<{ taskId: string; aligned: boolean; goalContribution: TaskPriority; subGoalContribution: TaskPriority }> {
  if ("results" in review && Array.isArray(review.results)) {
    return review.results;
  }
  if ("reviewResults" in review && Array.isArray(review.reviewResults)) {
    return review.reviewResults.map((item) => ({
      taskId: item.taskId,
      aligned: item.aligned,
      goalContribution: item.goalContribution,
      subGoalContribution: item.subGoalContribution,
    }));
  }
  return [];
}

export function applyDraftReview(
  drafts: TaskDraft[],
  review: TaskDraftReviewDecisionPayload | TaskDraftReviewPayload,
) {
  const items = readReviewItems(review);
  const reviewMap = new Map(items.map((item) => [item.taskId, item]));
  const retained = drafts.filter((draft, index) => {
    const item = reviewMap.get(String(draft.index ?? index + 1));
    return !(item && !item.aligned && item.goalContribution === "low" && item.subGoalContribution === "low");
  });
  return retained.length > 0 ? retained : drafts.slice(0, 1);
}

/** 用于覆盖度告警；隐藏字段名差异，便于阶段 3 外推。 */
export function getReviewLowAlignmentCount(
  review: TaskDraftReviewDecisionPayload | TaskDraftReviewPayload,
): number {
  return readReviewItems(review).filter((item) => !item.aligned).length;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePriority(value: unknown): TaskPriority {
  if (value === "critical" || value === "high" || value === "medium") return value;
  return "low";
}
