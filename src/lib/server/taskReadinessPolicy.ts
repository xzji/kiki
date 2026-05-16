import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";

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

export function buildTaskReadinessCheck(input: TaskReadinessInput): TaskReadinessCheck {
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
      options: ["上海出发（航班多）", "广州出发（华南方便）", "北京出发（北方方便）"],
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
      options: ["周末短途（2-3天）", "工作日错峰（更便宜）", "节假日出行（需早订）"],
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
      options: ["经济优先（少花钱）", "性价比优先（均衡）", "舒适优先（体验好）"],
    });
  }

  return finalizeReadiness(items);
}
