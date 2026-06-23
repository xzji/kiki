import type { Goal, Task } from "@/types/kiki";
import type { Thread, ThreadLoopInterval } from "@/types/topic";
import { CronExpressionParser } from "cron-parser";
import { normalizeTriggerSpec, type TriggerSpec, type TriggerSpecInput } from "@/types/trigger";

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
const INTERVAL_HOURS_PATTERN = /每(?:隔)?\s*(\d+(?:\.\d+)?)?\s*(?:个)?\s*(?:小时|小時|h|H)/;
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
  const intervalHours = match[1] ? Number(match[1]) : 1;
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

function latestInstanceDate(task: Task) {
  const latest = latestInstanceTime(task);
  return latest === undefined ? null : new Date(latest);
}

function hasInstanceOnDay(task: Task, date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const label = `${month}-${day}`;
  return task.instances.some((instance) => instance.dateLabel === label);
}

function parseTimeOfDay(value: string | undefined): ParsedTaskTriggerTime {
  const match = value?.trim().match(/^([01]?\d|2[0-3])[:：]([0-5]\d)$/);
  if (!match) return { hour: 9, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function formatterForTimezone(timezone?: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function zonedParts(date: Date, timezone?: string) {
  const parts = formatterForTimezone(timezone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function zonedWeekday(date: Date, timezone?: string) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone ?? "UTC", weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

function zonedDateKey(date: Date, timezone?: string) {
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function getTimezoneOffsetMs(date: Date, timezone?: string) {
  if (!timezone) return 0;
  const parts = zonedParts(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(
  timezone: string | undefined,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  if (!timezone) return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  for (let i = 0; i < 3; i += 1) {
    guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0) - getTimezoneOffsetMs(guess, timezone));
  }
  return guess;
}

function addZonedDays(parts: ReturnType<typeof zonedParts>, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addZonedMonths(parts: ReturnType<typeof zonedParts>, months: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1, 12, 0, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function hasInstanceOnZonedDay(task: Task, date: Date, timezone?: string) {
  const key = zonedDateKey(date, timezone).slice(5);
  return task.instances.some((instance) => instance.dateLabel === key);
}

function cronNextAfter(spec: Extract<TriggerSpec, { kind: "cron" }>, after: Date): Date | null {
  try {
    return CronExpressionParser.parse(spec.expr, {
      currentDate: after,
      tz: spec.timezone,
    }).next().toDate();
  } catch {
    return null;
  }
}

function cronPreviousAtOrBefore(spec: Extract<TriggerSpec, { kind: "cron" }>, now: Date): Date | null {
  const anchor = new Date(now.getTime() + 1);
  try {
    const previous = CronExpressionParser.parse(spec.expr, {
      currentDate: anchor,
      tz: spec.timezone,
    }).prev().toDate();
    return previous.getTime() <= now.getTime() ? previous : null;
  } catch {
    return null;
  }
}

function fixedNextAfter(last: Date | null, now: Date, intervalMs: number) {
  if (!last || Number.isNaN(last.getTime())) return new Date(now.getTime());
  const elapsed = now.getTime() - last.getTime();
  const slotsAhead = Math.max(1, Math.floor(elapsed / intervalMs) + 1);
  return new Date(last.getTime() + slotsAhead * intervalMs);
}

function fixedPreviousDueAt(last: Date | null, now: Date, intervalMs: number) {
  if (!last || Number.isNaN(last.getTime())) return new Date(now.getTime());
  const elapsed = now.getTime() - last.getTime();
  if (elapsed < intervalMs) return null;
  const slots = Math.floor(elapsed / intervalMs);
  return new Date(last.getTime() + slots * intervalMs);
}

function monthlyNextAfter(
  spec: Extract<TriggerSpec, { kind: "monthly" }>,
  after: Date,
): Date | null {
  const timezone = spec.timezone;
  const time = parseTimeOfDay(spec.time ?? DEFAULT_SCHEDULE_TIME);
  const days = (spec.daysOfMonth?.length ? spec.daysOfMonth : [1])
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31)
    .sort((a, b) => a - b);
  if (days.length === 0) return null;
  const afterMs = after.getTime();
  const parts = zonedParts(after, timezone);
  for (let monthOffset = 0; monthOffset < 24; monthOffset += 1) {
    const ym = addZonedMonths(parts, monthOffset);
    const lastDay = lastDayOfMonth(ym.year, ym.month);
    for (const day of days) {
      const candidate = zonedDateTimeToUtc(timezone, ym.year, ym.month, Math.min(day, lastDay), time.hour, time.minute);
      if (candidate.getTime() > afterMs) return candidate;
    }
  }
  return null;
}

function dailyNextAfter(
  spec: Extract<TriggerSpec, { kind: "daily" }>,
  after: Date,
): Date | null {
  const time = parseTimeOfDay(spec.time ?? DEFAULT_SCHEDULE_TIME);
  const parts = zonedParts(after, spec.timezone);
  for (let dayOffset = 0; dayOffset < 370; dayOffset += 1) {
    const d = addZonedDays(parts, dayOffset);
    const candidate = zonedDateTimeToUtc(spec.timezone, d.year, d.month, d.day, time.hour, time.minute);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}

function weeklyNextAfter(
  spec: Extract<TriggerSpec, { kind: "weekly" }>,
  after: Date,
): Date | null {
  const weekdays = spec.weekdays?.length ? spec.weekdays : [1];
  const time = parseTimeOfDay(spec.time ?? DEFAULT_SCHEDULE_TIME);
  const parts = zonedParts(after, spec.timezone);
  for (let dayOffset = 0; dayOffset < 370; dayOffset += 1) {
    const d = addZonedDays(parts, dayOffset);
    const candidate = zonedDateTimeToUtc(spec.timezone, d.year, d.month, d.day, time.hour, time.minute);
    if (candidate.getTime() <= after.getTime()) continue;
    if (weekdays.includes(zonedWeekday(candidate, spec.timezone))) return candidate;
  }
  return null;
}

function isWithinPhaseWindow(phase: {
  start?: string;
  end?: string;
  timezone?: string;
  daysOfWeek?: number[];
  daysOfMonth?: number[];
  months?: number[];
}, now: Date, parentTimezone?: string) {
  const timezone = phase.timezone ?? parentTimezone;
  const parts = zonedParts(now, timezone);
  if (phase.months?.length && !phase.months.includes(parts.month)) return false;
  if (phase.daysOfMonth?.length && !phase.daysOfMonth.includes(parts.day)) return false;
  if (phase.daysOfWeek?.length && !phase.daysOfWeek.includes(zonedWeekday(now, timezone))) return false;
  const start = phase.start ? parseTimeOfDay(phase.start) : undefined;
  const end = phase.end ? parseTimeOfDay(phase.end) : undefined;
  const minuteOfDay = parts.hour * 60 + parts.minute;
  if (start) {
    const startMinute = start.hour * 60 + start.minute;
    if (minuteOfDay < startMinute) return false;
  }
  if (end) {
    const endMinute = end.hour * 60 + end.minute;
    if (minuteOfDay > endMinute) return false;
  }
  return true;
}

export function isTriggerSpecInPhasedWindow(spec: TriggerSpecInput, now: Date): boolean {
  const normalized = normalizeTriggerSpec(spec);
  if (!normalized) return true;
  if (normalized.kind === "phased") {
    return normalized.phases.some((phase) => isWithinPhaseWindow(phase, now, normalized.timezone));
  }
  if (normalized.kind === "composed") {
    const phaseChecks = normalized.triggers
      .filter((trigger) => trigger.kind === "phased")
      .map((trigger) => isTriggerSpecInPhasedWindow(trigger, now));
    return phaseChecks.length === 0 || phaseChecks.every(Boolean);
  }
  return true;
}

function triggerNextAfter(spec: TriggerSpec, after: Date): Date | null {
  switch (spec.kind) {
    case "immediate":
      return new Date(after.getTime());
    case "one_shot":
    case "event":
      return null;
    case "realtime":
      return new Date(after.getTime() + THREAD_LOOP_INTERVAL_REALTIME_MS);
    case "hourly":
      return new Date(after.getTime() + THREAD_LOOP_INTERVAL_HOURLY_MS);
    case "interval":
      return new Date(after.getTime() + spec.everyMs);
    case "daily":
      return dailyNextAfter(spec, after);
    case "weekly":
      return weeklyNextAfter(spec, after);
    case "monthly":
      return monthlyNextAfter(spec, after);
    case "cron":
      return cronNextAfter(spec, after);
    case "phased": {
      const candidates = spec.phases
        .filter((phase) => isWithinPhaseWindow(phase, after, spec.timezone))
        .map((phase) => triggerNextAfter(phase.trigger ?? { kind: "immediate" }, after))
        .filter((date): date is Date => Boolean(date));
      if (candidates.length > 0) return new Date(Math.min(...candidates.map((date) => date.getTime())));
      return nextPhaseWindowStart(spec, after);
    }
    case "composed": {
      const candidates = spec.triggers
        .map((trigger) => triggerNextAfter(trigger, after))
        .filter((date): date is Date => Boolean(date));
      if (candidates.length === 0) return null;
      return new Date(Math.min(...candidates.map((date) => date.getTime())));
    }
  }
}

function nextPhaseWindowStart(spec: Extract<TriggerSpec, { kind: "phased" }>, after: Date): Date | null {
  const candidates: Date[] = [];
  const base = zonedParts(after, spec.timezone);
  for (const phase of spec.phases) {
    const timezone = phase.timezone ?? spec.timezone;
    const start = parseTimeOfDay(phase.start ?? "00:00");
    for (let dayOffset = 0; dayOffset < 370; dayOffset += 1) {
      const d = addZonedDays(base, dayOffset);
      const candidate = zonedDateTimeToUtc(timezone, d.year, d.month, d.day, start.hour, start.minute);
      if (candidate.getTime() <= after.getTime()) continue;
      if (isWithinPhaseWindow({ ...phase, start: undefined, end: undefined }, candidate, spec.timezone)) {
        candidates.push(candidate);
        break;
      }
    }
  }
  return candidates.length > 0 ? new Date(Math.min(...candidates.map((date) => date.getTime()))) : null;
}

export function isTaskTriggerDue(task: Task, now: Date) {
  const structuredTrigger = normalizeTriggerSpec(task.trigger);
  if (structuredTrigger) {
    return isStructuredTaskTriggerDue(task, structuredTrigger, now);
  }

  const parsed = parseTaskTriggerRule(task.triggerRule, now);
  if (task.taskType === "one_shot") {
    if (task.instances.length > 0) return false;
    // interval 对 one_shot 无意义，直接不触发。
    if (parsed.kind === "interval") return false;
    // condition / unsupported 多为依赖驱动的自然语言触发（如「X 完成后立即触发」），
    // 无法解析为具体时间。对尚无实例的 one_shot，触发时机应交由调度器的依赖就绪判定
    // （resolveSchedulerDependencyReadiness）把关，而非在此被时间门永久拦死。
    if (parsed.kind === "condition" || parsed.kind === "unsupported") return true;
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

export function computeTaskNextTriggerAt(task: Task, after: Date): Date | null {
  if (task.taskType === "one_shot" && task.instances.length > 0) return null;
  if (isTaskTriggerDue(task, after)) return new Date(after.getTime());

  const structuredTrigger = normalizeTriggerSpec(task.trigger);
  if (structuredTrigger) {
    const latest = latestInstanceDate(task);
    if (!latest) return triggerNextAfter(structuredTrigger, after);
    if (
      structuredTrigger.kind === "realtime" ||
      structuredTrigger.kind === "hourly" ||
      structuredTrigger.kind === "interval"
    ) {
      return triggerNextAfter(structuredTrigger, latest);
    }
    return triggerNextAfter(structuredTrigger, after);
  }

  const parsed = parseTaskTriggerRule(task.triggerRule, after);
  if (task.taskType === "one_shot") {
    if (parsed.kind === "datetime") return parsed.at.getTime() > after.getTime() ? parsed.at : new Date(after.getTime());
    if (parsed.kind === "time" || parsed.kind === "daily") return nextDailyTriggerAfter(parsed.time, after);
    if (parsed.kind === "weekly") return nextWeeklyTriggerAfter(parsed.time, parsed.weekdays, after);
    if (parsed.kind === "immediate" || parsed.kind === "condition" || parsed.kind === "unsupported") {
      return new Date(after.getTime());
    }
    return null;
  }

  if (parsed.kind === "interval") {
    const latest = latestInstanceDate(task);
    return latest ? new Date(latest.getTime() + parsed.intervalMs) : new Date(after.getTime());
  }
  if (parsed.kind === "datetime") {
    return task.instances.length === 0 && parsed.at.getTime() > after.getTime() ? parsed.at : null;
  }
  if (parsed.kind === "time" || parsed.kind === "daily") return nextDailyTriggerAfter(parsed.time, after);
  if (parsed.kind === "weekly") return nextWeeklyTriggerAfter(parsed.time, parsed.weekdays, after);
  return null;
}

function nextDailyTriggerAfter(time: ParsedTaskTriggerTime, after: Date) {
  const candidate = new Date(after);
  candidate.setHours(time.hour, time.minute, 0, 0);
  if (candidate.getTime() <= after.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function nextWeeklyTriggerAfter(time: ParsedTaskTriggerTime, weekdays: number[], after: Date) {
  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const candidate = new Date(after);
    candidate.setDate(candidate.getDate() + dayOffset);
    candidate.setHours(time.hour, time.minute, 0, 0);
    if (candidate.getTime() > after.getTime() && weekdays.includes(candidate.getDay())) return candidate;
  }
  return null;
}

function isStructuredTaskTriggerDue(task: Task, spec: TriggerSpec, now: Date): boolean {
  const latest = latestInstanceTime(task);
  const oneShotAlreadyRan = task.taskType === "one_shot" && task.instances.length > 0;

  switch (spec.kind) {
    case "event":
      return false;
    case "one_shot":
      return task.instances.length === 0;
    case "immediate":
      return task.taskType === "one_shot" ? task.instances.length === 0 : latest === undefined;
    case "realtime":
      return !oneShotAlreadyRan && (latest === undefined || now.getTime() - latest >= THREAD_LOOP_INTERVAL_REALTIME_MS);
    case "hourly":
      return !oneShotAlreadyRan && (latest === undefined || now.getTime() - latest >= THREAD_LOOP_INTERVAL_HOURLY_MS);
    case "interval":
      return !oneShotAlreadyRan && (latest === undefined || now.getTime() - latest >= spec.everyMs);
    case "daily": {
      if (oneShotAlreadyRan || hasInstanceOnZonedDay(task, now, spec.timezone)) return false;
      const time = parseTimeOfDay(spec.time ?? DEFAULT_SCHEDULE_TIME);
      const parts = zonedParts(now, spec.timezone);
      const due = zonedDateTimeToUtc(spec.timezone, parts.year, parts.month, parts.day, time.hour, time.minute);
      return now.getTime() >= due.getTime();
    }
    case "weekly": {
      if (oneShotAlreadyRan || hasInstanceOnZonedDay(task, now, spec.timezone)) return false;
      const weekdays = spec.weekdays?.length ? spec.weekdays : [1];
      if (!weekdays.includes(zonedWeekday(now, spec.timezone))) return false;
      const time = parseTimeOfDay(spec.time ?? DEFAULT_SCHEDULE_TIME);
      const parts = zonedParts(now, spec.timezone);
      const due = zonedDateTimeToUtc(spec.timezone, parts.year, parts.month, parts.day, time.hour, time.minute);
      return now.getTime() >= due.getTime();
    }
    case "monthly": {
      if (oneShotAlreadyRan || hasInstanceOnZonedDay(task, now, spec.timezone)) return false;
      const parts = zonedParts(now, spec.timezone);
      const days = spec.daysOfMonth?.length ? spec.daysOfMonth : [1];
      if (!days.includes(parts.day)) return false;
      const time = parseTimeOfDay(spec.time ?? DEFAULT_SCHEDULE_TIME);
      const due = zonedDateTimeToUtc(spec.timezone, parts.year, parts.month, parts.day, time.hour, time.minute);
      return now.getTime() >= due.getTime();
    }
    case "cron": {
      if (oneShotAlreadyRan) return false;
      const previous = cronPreviousAtOrBefore(spec, now);
      if (!previous) return false;
      if (latest === undefined) return now.getTime() - previous.getTime() <= CRON_LOOKBACK_MS;
      return previous.getTime() > latest;
    }
    case "phased": {
      if (oneShotAlreadyRan || !isTriggerSpecInPhasedWindow(spec, now)) return false;
      return spec.phases
        .filter((phase) => isWithinPhaseWindow(phase, now, spec.timezone))
        .some((phase) => isStructuredTaskTriggerDue(task, phase.trigger ?? { kind: "immediate" }, now));
    }
    case "composed": {
      if (spec.operator === "all") {
        return spec.triggers.length > 0 && spec.triggers.every((trigger) => isStructuredTaskTriggerDue(task, trigger, now));
      }
      return spec.triggers.some((trigger) => isStructuredTaskTriggerDue(task, trigger, now));
    }
  }
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
  | { kind: "monthly"; spec: Extract<TriggerSpec, { kind: "monthly" }> }
  | { kind: "interval"; intervalMs: number }
  | { kind: "cron"; expr: string; timezone?: string }
  | { kind: "phased"; spec: Extract<TriggerSpec, { kind: "phased" }> }
  | { kind: "event"; spec: Extract<TriggerSpec, { kind: "event" }> }
  | { kind: "composed"; spec: Extract<TriggerSpec, { kind: "composed" }> }
  | { kind: "one_shot" };

const THREAD_LOOP_INTERVAL_REALTIME_MS = 60_000;
const THREAD_LOOP_INTERVAL_HOURLY_MS = 60 * 60_000;
const THREAD_LOOP_INTERVAL_DAILY_MS = 24 * THREAD_LOOP_INTERVAL_HOURLY_MS;
const THREAD_LOOP_INTERVAL_WEEKLY_MS = 7 * THREAD_LOOP_INTERVAL_DAILY_MS;
const DEFAULT_SCHEDULE_TIME = "09:00";
const CRON_LOOKBACK_MS = 60_000;

export function parseThreadLoopInterval(li: ThreadLoopInterval | TriggerSpec): ParsedThreadLoopInterval {
  const normalized = normalizeTriggerSpec(li);
  if (!normalized) {
    // 运行期数据脏化（脱离类型保证）→ 兜底为 one_shot，避免静默走入 cron 分支。
    return { kind: "one_shot" };
  }
  switch (normalized.kind) {
    case "realtime":
      return { kind: "realtime", intervalMs: THREAD_LOOP_INTERVAL_REALTIME_MS };
    case "hourly":
      return { kind: "hourly", intervalMs: THREAD_LOOP_INTERVAL_HOURLY_MS };
    case "daily":
      return { kind: "daily", intervalMs: THREAD_LOOP_INTERVAL_DAILY_MS };
    case "weekly":
      return { kind: "weekly", intervalMs: THREAD_LOOP_INTERVAL_WEEKLY_MS };
    case "interval":
      return { kind: "interval", intervalMs: normalized.everyMs };
    case "cron":
      return normalized.timezone
        ? { kind: "cron", expr: normalized.expr, timezone: normalized.timezone }
        : { kind: "cron", expr: normalized.expr };
    case "monthly":
      return { kind: "monthly", spec: normalized };
    case "phased":
      return { kind: "phased", spec: normalized };
    case "event":
      return { kind: "event", spec: normalized };
    case "composed":
      return { kind: "composed", spec: normalized };
    case "one_shot":
    case "immediate":
      return { kind: "one_shot" };
  }
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
  if (parsed.kind === "one_shot" || parsed.kind === "event") {
    return null;
  }
  const last = thread.lastTickAt ? new Date(thread.lastTickAt) : null;
  if (parsed.kind === "cron") {
    return cronNextAfter(
      parsed.timezone
        ? { kind: "cron", expr: parsed.expr, timezone: parsed.timezone }
        : { kind: "cron", expr: parsed.expr },
      now,
    );
  }
  if (parsed.kind === "monthly") {
    return monthlyNextAfter(parsed.spec, now);
  }
  if (parsed.kind === "phased") {
    return triggerNextAfter(parsed.spec, now);
  }
  if (parsed.kind === "composed") {
    return triggerNextAfter(parsed.spec, now);
  }
  return fixedNextAfter(last, now, parsed.intervalMs);
}

export function computeThreadDueTickAt(thread: Thread, now: Date): Date | null {
  const parsed = parseThreadLoopInterval(thread.loopInterval);
  const last = thread.lastTickAt ? new Date(thread.lastTickAt) : null;
  switch (parsed.kind) {
    case "one_shot":
      return thread.lastTickAt ? null : new Date(now.getTime());
    case "event":
      return null;
    case "cron": {
      const previous = cronPreviousAtOrBefore(
        parsed.timezone
          ? { kind: "cron", expr: parsed.expr, timezone: parsed.timezone }
          : { kind: "cron", expr: parsed.expr },
        now,
      );
      if (!previous) return null;
      if (!last || Number.isNaN(last.getTime())) {
        return now.getTime() - previous.getTime() <= CRON_LOOKBACK_MS ? previous : null;
      }
      return previous.getTime() > last.getTime() ? previous : null;
    }
    case "monthly": {
      const anchor = !last || Number.isNaN(last.getTime()) ? new Date(now.getTime() - 32 * THREAD_LOOP_INTERVAL_DAILY_MS) : last;
      const next = monthlyNextAfter(parsed.spec, anchor);
      return next && next.getTime() <= now.getTime() ? next : null;
    }
    case "phased": {
      if (!isTriggerSpecInPhasedWindow(parsed.spec, now)) return null;
      const phaseDue = parsed.spec.phases
        .filter((phase) => isWithinPhaseWindow(phase, now, parsed.spec.timezone))
        .map((phase) => triggerNextAfter(phase.trigger ?? { kind: "immediate" }, last ?? new Date(now.getTime() - 1)))
        .filter((date): date is Date => date !== null && date.getTime() <= now.getTime());
      return phaseDue.length > 0 ? new Date(Math.min(...phaseDue.map((date) => date.getTime()))) : null;
    }
    case "composed": {
      const due = parsed.spec.triggers
        .map((trigger) => computeThreadDueTickAt({ ...thread, loopInterval: trigger }, now))
        .filter((date): date is Date => Boolean(date));
      if (parsed.spec.operator === "all" && due.length !== parsed.spec.triggers.length) return null;
      return due.length > 0 ? new Date(Math.min(...due.map((date) => date.getTime()))) : null;
    }
    default:
      return fixedPreviousDueAt(last, now, parsed.intervalMs);
  }
}
