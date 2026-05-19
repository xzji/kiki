import type { Goal, Task } from "@/types/kiki";

export type ParsedTaskTriggerTime = {
  hour: number;
  minute: number;
};

const TIME_PATTERN = /(?:^|[^\d])([01]?\d|2[0-3])[:：]([0-5]\d)(?:[^\d]|$)/;

export function parseTaskTriggerTime(triggerRule: string): ParsedTaskTriggerTime | null {
  const match = triggerRule.match(TIME_PATTERN);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function hasConcreteTriggerTime(triggerRule: string) {
  return Boolean(parseTaskTriggerTime(triggerRule));
}

function inferDefaultRecurringTime(triggerRule: string) {
  if (/凌晨|清晨/.test(triggerRule)) return "06:30";
  if (/出发前|早上|上午/.test(triggerRule)) return "07:30";
  if (/中午|午间/.test(triggerRule)) return "12:00";
  if (/下午/.test(triggerRule)) return "15:00";
  if (/晚|睡前|复盘/.test(triggerRule)) return "21:00";
  return "09:00";
}

function formatRecurringRule(triggerRule: string, time: string) {
  const normalized = triggerRule.trim();
  const prefix = /每周|周[一二三四五六日天]/.test(normalized)
    ? normalized.replace(/固定时间|触发|执行/g, "").trim()
    : normalized.includes("每天") || normalized.includes("每日")
      ? "每天"
      : "每天";
  const reason = /出发前/.test(normalized) ? "（默认出发前检查）" : "（默认时间）";
  return `${prefix} ${time} 触发${reason}`;
}

export function normalizeConcreteTriggerRule(
  triggerRule: string,
  taskType: Task["taskType"],
) {
  const normalized = triggerRule.trim();
  if (!normalized) return taskType === "one_shot" ? "立即触发" : "每天 09:00 触发（默认时间）";
  if (hasConcreteTriggerTime(normalized)) return normalized;
  if (taskType === "one_shot") return normalized;
  return formatRecurringRule(normalized, inferDefaultRecurringTime(normalized));
}

export function normalizeGoalTriggerRules(goal: Goal): Goal {
  return {
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      tasks: subGoal.tasks.map((task) => ({
        ...task,
        triggerRule: normalizeConcreteTriggerRule(task.triggerRule, task.taskType),
      })),
    })),
  };
}
