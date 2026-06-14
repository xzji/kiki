import { computeNextTickAt } from "@/lib/taskTriggerTime";
import { normalizeTriggerSpec, type TriggerSpec, type TriggerSpecInput } from "@/types/trigger";
import type { ThreadLoopInterval, Topic } from "@/types/topic";

export type CadenceTuningReason =
  | "deadline_upgrade"
  | "silent_downgrade"
  | "important_output_boost"
  | "important_output_boost_active";

export type CadenceHistoryEntry = {
  at: string;
  entityKind: "thread" | "topic";
  from: TriggerSpec;
  to: TriggerSpec;
  reasons: CadenceTuningReason[];
  silentCount: number;
  boostUntil?: string;
};

export type CadenceTunerInput = {
  entityKind: "thread" | "topic";
  currentLoop: TriggerSpecInput | ThreadLoopInterval;
  deadline?: string;
  silentCount: number;
  hasImportantOutput?: boolean;
  now: Date;
  history?: CadenceHistoryEntry[];
};

export type CadenceTunerResult = {
  loop: TriggerSpec;
  changed: boolean;
  reasons: CadenceTuningReason[];
  history: CadenceHistoryEntry[];
  appendedHistory?: CadenceHistoryEntry;
};

const CADENCE_HISTORY_MEMORY_KEY = "cadenceHistory";
const MAX_CADENCE_HISTORY = 20;
const IMPORTANT_BOOST_MS = 24 * 60 * 60_000;

type CadenceRank = 0 | 1 | 2 | 3 | 4;

const RANK_TO_LOOP: Record<CadenceRank, TriggerSpec> = {
  0: { kind: "realtime" },
  1: { kind: "hourly" },
  2: { kind: "daily" },
  3: { kind: "weekly" },
  4: { kind: "monthly" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asIso(value: Date) {
  return value.toISOString();
}

function cadenceRank(loop: TriggerSpec): CadenceRank | null {
  switch (loop.kind) {
    case "realtime":
    case "immediate":
      return 0;
    case "hourly":
      return 1;
    case "daily":
      return 2;
    case "weekly":
      return 3;
    case "monthly":
      return 4;
    case "interval":
      if (loop.everyMs <= 60_000) return 0;
      if (loop.everyMs <= 60 * 60_000) return 1;
      if (loop.everyMs <= 24 * 60 * 60_000) return 2;
      if (loop.everyMs <= 7 * 24 * 60 * 60_000) return 3;
      return 4;
    case "cron":
    case "phased":
    case "composed":
      return 2;
    case "event":
    case "one_shot":
      return null;
  }
}

function sameLoop(a: TriggerSpec, b: TriggerSpec) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseDeadlineDistanceMs(deadline: string | undefined, now: Date) {
  if (!deadline?.trim()) return null;
  const time = new Date(deadline).getTime();
  if (!Number.isFinite(time)) return null;
  return time - now.getTime();
}

function activeBoostUntil(history: CadenceHistoryEntry[] | undefined, now: Date) {
  const latest = [...(history ?? [])]
    .reverse()
    .find((entry) => entry.reasons.includes("important_output_boost") && entry.boostUntil);
  if (!latest?.boostUntil) return undefined;
  const untilMs = new Date(latest.boostUntil).getTime();
  return Number.isFinite(untilMs) && untilMs > now.getTime() ? latest.boostUntil : undefined;
}

function normalizeHistoryEntry(value: unknown): CadenceHistoryEntry | null {
  if (!isRecord(value)) return null;
  const from = normalizeTriggerSpec(value.from as TriggerSpecInput);
  const to = normalizeTriggerSpec(value.to as TriggerSpecInput);
  if (!from || !to) return null;
  const at = typeof value.at === "string" ? value.at : undefined;
  const entityKind = value.entityKind === "topic" || value.entityKind === "thread" ? value.entityKind : undefined;
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.filter((reason): reason is CadenceTuningReason =>
        reason === "deadline_upgrade" ||
        reason === "silent_downgrade" ||
        reason === "important_output_boost" ||
        reason === "important_output_boost_active",
      )
    : [];
  if (!at || !entityKind || reasons.length === 0) return null;
  return {
    at,
    entityKind,
    from,
    to,
    reasons,
    silentCount: typeof value.silentCount === "number" && Number.isFinite(value.silentCount) ? value.silentCount : 0,
    boostUntil: typeof value.boostUntil === "string" ? value.boostUntil : undefined,
  };
}

export function readCadenceHistoryFromMemory(memory: Record<string, unknown> | undefined): CadenceHistoryEntry[] {
  const raw = memory?.[CADENCE_HISTORY_MEMORY_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeHistoryEntry(entry))
    .filter((entry): entry is CadenceHistoryEntry => Boolean(entry))
    .slice(-MAX_CADENCE_HISTORY);
}

export function writeCadenceHistoryToMemory(
  memory: Record<string, unknown>,
  history: CadenceHistoryEntry[],
): Record<string, unknown> {
  return {
    ...memory,
    [CADENCE_HISTORY_MEMORY_KEY]: history.slice(-MAX_CADENCE_HISTORY),
  };
}

export function tuneLoopCadence(input: CadenceTunerInput): CadenceTunerResult {
  const current = normalizeTriggerSpec(input.currentLoop as TriggerSpecInput) ?? { kind: "weekly" };
  const baseRank = cadenceRank(current);
  if (baseRank === null) {
    return { loop: current, changed: false, reasons: [], history: input.history ?? [] };
  }

  let targetRank: CadenceRank = baseRank;
  const reasons: CadenceTuningReason[] = [];

  if (input.silentCount >= 4) {
    targetRank = Math.min(4, targetRank + 2) as CadenceRank;
    reasons.push("silent_downgrade");
  } else if (input.silentCount >= 2) {
    targetRank = Math.min(4, targetRank + 1) as CadenceRank;
    reasons.push("silent_downgrade");
  }

  const deadlineDistanceMs = parseDeadlineDistanceMs(input.deadline, input.now);
  if (deadlineDistanceMs !== null && deadlineDistanceMs >= 0) {
    if (deadlineDistanceMs <= 6 * 60 * 60_000 && targetRank > 1) {
      targetRank = 1;
      reasons.push("deadline_upgrade");
    } else if (deadlineDistanceMs <= 72 * 60 * 60_000 && targetRank > 2) {
      targetRank = 2;
      reasons.push("deadline_upgrade");
    }
  }

  let boostUntil: string | undefined;
  if (input.hasImportantOutput) {
    targetRank = Math.min(targetRank, 1) as CadenceRank;
    boostUntil = new Date(input.now.getTime() + IMPORTANT_BOOST_MS).toISOString();
    reasons.push("important_output_boost");
  } else if (activeBoostUntil(input.history, input.now)) {
    targetRank = Math.min(targetRank, 1) as CadenceRank;
    reasons.push("important_output_boost_active");
  }

  const loop = RANK_TO_LOOP[targetRank];
  const changed = !sameLoop(current, loop);
  if (!changed) {
    return { loop: current, changed: false, reasons, history: input.history ?? [] };
  }

  const appendedHistory: CadenceHistoryEntry = {
    at: asIso(input.now),
    entityKind: input.entityKind,
    from: current,
    to: loop,
    reasons,
    silentCount: input.silentCount,
    boostUntil,
  };
  const history = [...(input.history ?? []), appendedHistory].slice(-MAX_CADENCE_HISTORY);
  return { loop, changed: true, reasons, history, appendedHistory };
}

export type TopicCadencePatch = Partial<Pick<Topic, "loop" | "lastTickAt" | "nextTickAt" | "silentCount" | "failureCount">>;

export function tuneTopicTickPatch(input: {
  topic: Topic;
  patch: TopicCadencePatch;
  now: Date;
  hasImportantOutput?: boolean;
  history?: CadenceHistoryEntry[];
}): { patch: TopicCadencePatch; cadenceHistory: CadenceHistoryEntry[] } {
  const silentCount = input.patch.silentCount ?? input.topic.silentCount;
  const tuned = tuneLoopCadence({
    entityKind: "topic",
    currentLoop: input.patch.loop ?? input.topic.loop,
    deadline: input.topic.deadline,
    silentCount,
    hasImportantOutput: input.hasImportantOutput,
    now: input.now,
    history: input.history,
  });
  const lastTickAt = input.patch.lastTickAt ?? input.topic.lastTickAt ?? input.now.toISOString();
  const next = computeNextTickAt(
    {
      id: `${input.topic.id}:topic-loop`,
      topicId: input.topic.id,
      title: input.topic.title,
      intent: input.topic.summary,
      loopInterval: tuned.loop,
      status: input.topic.status === "active" ? "active" : "paused",
      lastTickAt,
      memory: {},
      silentCount,
      failureCount: input.patch.failureCount ?? input.topic.failureCount,
      createdAt: input.topic.createdAt,
      updatedAt: input.topic.updatedAt,
      revision: input.topic.revision,
    },
    input.now,
  );
  return {
    patch: {
      ...input.patch,
      loop: tuned.loop,
      lastTickAt,
      nextTickAt: next ? next.toISOString() : undefined,
    },
    cadenceHistory: tuned.history,
  };
}
