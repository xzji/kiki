import { createGeneratedInstance } from "@/lib/goalFactory";
import { createIdempotencyKey, deriveOpaqueId, normalizeTaskId } from "@/lib/opaqueIds";
import {
  listPendingGovernanceEvents,
  markGovernanceEventConsumed,
  type GovernanceEventOutboxRecord,
  type GovernanceEventType,
} from "@/lib/server/repositories/governanceEventOutboxRepository";
import {
  findTopicById,
  TopicRevisionMismatchError,
  updateTopic,
} from "@/lib/server/repositories/topicsRepository";
import { readComposedGoalsSnapshot } from "@/lib/server/runtime/instanceComposition";
import {
  persistTaskInstanceProjection,
  wakeThreadGovernanceLoop,
} from "@/lib/server/services/goalRuntimeService";
import { findThreadById } from "@/lib/server/repositories/threadsRepository";
import { normalizeTriggerSpec, type EventSource, type EventSourceKind, type TriggerSpecInput } from "@/types/trigger";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";

const THREAD_EVENT_TYPES: GovernanceEventType[] = [
  "thread_governance_tick_requested",
  "task_completed",
  "task_failed",
  "user_replied",
];

const TASK_EVENT_TYPES: GovernanceEventType[] = [
  "task_completed",
  "task_failed",
  "user_replied",
];

export type GovernanceEventBridgeResult = {
  checked: number;
  processed: number;
  skipped: number;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function eventSourceKind(source: EventSource): EventSourceKind {
  return typeof source === "string" ? source : source.kind;
}

function eventSourceMatches(source: EventSource, event: GovernanceEventOutboxRecord): boolean {
  if (eventSourceKind(source) !== event.source) return false;
  if (typeof source === "string") return true;
  if (source.threadId && source.threadId !== event.threadId) return false;
  if (source.taskIds?.length) {
    const taskIds = source.taskIds.map((taskId) => normalizeTaskId(taskId));
    if (!event.taskId || !taskIds.includes(event.taskId)) return false;
  }
  return true;
}

function matchingEventSources(trigger: TriggerSpecInput, event: GovernanceEventOutboxRecord): EventSource[] {
  const normalized = normalizeTriggerSpec(trigger);
  if (!normalized) return [];
  if (normalized.kind === "event") return normalized.sources.filter((source) => eventSourceMatches(source, event));
  if (normalized.kind === "composed") {
    return normalized.triggers.flatMap((child) => matchingEventSources(child, event));
  }
  if (normalized.kind === "phased") {
    return normalized.phases.flatMap((phase) => matchingEventSources(phase.trigger, event));
  }
  return [];
}

function earliestEventDueAt(event: GovernanceEventOutboxRecord, sources: EventSource[], fallback: Date) {
  const base = new Date(event.createdAt);
  const baseTime = Number.isNaN(base.getTime()) ? fallback.getTime() : base.getTime();
  const dueTimes = sources.map((source) => {
    const offsetMinutes = typeof source === "string" ? 0 : source.offsetMinutes ?? 0;
    const debounceMs = typeof source === "string" ? 0 : source.debounceMs ?? 0;
    return baseTime + offsetMinutes * 60_000 + debounceMs;
  });
  return new Date(Math.min(...dueTimes));
}

function triggerFingerprint(task: Task) {
  const normalized = normalizeTriggerSpec(task.trigger);
  return stableStringify(normalized ?? task.trigger ?? task.triggerRule);
}

function makeEventTriggeredInstance(input: {
  event: GovernanceEventOutboxRecord;
  task: Task;
  createdAt: string;
  idempotencyKey: string;
}): TaskInstance {
  const instance = createGeneratedInstance(input.task, input.createdAt);
  return {
    ...instance,
    id: deriveOpaqueId("inst", input.idempotencyKey),
    intro: `治理事件 ${input.event.eventId} 触发执行“${input.task.title.replace(/^任务\d+：/, "")}”。`,
  };
}

function matchingEventTriggeredTasks(goals: Goal[], event: GovernanceEventOutboxRecord) {
  const normalizedEventTaskId = event.taskId ? normalizeTaskId(event.taskId) : undefined;
  const matches: Array<{ goal: Goal; subGoal: SubGoal; task: Task }> = [];
  for (const goal of goals) {
    if (event.topicId && goal.id !== event.topicId) continue;
    for (const subGoal of goal.subGoals) {
      if (event.threadId && subGoal.id !== event.threadId) continue;
      for (const task of subGoal.tasks) {
        if (normalizedEventTaskId && normalizeTaskId(task.id) === normalizedEventTaskId) continue;
        const matchingSources = matchingEventSources(task.trigger, event);
        if (matchingSources.length === 0) continue;
        matches.push({ goal, subGoal, task });
      }
    }
  }
  return matches;
}

export function createEventTriggeredTaskInstances(input: {
  event: GovernanceEventOutboxRecord;
  now?: Date;
}) {
  const goals = readComposedGoalsSnapshot([]);
  const now = input.now ?? new Date();
  const results: Array<{
    taskId: string;
    instanceId: string;
    idempotencyKey: string;
    created: boolean;
    deferred?: boolean;
  }> = [];

  for (const match of matchingEventTriggeredTasks(goals, input.event)) {
    const matchingSources = matchingEventSources(match.task.trigger, input.event);
    if (matchingSources.length === 0) continue;
    const dueAt = earliestEventDueAt(input.event, matchingSources, now);
    if (dueAt.getTime() > now.getTime()) {
      const futureKey = createIdempotencyKey(
        "event_triggered_task_instance",
        input.event.eventId,
        match.task.id,
        triggerFingerprint(match.task),
      );
      results.push({
        taskId: match.task.id,
        instanceId: deriveOpaqueId("inst", futureKey),
        idempotencyKey: futureKey,
        created: false,
        deferred: true,
      });
      continue;
    }
    const fingerprint = triggerFingerprint(match.task);
    const idempotencyKey = createIdempotencyKey(
      "event_triggered_task_instance",
      input.event.eventId,
      match.task.id,
      fingerprint,
    );
    const instanceId = deriveOpaqueId("inst", idempotencyKey);
    const existing = match.task.instances.find((instance: TaskInstance) => instance.id === instanceId);
    if (existing) {
      results.push({ taskId: match.task.id, instanceId, idempotencyKey, created: false });
      continue;
    }

    const instance = makeEventTriggeredInstance({
      event: input.event,
      task: match.task,
      createdAt: dueAt.toISOString(),
      idempotencyKey,
    });
    persistTaskInstanceProjection({
      goals,
      goal: match.goal,
      subGoal: match.subGoal,
      task: match.task,
      instance,
    });
    results.push({ taskId: match.task.id, instanceId: instance.id, idempotencyKey, created: true });
  }

  return results;
}

export function wakeTopicGovernanceLoop(topicId: string, now = new Date()) {
  const topic = findTopicById(topicId);
  if (!topic || topic.status !== "active") return false;
  const nextTickAtMs = topic.nextTickAt ? new Date(topic.nextTickAt).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isFinite(nextTickAtMs) && nextTickAtMs <= now.getTime()) return false;
  try {
    updateTopic(topic.id, { nextTickAt: now.toISOString() }, topic.revision);
    return true;
  } catch (error) {
    if (error instanceof TopicRevisionMismatchError) return false;
    throw error;
  }
}

export class ThreadEventBridge {
  readonly consumer = "thread-event-bridge";

  consumePending(input: { afterId?: number; limit?: number; now?: Date } = {}): GovernanceEventBridgeResult {
    const events = listPendingGovernanceEvents({
      consumer: this.consumer,
      afterId: input.afterId,
      limit: input.limit,
      eventTypes: THREAD_EVENT_TYPES,
    });
    let processed = 0;
    let skipped = 0;
    for (const event of events) {
      const now = input.now ?? new Date();
      const thread = event.threadId ? findThreadById(event.threadId) : null;
      const matchingSources = thread ? matchingEventSources(thread.loopTrigger ?? thread.loopInterval, event) : [];
      const wakeAt = matchingSources.length > 0
        ? earliestEventDueAt(event, matchingSources, now)
        : earliestEventDueAt(event, [event.source], now);
      const didWake = event.threadId && wakeAt.getTime() <= now.getTime()
        ? wakeThreadGovernanceLoop(event.threadId, wakeAt)
        : false;
      if (didWake) processed += 1;
      else skipped += 1;
      if (wakeAt.getTime() <= now.getTime()) {
        markGovernanceEventConsumed({ eventId: event.eventId, consumer: this.consumer });
      }
    }
    return { checked: events.length, processed, skipped };
  }
}

export class TopicEventBridge {
  readonly consumer = "topic-event-bridge";

  consumePending(input: { afterId?: number; limit?: number; now?: Date } = {}): GovernanceEventBridgeResult {
    const events = listPendingGovernanceEvents({
      consumer: this.consumer,
      afterId: input.afterId,
      limit: input.limit,
      eventTypes: TASK_EVENT_TYPES,
    });
    let processed = 0;
    let skipped = 0;
    for (const event of events) {
      const now = input.now ?? new Date();
      const topic = event.topicId ? findTopicById(event.topicId) : null;
      const matchingSources = topic ? matchingEventSources(topic.loop, event) : [];
      const wakeAt = matchingSources.length > 0
        ? earliestEventDueAt(event, matchingSources, now)
        : earliestEventDueAt(event, [event.source], now);
      const didWake = event.topicId && wakeAt.getTime() <= now.getTime()
        ? wakeTopicGovernanceLoop(event.topicId, wakeAt)
        : false;
      if (didWake) processed += 1;
      else skipped += 1;
      if (wakeAt.getTime() <= now.getTime()) {
        markGovernanceEventConsumed({ eventId: event.eventId, consumer: this.consumer });
      }
    }
    return { checked: events.length, processed, skipped };
  }
}

export class TaskEventBridge {
  readonly consumer = "task-event-bridge";

  consumePending(input: { afterId?: number; limit?: number; now?: Date } = {}): GovernanceEventBridgeResult {
    const events = listPendingGovernanceEvents({
      consumer: this.consumer,
      afterId: input.afterId,
      limit: input.limit,
      eventTypes: TASK_EVENT_TYPES,
    });
    let processed = 0;
    let skipped = 0;
    for (const event of events) {
      const results = createEventTriggeredTaskInstances({ event, now: input.now });
      if (results.some((result) => result.created)) processed += 1;
      else skipped += 1;
      if (!results.some((result) => result.deferred)) {
        markGovernanceEventConsumed({ eventId: event.eventId, consumer: this.consumer });
      }
    }
    return { checked: events.length, processed, skipped };
  }
}
