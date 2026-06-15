import type { Goal, SubGoal, Task, TaskInstance, TaskRequiredUserInput } from "@/types/kiki";

export type TaskReadinessInfoStatus = "available" | "missing_user" | "agent_retrievable" | "not_required";

export type TaskReadinessInfoItem = {
  id: string;
  label: string;
  description: string;
  source: "user" | "agent" | "system";
  status: TaskReadinessInfoStatus;
  reason: string;
  value?: string;
  options?: string[];
  optionQuestion?: string;
  inputPlaceholder?: string;
  inputKind?: "text" | "image" | "file" | "image_or_text";
};

export type TaskReadinessCheck = {
  status: "ready" | "blocked";
  generatedAt: string;
  summary: string;
  items: TaskReadinessInfoItem[];
  missingUserInfo: TaskReadinessInfoItem[];
  agentRetrievableInfo: TaskReadinessInfoItem[];
  availableInfo: TaskReadinessInfoItem[];
};

type TaskReadinessInput = {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  resumeContext?: string;
};

function taskExecutionText(input: TaskReadinessInput) {
  return [
    input.goal.title,
    input.goal.summary,
    input.subGoal.title,
    input.task.title,
    input.task.description,
    input.task.executionObjective,
    input.task.expectedOutcome,
    input.task.expectedResult?.description,
    input.task.expectedResult?.completionCriteria,
    input.task.triggerRule,
    input.instance.intro,
    input.resumeContext,
  ].filter(Boolean).join("\n");
}

export function extractUserFeedback(input: Pick<TaskReadinessInput, "resumeContext">) {
  const match = input.resumeContext?.match(/用户反馈：([\s\S]+)/);
  const feedback = match?.[1]?.trim();
  if (!feedback) return "";
  if (/^(补充缺失信息|补充具体信息|补充约束或偏好|说明暂时无法提供|确认继续|补充更多信息|需要更多信息后再决定|需要更多时间考虑|都不是，我自己描述)$/.test(feedback)) return "";
  return feedback;
}

function hasExplicitDepartureCity(input: TaskReadinessInput, text: string) {
  if (extractUserFeedback(input)) return true;
  return /出发城市[:：]\s*[\u4e00-\u9fa5A-Za-z]{2,20}|出发地[:：]\s*[\u4e00-\u9fa5A-Za-z]{2,20}|从[\u4e00-\u9fa5A-Za-z]{2,20}(?:出发|飞)|[\u4e00-\u9fa5A-Za-z]{2,20}出发/.test(text);
}

function hasDateValue(text: string) {
  return /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|(?:明天|后天|下周|本周|周[一二三四五六日天])/.test(text);
}

function hasBudgetValue(input: TaskReadinessInput, text: string) {
  if (/\d+\s*(元|块|人民币|rmb|¥)/i.test(text)) return true;
  if (/(暂不|暂时不|不|无|无需|无需要|没有|不设).{0,4}(限制|预算|上限|要求)/.test(text)) return true;
  if (/(任意|任何|无|没有).{0,4}预算/.test(text)) return true;
  if (/(性价比|按.{0,4}性价比|性价比.{0,4}优先)/.test(text)) return true;
  const feedback = extractUserFeedback(input);
  if (feedback && /预算/.test(feedback)) return true;
  return false;
}

export function finalizeReadiness(items: TaskReadinessInfoItem[]): TaskReadinessCheck {
  const missingUserInfo = items.filter((item) => item.status === "missing_user" && item.source === "user");
  const agentRetrievableInfo = items.filter((item) => item.status === "agent_retrievable");
  const availableInfo = items.filter((item) => item.status === "available");
  return {
    status: missingUserInfo.length ? "blocked" : "ready",
    generatedAt: new Date().toISOString(),
    summary: missingUserInfo.length
      ? `缺少 ${missingUserInfo.map((item) => item.label).join("、")}，需要用户补充后才能执行。`
      : "执行当前任务所需的用户侧关键信息已具备。",
    items,
    missingUserInfo,
    agentRetrievableInfo,
    availableInfo,
  };
}

/**
 * 判定规划期固化的某个 requiredUserInput 字段是否已在任务上下文/用户反馈中得到满足。
 * - 已知字段（出发城市/出行日期/预算）复用专用启发式判据；
 * - 其它未知字段使用通用启发式：仅当出现「字段名: 值」或用户反馈明确提及时才判为已满足，
 *   否则保持 missing_user 交给语义 judge 二次裁决。
 */
function matchesKnownField(field: TaskRequiredUserInput, keywords: { en: string[]; zh: string[] }): boolean {
  const id = field.id.toLowerCase();
  // 英文按词边界拆分，避免子串误命中（如 "target_candidates" 含 "date"）。
  const idTokens = id.split(/[^a-z0-9]+/).filter(Boolean);
  if (idTokens.some((token) => keywords.en.includes(token))) return true;
  // 中文关键词对 id 与 label 做包含匹配。
  const haystack = `${id}${field.label}`;
  return keywords.zh.some((keyword) => haystack.includes(keyword));
}

function isRequiredInputSatisfied(
  input: TaskReadinessInput,
  field: TaskRequiredUserInput,
  text: string,
): boolean {
  if (matchesKnownField(field, { en: ["departure"], zh: ["出发", "出发城市", "出发地"] })) {
    return hasExplicitDepartureCity(input, text);
  }
  if (matchesKnownField(field, { en: ["date", "dates", "travel_dates"], zh: ["日期", "出行时间", "行程时间"] })) {
    return hasDateValue(text);
  }
  if (matchesKnownField(field, { en: ["budget", "price"], zh: ["预算", "费用"] })) {
    return hasBudgetValue(input, text);
  }

  const feedback = extractUserFeedback(input);
  const label = field.label.trim();
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 跨字段共享同一段 feedback，仅按字段自身 label 判定；不再用通用 options token（如「北京/海岛」）匹配，
  // 避免甲字段的答案误命中乙字段。无法据 label 判定的，保持 missing 交语义 judge 二次裁决。
  if (feedback && label.length >= 2 && escapedLabel) {
    if (new RegExp(`${escapedLabel}\\s*[：:]\\s*\\S+`).test(feedback)) return true;
    if (feedback.includes(label)) return true;
  }
  if (escapedLabel && new RegExp(`${escapedLabel}[：:]\\s*\\S+`).test(text)) return true;
  return false;
}

function extractFieldValue(field: TaskRequiredUserInput, feedback: string, singleField: boolean): string | undefined {
  if (!feedback) return undefined;
  const escapedLabel = field.label.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (escapedLabel) {
    const match = feedback.match(new RegExp(`${escapedLabel}\\s*[：:]\\s*(\\S[^|\\n]*)`));
    if (match?.[1]) return match[1].trim();
  }
  // 仅有单个字段时，整段反馈可无歧义地归属该字段；多字段时不臆测归属。
  return singleField ? feedback : undefined;
}

function buildReadinessFromRequiredInputs(
  input: TaskReadinessInput,
  fields: TaskRequiredUserInput[],
): TaskReadinessCheck {
  const text = taskExecutionText(input);
  const userFeedback = extractUserFeedback(input);
  const items: TaskReadinessInfoItem[] = [];
  const uniqueFields = fields.filter((field, index) => fields.findIndex((f) => f.id === field.id) === index);
  for (const field of uniqueFields) {
    const available = isRequiredInputSatisfied(input, field, text);
    items.push({
      id: field.id,
      label: field.label,
      description: field.description || field.satisfiedHint || `执行前需要用户提供「${field.label}」。`,
      source: "user",
      status: available ? "available" : "missing_user",
      reason: available
        ? "已在任务上下文或用户反馈中找到该信息。"
        : field.satisfiedHint
          ? `这是用户个人信息，Agent 不能自行猜测。满足判据：${field.satisfiedHint}`
          : "这是用户个人信息，Agent 不能自行猜测或默认选择。",
      value: available ? extractFieldValue(field, userFeedback, uniqueFields.length === 1) : undefined,
      optionQuestion: field.question,
      options: field.options,
      inputPlaceholder: field.inputPlaceholder,
      inputKind: field.inputKind,
    });
  }
  return finalizeReadiness(items);
}

export function buildTaskReadinessCheck(input: TaskReadinessInput): TaskReadinessCheck {
  // 优先使用规划期固化的字段清单（新任务）；缺失时回退到执行期正则枚举（旧任务）。
  if (input.task.requiredUserInputs?.length) {
    return buildReadinessFromRequiredInputs(input, input.task.requiredUserInputs);
  }
  const text = taskExecutionText(input);
  const items: TaskReadinessInfoItem[] = [];
  const addItem = (item: TaskReadinessInfoItem) => {
    if (!items.some((entry) => entry.id === item.id)) items.push(item);
  };

  if (/航班|机票|飞往|往返|出发城市|出发地|从哪个城市|哪里出发/.test(text)) {
    const userFeedback = extractUserFeedback(input);
    const available = hasExplicitDepartureCity(input, text);
    addItem({
      id: "departure_city",
      label: "出发城市",
      description: "查询航班和价格必须先知道用户从哪个城市出发。",
      source: "user",
      status: available ? "available" : "missing_user",
      reason: available ? "已在任务上下文或用户反馈中找到出发城市。" : "这是用户个人行程信息，Agent 不能自行猜测或默认选择。",
      value: userFeedback || undefined,
      optionQuestion: "你打算从哪个城市出发？",
      options: ["北京", "上海", "广州"],
      inputPlaceholder: "请输入城市名，如 成都",
    });
    addItem({
      id: "flight_inventory",
      label: "航班时刻与价格",
      description: "可在具备出发城市、目的地和日期后由 Agent 查询。",
      source: "agent",
      status: "agent_retrievable",
      reason: "属于公开或可检索信息，不需要用户手动提供。",
    });
  }

  if (/出发日期|返回日期|往返日期|旅行日期|行程时间/.test(text)) {
    addItem({
      id: "travel_dates",
      label: "出行日期",
      description: "查询交通、住宿或行程安排需要明确日期范围。",
      source: "user",
      status: hasDateValue(text) ? "available" : "missing_user",
      reason: hasDateValue(text) ? "已在任务上下文中找到日期。" : "日期属于用户行程约束，缺失时不能默认假设。",
      optionQuestion: "你计划什么时候出行？",
      options: ["本周内", "下周出发", "时间还未确定"],
      inputPlaceholder: "请输入日期或时间范围，如 6月10日-6月15日",
    });
  }

  if (/预算|价格上限|费用上限|人均|总价/.test(text)) {
    const budgetAvailable = hasBudgetValue(input, text);
    addItem({
      id: "budget_constraint",
      label: "预算约束",
      description: "涉及筛选或推荐时需要知道预算边界。",
      source: "user",
      status: budgetAvailable ? "available" : "missing_user",
      reason: budgetAvailable ? "已在任务上下文或用户反馈中找到预算信息。" : "预算是用户偏好，Agent 不能自行假设。",
      optionQuestion: "这次预算大概是什么范围？",
      options: ["3000 元以内", "3000-8000 元", "不设明确上限"],
      inputPlaceholder: "请输入预算范围，如 人均 5000 元",
    });
  }

  return finalizeReadiness(items);
}
