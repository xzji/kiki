const LOCALE = "zh-CN";

export const BASE_DATE = new Date("2026-04-26T10:00:00+08:00");

export function formatChineseDate(input: string | Date) {
  const date = typeof input === "string" ? new Date(input) : input;
  return new Intl.DateTimeFormat(LOCALE, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatShortDate(input: string | Date) {
  const date = typeof input === "string" ? new Date(input) : input;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${month}-${day}`;
}

export function formatClock(input: string | Date) {
  const date = typeof input === "string" ? new Date(input) : input;
  return new Intl.DateTimeFormat(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatMessageTime(input: string | Date) {
  const date = typeof input === "string" ? new Date(input) : input;
  return `${formatShortDate(date)} ${formatClock(date)}`;
}

export function isSameDay(a: string | Date, b: string | Date) {
  const da = typeof a === "string" ? new Date(a) : a;
  const db = typeof b === "string" ? new Date(b) : b;
  return da.toDateString() === db.toDateString();
}

export function formatDateInput(input?: string) {
  if (!input) return "";
  return new Date(input).toISOString().slice(0, 10);
}
