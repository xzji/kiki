export type EventSourceKind =
  | "manual"
  | "scheduler"
  | "user_reply"
  | "task_completed"
  | "task_failed"
  | "thread_tick"
  | "topic_tick";

export type EventSource =
  | EventSourceKind
  | {
      kind: EventSourceKind;
      offsetMinutes?: number;
      debounceMs?: number;
      taskIds?: string[];
      threadId?: string;
    };

export type TriggerIntervalUnit = "ms" | "s" | "m" | "h" | "d";

export type PhaseWindow = {
  id?: string;
  label?: string;
  start?: string;
  end?: string;
  timezone?: string;
  daysOfWeek?: number[];
  daysOfMonth?: number[];
  months?: number[];
  trigger?: TriggerSpec;
  metadata?: Record<string, unknown>;
};

export type TriggerSpec =
  | { kind: "immediate" }
  | { kind: "one_shot" }
  | { kind: "realtime" }
  | { kind: "hourly" }
  | { kind: "daily"; time?: string; timezone?: string }
  | { kind: "weekly"; weekdays?: number[]; time?: string; timezone?: string }
  | { kind: "monthly"; daysOfMonth?: number[]; time?: string; timezone?: string }
  | { kind: "cron"; expr: string; timezone?: string }
  | { kind: "interval"; everyMs: number; value: number; unit: TriggerIntervalUnit }
  | { kind: "phased"; phases: PhaseWindow[]; timezone?: string }
  | { kind: "event"; sources: EventSource[] }
  | { kind: "composed"; triggers: TriggerSpec[]; operator?: "any" | "all" };

export type LegacyTriggerKeyword =
  | "realtime"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "one_shot";

export type TriggerSpecInput =
  | TriggerSpec
  | LegacyTriggerKeyword
  | `cron:${string}`
  | `interval:${string}`
  | `phased:${string}`
  | `composed:${string}`
  | string
  | null
  | undefined;

export type TriggerSpecNormalizationWarning = {
  code: "trigger_spec_invalid";
  path?: string;
  input: unknown;
  message: string;
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const DURATION_UNIT_MS: Record<TriggerIntervalUnit, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumberList(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  return numbers.length > 0 ? numbers : undefined;
}

function isEventSourceKind(value: unknown): value is EventSourceKind {
  return (
    value === "manual" ||
    value === "scheduler" ||
    value === "user_reply" ||
    value === "task_completed" ||
    value === "task_failed" ||
    value === "thread_tick" ||
    value === "topic_tick"
  );
}

function readEventSources(value: unknown): EventSource[] {
  if (!Array.isArray(value)) return [];
  const sources: EventSource[] = [];
  for (const item of value) {
    if (isEventSourceKind(item)) {
      sources.push(item);
      continue;
    }
    if (!isRecord(item) || !isEventSourceKind(item.kind)) continue;
    const offsetMinutes = typeof item.offsetMinutes === "number" && Number.isFinite(item.offsetMinutes)
      ? item.offsetMinutes
      : undefined;
    const debounceMs = typeof item.debounceMs === "number" && Number.isFinite(item.debounceMs)
      ? item.debounceMs
      : undefined;
    sources.push({
      kind: item.kind,
      offsetMinutes,
      debounceMs,
      taskIds: Array.isArray(item.taskIds)
        ? item.taskIds.filter((taskId): taskId is string => typeof taskId === "string" && taskId.trim().length > 0)
        : undefined,
      threadId: readNonEmptyString(item.threadId),
    });
  }
  return sources;
}

function normalizeInterval(value: string) {
  const match = value.trim().match(DURATION_PATTERN);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] as TriggerIntervalUnit;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    kind: "interval" as const,
    everyMs: amount * DURATION_UNIT_MS[unit],
    value: amount,
    unit,
  };
}

function normalizeCron(value: string) {
  const withTimezone = value.trim().match(/^(.*?)\s+tz=([A-Za-z0-9_./+-]+)$/);
  const expr = (withTimezone ? withTimezone[1] : value).trim();
  if (!expr) return null;
  const timezone = withTimezone?.[2]?.trim();
  return timezone ? { kind: "cron" as const, expr, timezone } : { kind: "cron" as const, expr };
}

function normalizePhaseWindow(value: unknown): PhaseWindow | null {
  if (!isRecord(value)) return null;
  const trigger = normalizeTriggerSpec(value.trigger as TriggerSpecInput);
  const phase: PhaseWindow = {
    id: readNonEmptyString(value.id),
    label: readNonEmptyString(value.label),
    start: readNonEmptyString(value.start),
    end: readNonEmptyString(value.end),
    timezone: readNonEmptyString(value.timezone),
    daysOfWeek: readNumberList(value.daysOfWeek),
    daysOfMonth: readNumberList(value.daysOfMonth),
    months: readNumberList(value.months),
    trigger: trigger ?? undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
  return phase;
}

function normalizePhasedJson(value: string) {
  try {
    const parsed = JSON.parse(value);
    const rawPhases = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.phases : undefined;
    if (!Array.isArray(rawPhases)) return null;
    const phases = rawPhases
      .map((phase) => normalizePhaseWindow(phase))
      .filter((phase): phase is PhaseWindow => Boolean(phase));
    if (phases.length === 0) return null;
    const timezone = isRecord(parsed) ? readNonEmptyString(parsed.timezone) : undefined;
    return timezone ? { kind: "phased" as const, phases, timezone } : { kind: "phased" as const, phases };
  } catch {
    return null;
  }
}

function normalizeComposedJson(value: string) {
  try {
    const parsed = JSON.parse(value);
    const rawTriggers = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.triggers : undefined;
    if (!Array.isArray(rawTriggers)) return null;
    const triggers = rawTriggers
      .map((trigger) => normalizeTriggerSpec(trigger as TriggerSpecInput))
      .filter((trigger): trigger is TriggerSpec => Boolean(trigger));
    if (triggers.length === 0) return null;
    const operator: "all" | undefined = isRecord(parsed) && parsed.operator === "all" ? "all" : undefined;
    return operator ? { kind: "composed" as const, triggers, operator } : { kind: "composed" as const, triggers };
  } catch {
    return null;
  }
}

export function normalizeTriggerSpec(input: TriggerSpecInput): TriggerSpec | null {
  if (!input) return null;
  if (typeof input === "string") {
    const normalized = input.trim();
    if (!normalized) return null;
    if (normalized === "hourly") return { kind: "hourly" };
    if (normalized === "daily") return { kind: "daily" };
    if (normalized === "weekly") return { kind: "weekly" };
    if (normalized === "monthly") return { kind: "monthly" };
    if (normalized === "realtime") return { kind: "realtime" };
    if (normalized === "one_shot") return { kind: "one_shot" };
    if (normalized === "immediate" || normalized === "now") return { kind: "immediate" };
    if (normalized.startsWith("cron:")) return normalizeCron(normalized.slice("cron:".length));
    if (normalized.startsWith("interval:")) return normalizeInterval(normalized.slice("interval:".length));
    if (normalized.startsWith("phased:")) return normalizePhasedJson(normalized.slice("phased:".length));
    if (normalized.startsWith("composed:")) return normalizeComposedJson(normalized.slice("composed:".length));
    return null;
  }

  if (!isRecord(input) || typeof input.kind !== "string") return null;
  switch (input.kind) {
    case "immediate":
      return { kind: "immediate" };
    case "one_shot":
      return { kind: "one_shot" };
    case "realtime":
      return { kind: "realtime" };
    case "hourly":
      return { kind: "hourly" };
    case "daily":
      return {
        kind: "daily",
        time: readNonEmptyString(input.time),
        timezone: readNonEmptyString(input.timezone),
      };
    case "weekly":
      return {
        kind: "weekly",
        weekdays: readNumberList(input.weekdays),
        time: readNonEmptyString(input.time),
        timezone: readNonEmptyString(input.timezone),
      };
    case "monthly":
      return {
        kind: "monthly",
        daysOfMonth: readNumberList(input.daysOfMonth),
        time: readNonEmptyString(input.time),
        timezone: readNonEmptyString(input.timezone),
      };
    case "cron":
      return normalizeCron(`${readNonEmptyString(input.expr) ?? ""}${input.timezone ? ` tz=${input.timezone}` : ""}`);
    case "interval": {
      const everyMs = typeof input.everyMs === "number" ? input.everyMs : undefined;
      const value = typeof input.value === "number" ? input.value : undefined;
      const unit = typeof input.unit === "string" ? input.unit : undefined;
      if (everyMs !== undefined && Number.isFinite(everyMs) && everyMs > 0) {
        return {
          kind: "interval",
          everyMs,
          value: value && Number.isFinite(value) && value > 0 ? value : everyMs,
          unit:
            unit === "ms" || unit === "s" || unit === "m" || unit === "h" || unit === "d"
              ? unit
              : "ms",
        };
      }
      return value && unit ? normalizeInterval(`${value}${unit}`) : null;
    }
    case "phased": {
      if (!Array.isArray(input.phases)) return null;
      const phases = input.phases
        .map((phase) => normalizePhaseWindow(phase))
        .filter((phase): phase is PhaseWindow => Boolean(phase));
      if (phases.length === 0) return null;
      const timezone = readNonEmptyString(input.timezone);
      return timezone ? { kind: "phased", phases, timezone } : { kind: "phased", phases };
    }
    case "event": {
      const sources = readEventSources(input.sources);
      return sources.length > 0 ? { kind: "event", sources } : null;
    }
    case "composed": {
      if (!Array.isArray(input.triggers)) return null;
      const triggers = input.triggers
        .map((trigger) => normalizeTriggerSpec(trigger as TriggerSpecInput))
        .filter((trigger): trigger is TriggerSpec => Boolean(trigger));
      if (triggers.length === 0) return null;
      const operator = input.operator === "all" ? "all" : undefined;
      return operator ? { kind: "composed", triggers, operator } : { kind: "composed", triggers };
    }
    default:
      return null;
  }
}

function shouldWarnInvalidTriggerInput(input: TriggerSpecInput) {
  if (input === null || input === undefined) return false;
  return typeof input !== "string" || input.trim().length > 0;
}

export function normalizeTriggerSpecWithWarnings(
  input: TriggerSpecInput,
  options: { path?: string } = {},
): { trigger: TriggerSpec | null; warnings: TriggerSpecNormalizationWarning[] } {
  const trigger = normalizeTriggerSpec(input);
  if (trigger || !shouldWarnInvalidTriggerInput(input)) {
    return { trigger, warnings: [] };
  }
  return {
    trigger: null,
    warnings: [
      {
        code: "trigger_spec_invalid",
        path: options.path,
        input,
        message: options.path
          ? `TriggerSpec at ${options.path} is invalid; using legacy fallback when available.`
          : "TriggerSpec is invalid; using legacy fallback when available.",
      },
    ],
  };
}
