import type { Goal, Task } from "@/types/kiki";
import type { Thread, ThreadLoopInterval } from "@/types/topic";

export type ParsedTaskTriggerTime = {
  hour: number;
  minute: number;
};

export type ParsedTaskTriggerRule =
  | { kind: "immediate" }
  | { kind: "condition"; condition: string }
  | { kind: "interval"; intervalMs: number; intervalHours: number }
  | { kind: "datetime"; at: Date }
  | { kind: "weekly"; time: ParsedTaskTriggerTime; weekdays: number[] }
  | { kind: "daily"; time: ParsedTaskTriggerTime }
  | { kind: "time"; time: ParsedTaskTriggerTime }
  | { kind: "unsupported" };

const TIME_PATTERN = /(?:^|[^\d])([01]?\d|2[0-3])[:：]([0-5]\d)(?:[^\d]|$)/;
const INTERVAL_HOURS_PATTERN = /每(?:隔)?\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|小時|h|H)/;
const CONDITION_PREFIX_PATTERN = /^满足触发条件(?:后)?执行[:：]?\s*/;
const IMMEDIATE_PATTERN = /^(立即触发|立即执行|准备好后执行一次|准备好后执行)$/;
const RELATIVE_DATE_TIME_PATTERN = /(今天|明天|后天)\s*([01]?\d|2[0-3])[:：]([0-5]\d)/;
const ABSOLUTE_DATE_TIME_PATTERN = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})(?:\s*日)?\s*([01]?\d|2[0-3])[:：]([0-5]\d)/;
const MONTH_DAY_TIME_PATTERN = /(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*([01]?\d|2[0-3])[:：]([0-5]\d)/;
const WEEKDAY_PATTERN = /(?:每周|周)([一二三四五六日天])/g;
const DAILY_PATTERN = /每天|每日|每早|每晚|每晨/;

function buildLocalDate(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function weekdayTokenToNumber(token: string) {
  if (token === "日" || token === "天") return 0;
  return ["一", "二", "三", "四", "五", "六"].indexOf(token) + 1;
}

function formatAbsoluteTriggerDateTime(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute} 触发`;
}

export function parseTaskTriggerTime(triggerRule: string): ParsedTaskTriggerTime | null {
  const match = triggerRule.match(TIME_PATTERN);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function hasConcreteTriggerTime(triggerRule: string) {
  return Boolean(parseTaskTriggerTime(triggerRule));
}

export function parseTaskTriggerInterval(triggerRule: string) {
  const match = triggerRule.match(INTERVAL_HOURS_PATTERN);
  if (!match) return null;
  const intervalHours = Number(match[1]);
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) return null;
  return {
    intervalHours,
    intervalMs: intervalHours * 60 * 60 * 1000,
  };
}

export function parseTaskTriggerDateTime(triggerRule: string, referenceDate = new Date()) {
  const normalized = triggerRule.trim();
  const absoluteMatch = normalized.match(ABSOLUTE_DATE_TIME_PATTERN);
  if (absoluteMatch) {
    return buildLocalDate(
      Number(absoluteMatch[1]),
      Number(absoluteMatch[2]),
      Number(absoluteMatch[3]),
      Number(absoluteMatch[4]),
      Number(absoluteMatch[5]),
    );
  }
  const monthDayMatch = normalized.match(MONTH_DAY_TIME_PATTERN);
  if (monthDayMatch) {
    return buildLocalDate(
      referenceDate.getFullYear(),
      Number(monthDayMatch[1]),
      Number(monthDayMatch[2]),
      Number(monthDayMatch[3]),
      Number(monthDayMatch[4]),
    );
  }
  const relativeMatch = normalized.match(RELATIVE_DATE_TIME_PATTERN);
  if (!relativeMatch) return null;
  const offset = relativeMatch[1] === "明天" ? 1 : relativeMatch[1] === "后天" ? 2 : 0;
  const date = new Date(referenceDate);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  date.setHours(Number(relativeMatch[2]), Number(relativeMatch[3]), 0, 0);
  return date;
}

function parseTaskTriggerWeekdays(triggerRule: string) {
  const matches = Array.from(triggerRule.matchAll(WEEKDAY_PATTERN));
  if (matches.length === 0) return [];
  return Array.from(new Set(matches.map((match) => weekdayTokenToNumber(match[1]))));
}

export function parseTaskTriggerRule(triggerRule: string, referenceDate = new Date()): ParsedTaskTriggerRule {
  const normalized = triggerRule.trim();
  if (!normalized || IMMEDIATE_PATTERN.test(normalized)) return { kind: "immediate" };
  const condition = normalized.match(CONDITION_PREFIX_PATTERN);
  if (condition) {
    return {
      kind: "condition",
      condition: normalized.replace(CONDITION_PREFIX_PATTERN, "").trim(),
    };
  }
  const interval = parseTaskTriggerInterval(normalized);
  if (interval) return { kind: "interval", ...interval };
  const dateTime = parseTaskTriggerDateTime(normalized, referenceDate);
  if (dateTime) return { kind: "datetime", at: dateTime };
  const time = parseTaskTriggerTime(normalized);
  if (time) {
    const weekdays = parseTaskTriggerWeekdays(normalized);
    if (weekdays.length > 0) return { kind: "weekly", time, weekdays };
    if (DAILY_PATTERN.test(normalized)) return { kind: "daily", time };
    return { kind: "time", time };
  }
  return { kind: "unsupported" };
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
  const parsed = parseTaskTriggerRule(normalized);
  if (parsed.kind === "datetime") return formatAbsoluteTriggerDateTime(parsed.at);
  if (parsed.kind === "condition" || parsed.kind === "interval" || parsed.kind === "weekly") return normalized;
  if (hasConcreteTriggerTime(normalized)) return normalized;
  if (taskType === "one_shot") return normalized;
  return formatRecurringRule(normalized, inferDefaultRecurringTime(normalized));
}

function latestInstanceTime(task: Task) {
  const times = task.instances
    .map((instance) => new Date(instance.createdAt).getTime())
    .filter((time) => Number.isFinite(time));
  return times.length > 0 ? Math.max(...times) : undefined;
}

function hasInstanceOnDay(task: Task, date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const label = `${month}-${day}`;
  return task.instances.some((instance) => instance.dateLabel === label);
}

export function isTaskTriggerDue(task: Task, now: Date) {
  const parsed = parseTaskTriggerRule(task.triggerRule, now);
  if (task.taskType === "one_shot") {
    if (task.instances.length > 0) return false;
    if (parsed.kind === "condition" || parsed.kind === "unsupported" || parsed.kind === "interval") return false;
    if (parsed.kind === "datetime") return now.getTime() >= parsed.at.getTime();
    if (parsed.kind === "time" || parsed.kind === "daily") {
      const due = new Date(now);
      due.setHours(parsed.time.hour, parsed.time.minute, 0, 0);
      return now.getTime() >= due.getTime();
    }
    if (parsed.kind === "weekly") {
      if (!parsed.weekdays.includes(now.getDay())) return false;
      const due = new Date(now);
      due.setHours(parsed.time.hour, parsed.time.minute, 0, 0);
      return now.getTime() >= due.getTime();
    }
    return parsed.kind === "immediate";
  }

  if (parsed.kind === "condition" || parsed.kind === "unsupported") return false;
  if (parsed.kind === "interval") {
    const latest = latestInstanceTime(task);
    return latest === undefined || now.getTime() - latest >= parsed.intervalMs;
  }
  if (parsed.kind === "datetime") {
    return task.instances.length === 0 && now.getTime() >= parsed.at.getTime();
  }
  if (parsed.kind === "weekly") {
    if (!parsed.weekdays.includes(now.getDay())) return false;
    if (hasInstanceOnDay(task, now)) return false;
    const due = new Date(now);
    due.setHours(parsed.time.hour, parsed.time.minute, 0, 0);
    return now.getTime() >= due.getTime();
  }
  if (parsed.kind === "time" || parsed.kind === "daily") {
    if (hasInstanceOnDay(task, now)) return false;
    const due = new Date(now);
    due.setHours(parsed.time.hour, parsed.time.minute, 0, 0);
    return now.getTime() >= due.getTime();
  }
  return false;
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

// ---------------------------------------------------------------------------
// Thread loopInterval 解析（计划 §3.4.5）
// ---------------------------------------------------------------------------

/**
 * Thread.loopInterval 的解析结果。
 *
 * 设计要点：
 *  - "realtime" 当前以 1 分钟节拍占位实现，本期不真实启用秒级心跳（计划 §3.4.5）。
 *  - "cron" 仅透传表达式，由 ThreadLoopWorker 调用现成 cron 解析器决定下一次时间。
 *  - "one_shot" 没有节拍，触发一次后由 ThreadRunner 显式置 thread.status = "archived"
 *    或 "paused"，computeNextTickAt 返回 null。
 */
export type ParsedThreadLoopInterval =
  | { kind: "realtime"; intervalMs: number }
  | { kind: "hourly"; intervalMs: number }
  | { kind: "daily"; intervalMs: number }
  | { kind: "weekly"; intervalMs: number }
  | { kind: "cron"; expr: string }
  | { kind: "one_shot" };

const THREAD_LOOP_INTERVAL_REALTIME_MS = 60_000;
const THREAD_LOOP_INTERVAL_HOURLY_MS = 60 * 60_000;
const THREAD_LOOP_INTERVAL_DAILY_MS = 24 * THREAD_LOOP_INTERVAL_HOURLY_MS;
const THREAD_LOOP_INTERVAL_WEEKLY_MS = 7 * THREAD_LOOP_INTERVAL_DAILY_MS;

export function parseThreadLoopInterval(li: ThreadLoopInterval): ParsedThreadLoopInterval {
  if (typeof li === "string") {
    switch (li) {
      case "realtime":
        return { kind: "realtime", intervalMs: THREAD_LOOP_INTERVAL_REALTIME_MS };
      case "hourly":
        return { kind: "hourly", intervalMs: THREAD_LOOP_INTERVAL_HOURLY_MS };
      case "daily":
        return { kind: "daily", intervalMs: THREAD_LOOP_INTERVAL_DAILY_MS };
      case "weekly":
        return { kind: "weekly", intervalMs: THREAD_LOOP_INTERVAL_WEEKLY_MS };
      case "one_shot":
        return { kind: "one_shot" };
    }
    // 运行期数据脏化（脱离类型保证）→ 兜底为 one_shot，避免静默走入 cron 分支。
    return { kind: "one_shot" };
  }
  if (li && typeof li === "object" && (li as { kind?: string }).kind === "cron") {
    const expr = typeof li.expr === "string" ? li.expr.trim() : "";
    return { kind: "cron", expr };
  }
  return { kind: "one_shot" };
}

/**
 * 计算 Thread 的下一次 tick 时间。
 *
 * 规则：
 *  - one_shot：返回 null（永不再触发）。
 *  - cron：返回 null（cron 解析交给 ThreadLoopWorker 的专用 cron 库；
 *    本函数仅承担固定间隔类型）。
 *  - 固定间隔：以 `thread.lastTickAt` 为锚点累加 intervalMs；缺失 lastTickAt
 *    时直接返回 now（首次触发立即生效）。
 *  - 若 lastTickAt + interval 仍 ≤ now（追赶场景），跳到 now 之后的最近一格，
 *    避免 worker 单帧内连续触发同 Thread。
 */
export function computeNextTickAt(thread: Thread, now: Date): Date | null {
  const parsed = parseThreadLoopInterval(thread.loopInterval);
  if (parsed.kind === "one_shot" || parsed.kind === "cron") {
    return null;
  }
  const intervalMs = parsed.intervalMs;
  if (!thread.lastTickAt) {
    return new Date(now.getTime());
  }
  const last = new Date(thread.lastTickAt);
  if (Number.isNaN(last.getTime())) {
    return new Date(now.getTime());
  }
  const elapsed = now.getTime() - last.getTime();
  // 找到 lastTickAt 之后第一个严格 > now 的 tick：
  //   N = floor(elapsed / intervalMs) + 1，结果 = last + N * intervalMs。
  // 当 last 在未来（elapsed < 0），N 退化为 0 或负数；统一兜底为 1，避免返回 ≤ now。
  const slotsAhead = Math.max(1, Math.floor(elapsed / intervalMs) + 1);
  return new Date(last.getTime() + slotsAhead * intervalMs);
}
