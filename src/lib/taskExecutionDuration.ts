import type { GoalEventRecord } from "@/types/goalEventLog";
import type { TaskInstanceStatus } from "@/types/kiki";

const ACTIVE_INSTANCE_STATUSES = new Set<TaskInstanceStatus>(["in_progress"]);

type Transition = { atMs: number; active: boolean };

function isActiveInstanceStatus(status: string | undefined) {
  return ACTIVE_INSTANCE_STATUSES.has(status as TaskInstanceStatus);
}

function isActiveJobStatus(status: string | undefined) {
  return status === "running";
}

function selectTimelineEvents(events: GoalEventRecord[]) {
  const instanceEvents = events.filter(
    (event) => event.kind === "instance.status_changed" || event.kind === "instance.timeout_paused",
  );
  if (instanceEvents.length > 0) return instanceEvents;
  return events.filter((event) => event.kind === "job.status_changed");
}

function collectTransitions(events: GoalEventRecord[]): Transition[] {
  const transitions: Transition[] = [];
  for (const event of selectTimelineEvents(events)) {
    const atMs = Date.parse(event.createdAt);
    if (!Number.isFinite(atMs)) continue;
    if (event.kind === "instance.status_changed") {
      transitions.push({
        atMs,
        active: isActiveInstanceStatus((event.payload as GoalEventRecord<"instance.status_changed">["payload"]).nextStatus),
      });
      continue;
    }
    if (event.kind === "instance.timeout_paused") {
      transitions.push({ atMs, active: false });
      continue;
    }
    if (event.kind === "job.status_changed") {
      transitions.push({
        atMs,
        active: isActiveJobStatus((event.payload as GoalEventRecord<"job.status_changed">["payload"]).nextStatus),
      });
    }
  }
  return transitions.sort((left, right) => left.atMs - right.atMs);
}

function resolveEndMs(input: {
  finishedAt?: string;
  lastUpdatedAt?: string;
  nowMs: number;
}) {
  for (const value of [input.finishedAt, input.lastUpdatedAt]) {
    const parsed = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return input.nowMs;
}

function fallbackActiveExecutionDuration(input: {
  currentStatus: TaskInstanceStatus;
  startedAt?: string;
  finishedAt?: string;
  lastUpdatedAt?: string;
  nowMs: number;
}): { activeDurationMs: number; activeSince?: string } {
  const startedMs = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  if (!Number.isFinite(startedMs)) return { activeDurationMs: 0 };

  if (input.currentStatus === "in_progress") {
    return { activeDurationMs: 0, activeSince: input.startedAt };
  }

  const endMs = resolveEndMs({
    finishedAt: input.finishedAt,
    lastUpdatedAt: input.lastUpdatedAt,
    nowMs: input.nowMs,
  });

  if (
    input.currentStatus === "paused" ||
    input.currentStatus === "awaiting_user" ||
    input.currentStatus === "completed" ||
    input.currentStatus === "error" ||
    input.currentStatus === "terminated"
  ) {
    return { activeDurationMs: Math.max(0, endMs - startedMs) };
  }

  return { activeDurationMs: 0 };
}

export function computeActiveExecutionDuration(input: {
  events: GoalEventRecord[];
  currentStatus: TaskInstanceStatus;
  startedAt?: string;
  finishedAt?: string;
  lastUpdatedAt?: string;
  nowMs?: number;
}): { activeDurationMs: number; activeSince?: string } {
  const nowMs = input.nowMs ?? Date.now();
  const transitions = collectTransitions(input.events);
  if (transitions.length === 0) {
    return fallbackActiveExecutionDuration({ ...input, nowMs });
  }

  let activeMs = 0;
  let segmentStart: number | null = null;
  let currentlyActive = false;

  for (const transition of transitions) {
    if (transition.active) {
      if (!currentlyActive) {
        segmentStart = transition.atMs;
        currentlyActive = true;
      }
      continue;
    }
    if (currentlyActive && segmentStart !== null) {
      activeMs += Math.max(0, transition.atMs - segmentStart);
      segmentStart = null;
      currentlyActive = false;
    }
  }

  if (currentlyActive && segmentStart !== null) {
    if (isActiveInstanceStatus(input.currentStatus)) {
      return {
        activeDurationMs: activeMs,
        activeSince: new Date(segmentStart).toISOString(),
      };
    }
    const endMs = resolveEndMs({
      finishedAt: input.finishedAt,
      lastUpdatedAt: input.lastUpdatedAt,
      nowMs,
    });
    activeMs += Math.max(0, endMs - segmentStart);
  }

  return { activeDurationMs: activeMs };
}

export function resolveActiveExecutionMs(input: {
  activeDurationMs?: number;
  activeSince?: string;
  isActive?: boolean;
  nowMs?: number;
}) {
  const base = input.activeDurationMs ?? 0;
  if (!input.isActive || !input.activeSince) return base;
  const sinceMs = Date.parse(input.activeSince);
  if (!Number.isFinite(sinceMs)) return base;
  return base + Math.max(0, (input.nowMs ?? Date.now()) - sinceMs);
}

export function formatDurationMs(ms: number) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${`${seconds}`.padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
