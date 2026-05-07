import { HOUR_HEIGHT } from "./colorTokens";

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MONTH_CN = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];

export function startOfDay(date: Date): Date {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

export function endOfDay(date: Date): Date {
  const clone = new Date(date);
  clone.setHours(23, 59, 59, 999);
  return clone;
}

export function minutesSinceDayStart(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function minutesToPx(minutes: number, hourHeight = HOUR_HEIGHT): number {
  return (minutes / 60) * hourHeight;
}

export function pxToMinutes(px: number, hourHeight = HOUR_HEIGHT, snap = 15): number {
  const raw = (px / hourHeight) * 60;
  return Math.max(0, Math.round(raw / snap) * snap);
}

export function isSameYmd(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function getWeekRange(anchor: Date): [Date, Date] {
  const start = startOfDay(anchor);
  const dayOfWeek = start.getDay();
  start.setDate(start.getDate() - dayOfWeek);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return [start, end];
}

export function eachDayOfWeek(anchor: Date): Date[] {
  const [start] = getWeekRange(anchor);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

export function eachDayOfMonthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfDay(first);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

export function formatWeekTitle(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth();
  if (sameMonth) {
    return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 - ${end.getDate()}日`;
  }
  return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 - ${end.getMonth() + 1}月${end.getDate()}日`;
}

export function formatDayTitle(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatMonthTitle(d: Date): string {
  return `${MONTH_CN[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatWeekdayShort(d: Date): string {
  return WEEKDAY_CN[d.getDay()];
}

export function formatClockShort(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour12}:${m.toString().padStart(2, "0")}${suffix}`;
}

export function formatHourLabel(hour: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${hour12} ${suffix}`;
}

export function formatRangeLabel(start: Date, end: Date): string {
  return `${formatClockShort(start)} - ${formatClockShort(end)}`;
}

export function isEventOnDay(startIso: string, endIso: string, day: Date): boolean {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = endOfDay(day).getTime();
  const eventStart = new Date(startIso).getTime();
  const eventEnd = new Date(endIso).getTime();
  return eventStart <= dayEnd && eventEnd >= dayStart;
}

export function clampToDay(startIso: string, endIso: string, day: Date): { startMin: number; endMin: number } {
  const dayStart = startOfDay(day);
  const dayEnd = endOfDay(day);
  const eventStart = new Date(startIso);
  const eventEnd = new Date(endIso);
  const effectiveStart = eventStart < dayStart ? dayStart : eventStart;
  const effectiveEnd = eventEnd > dayEnd ? dayEnd : eventEnd;
  return {
    startMin: minutesSinceDayStart(effectiveStart),
    endMin: minutesSinceDayStart(effectiveEnd)
  };
}

export function toIsoDate(date: Date): string {
  return date.toISOString();
}

export function ymd(date: Date): string {
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}
