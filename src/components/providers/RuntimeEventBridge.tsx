"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { createGoalEventsSource, fetchGoalEvents } from "@/lib/api/goal-events";
import { fetchRuntimeStateSnapshot, materializeGoalSnapshot, syncRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import type { RuntimeStatePayload, RuntimeStateRevision, RuntimeStateSyncResponse } from "@/lib/api/runtime-daemon";
import { useConversationStore } from "@/stores/conversationStore";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import { useScheduleStore } from "@/stores/scheduleStore";
import type { Goal, InboxItem, Task, TaskInstance } from "@/types/kiki";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type { GoalEventRecord } from "@/types/goalEventLog";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";

function stableStringify(value: unknown) {
  return JSON.stringify(value);
}

const EMPTY_REVISION: RuntimeStateRevision = {
  goals: 0,
  runtimeEnvironments: 0,
  scheduleEvents: 0,
};

const appliedGoalEventIds = new Set<number>();
const pendingGoalEvents = new Map<number, GoalEventRecord>();

function revisionFromSnapshot(snapshot: RuntimeStatePayload): RuntimeStateRevision {
  return {
    ...EMPTY_REVISION,
    ...(snapshot.meta?.revisions ?? {}),
  };
}

function mergeSyncRevision(current: RuntimeStateRevision, response: RuntimeStateSyncResponse): RuntimeStateRevision {
  return {
    goals: current.goals,
    runtimeEnvironments: response.results?.runtimeEnvironments?.revision ?? current.runtimeEnvironments,
    scheduleEvents: response.results?.scheduleEvents?.revision ?? current.scheduleEvents,
  };
}

function goalMaterializeKey(goal: Goal) {
  const workflowUpdatedAt = goal.workflow?.updatedAt ?? goal.createdAt;
  const taskShape = goal.subGoals.map((subGoal) => `${subGoal.id}:${subGoal.tasks.map((task) => task.id).join(",")}`).join("|");
  return `${goal.id}:${workflowUpdatedAt}:${taskShape}`;
}

function snapshotGoalKeys(goals: Goal[]) {
  return Object.fromEntries(goals.map((goal) => [goal.id, goalMaterializeKey(goal)]));
}

function mergeRemoteSnapshotWithPendingLocalGoals(remoteGoals: Goal[], localGoals: Goal[]) {
  const remoteById = new Map(remoteGoals.map((goal) => [goal.id, goal]));
  const merged = remoteGoals.map((remoteGoal) => {
    const localGoal = localGoals.find((goal) => goal.id === remoteGoal.id);
    if (!localGoal || localGoal.workflow?.planDecision !== "confirmed") return remoteGoal;
    return goalMaterializeKey(localGoal) === goalMaterializeKey(remoteGoal) ? remoteGoal : localGoal;
  });
  const localOnlyGoals = localGoals.filter(
    (goal) => goal.workflow?.planDecision === "confirmed" && !remoteById.has(goal.id),
  );
  return [...merged, ...localOnlyGoals];
}

function formatLocalTime(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getTaskIconType(task: Task): InboxItem["iconType"] {
  switch (task.executionKind) {
    case "draft_review":
      return "mail";
    case "confirm_action":
      return "booking";
    case "reading_digest":
      return "news";
    default:
      return "task";
  }
}

function buildTaskLink(goalId: string, taskId: string, instanceId: string) {
  return `/goals/${goalId}/tasks/${taskId}?view=exec&instanceId=${instanceId}`;
}

function findTaskByEvent(event: GoalEventRecord) {
  const goals = useGoalStore.getState().goals;
  for (const goal of goals) {
    if (goal.id !== event.goalId) continue;
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        if (event.taskId && task.id !== event.taskId) continue;
        const instance = task.instances.find((entry) => entry.id === event.instanceId);
        if (instance) return { goal, subGoal, task, instance };
      }
    }
  }
  return null;
}

function buildResultInboxItem(input: NonNullable<ReturnType<typeof findTaskByEvent>>): InboxItem | null {
  const notification = input.instance.notification;
  if (!notification?.shouldNotify) return null;
  return {
    id: notification.inboxItemId || `inbox-${input.instance.id}`,
    iconType: getTaskIconType(input.task),
    title: notification.title,
    snippet: notification.snippet,
    badge: notification.badge ?? null,
    unreadCount: 1,
    timeLabel: formatLocalTime(new Date(notification.createdAt || input.instance.createdAt)),
    linkTo: buildTaskLink(input.goal.id, input.task.id, input.instance.id),
    goalId: input.goal.id,
    createdAt: notification.createdAt || input.instance.createdAt,
  };
}

function buildReminderItem(input: NonNullable<ReturnType<typeof findTaskByEvent>>, notificationId?: string): InboxItem {
  const timeout = notificationId?.startsWith("inbox-timeout");
  const createdAt = new Date().toISOString();
  return {
    id: notificationId || `${timeout ? "inbox-timeout" : "inbox-heartbeat"}-${input.instance.id}`,
    iconType: "task",
    title: `${timeout ? "执行超时" : "等待你继续"} - ${input.task.title.replace(/^任务\d+：/, "")}`,
    snippet: timeout
      ? "该任务执行时间过长，KiKi 已自动暂停，等待你继续处理。"
      : "这个任务已经等待你一段时间了，KiKi 提醒你回来继续推进。",
    badge: timeout ? "need_confirm" : "need_answer",
    unreadCount: 1,
    timeLabel: formatLocalTime(new Date(createdAt)),
    linkTo: buildTaskLink(input.goal.id, input.task.id, input.instance.id),
    goalId: input.goal.id,
    createdAt,
  };
}

function statusFromEventPayload(status: unknown): TaskInstance["status"] | null {
  switch (status) {
    case "pending":
    case "in_progress":
    case "completed":
    case "awaiting_user":
    case "paused":
    case "error":
      return status;
    case "queued":
      return "pending";
    case "running":
      return "in_progress";
    case "failed":
      return "error";
    case "cancelled":
      return "paused";
    default:
      return null;
  }
}

function applyInstanceStatusEvent(event: GoalEventRecord) {
  if (!event.taskId || !event.instanceId) return false;
  if (!findTaskByEvent(event)) return false;
  const payload = event.payload as { nextStatus?: unknown };
  const nextStatus = statusFromEventPayload(payload.nextStatus);
  if (!nextStatus) return false;
  useGoalStore.getState().markInstanceStatus(event.taskId, event.instanceId, nextStatus);
  return true;
}

function applyInstanceProgressEvent(event: GoalEventRecord) {
  if (!event.taskId || !event.instanceId) return false;
  if (!findTaskByEvent(event)) return false;
  const payload = event.payload as {
    progress?: GoalServerProgress;
    logs?: GoalServerLogEntry[];
    trajectory?: ExecutionTrajectoryStep[];
  };
  if (!payload.progress) return false;
  useGoalStore.getState().syncTaskInstanceRun({
    taskId: event.taskId,
    instanceId: event.instanceId,
    progress: payload.progress,
    logs: Array.isArray(payload.logs) ? payload.logs : undefined,
    trajectory: Array.isArray(payload.trajectory) ? payload.trajectory : undefined,
  });
  return true;
}

function applyTimeoutPausedEvent(event: GoalEventRecord) {
  if (!event.taskId || !event.instanceId) return false;
  if (!findTaskByEvent(event)) return false;
  useGoalStore.getState().markInstanceStatus(event.taskId, event.instanceId, "paused");
  return true;
}

function refreshScheduleEventsFromSnapshot() {
  void fetchRuntimeStateSnapshot()
    .then((snapshot) => {
      useScheduleStore.getState().replaceEvents(snapshot.scheduleEvents);
    })
    .catch(() => {
      // ignore transient schedule refresh failures
    });
}

function dependsOnLocalInstance(event: GoalEventRecord) {
  return (
    event.kind === "instance.status_changed" ||
    event.kind === "instance.progress" ||
    event.kind === "instance.timeout_paused" ||
    event.kind === "notification.delivered"
  );
}

function applyGoalEvent(event: GoalEventRecord) {
  if (appliedGoalEventIds.has(event.id)) {
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (dependsOnLocalInstance(event) && event.taskId && event.instanceId && !findTaskByEvent(event)) {
    pendingGoalEvents.set(event.id, event);
    return false;
  }
  if (event.kind === "instance.status_changed") {
    if (applyInstanceStatusEvent(event)) {
      appliedGoalEventIds.add(event.id);
      pendingGoalEvents.delete(event.id);
      return true;
    }
    appliedGoalEventIds.add(event.id);
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind === "instance.progress") {
    if (applyInstanceProgressEvent(event)) {
      appliedGoalEventIds.add(event.id);
      pendingGoalEvents.delete(event.id);
      return true;
    }
    appliedGoalEventIds.add(event.id);
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind === "instance.timeout_paused") {
    if (applyTimeoutPausedEvent(event)) {
      appliedGoalEventIds.add(event.id);
      pendingGoalEvents.delete(event.id);
      return true;
    }
    appliedGoalEventIds.add(event.id);
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind === "schedule.event_synthesized") {
    refreshScheduleEventsFromSnapshot();
    appliedGoalEventIds.add(event.id);
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind !== "notification.delivered") return true;
  const located = findTaskByEvent(event);
  if (!located) {
    pendingGoalEvents.set(event.id, event);
    return false;
  }
  appliedGoalEventIds.add(event.id);
  pendingGoalEvents.delete(event.id);
  const payload = event.payload as { target?: string; notificationId?: string };
  if (payload.target === "inbox") {
    const item = located.instance.notification
      ? buildResultInboxItem(located)
      : buildReminderItem(located, payload.notificationId);
    if (item) useInboxStore.getState().upsertItem(item);
  }
  if (payload.target === "conversation" && located.goal.conversationId) {
    const notification = located.instance.notification;
    if (!notification?.userMessage) return;
    const messageId = payload.notificationId || notification.conversationMessageId || `msg-task-${located.instance.id}`;
    const conversationStore = useConversationStore.getState();
    const conversation = conversationStore.conversations.find((entry) => entry.id === located.goal.conversationId);
    const nextMessage = {
      id: messageId,
      kind: "task_card" as const,
      role: "kiki" as const,
      content: notification.userMessage,
      createdAt: notification.createdAt,
      unread: true,
      status: "done" as const,
      source: "system" as const,
      taskRef: {
        goalId: located.goal.id,
        subGoalId: located.subGoal.id,
        taskId: located.task.id,
        instanceId: located.instance.id,
      },
    };
    if (conversation?.messages.some((message) => message.id === messageId)) {
      conversationStore.updateMessage(located.goal.conversationId, messageId, (message) =>
        message.kind === "task_card" ? { ...message, ...nextMessage } : message,
      );
    } else {
      conversationStore.appendMessage(located.goal.conversationId, nextMessage);
    }
  }
  return true;
}

// Runtime environments and schedule events still use sync as a Sprint 4-A -> 4-B bridge.
// Goal changes are materialized through /api/goals/materialize and never posted to runtime sync.
export function RuntimeEventBridge() {
  const goals = useGoalStore((state) => state.goals);
  const replaceGoals = useGoalStore((state) => state.replaceGoals);
  const environments = useRuntimeEnvStore((state) => state.environments);
  const activeRuntimeEnvId = useRuntimeEnvStore((state) => state.activeRuntimeEnvId);
  const replaceEnvironments = useRuntimeEnvStore((state) => state.replaceEnvironments);
  const events = useScheduleStore((state) => state.events);
  const replaceEvents = useScheduleStore((state) => state.replaceEvents);

  const currentGoalsKey = useMemo(() => stableStringify(goals), [goals]);
  const currentGoalIdsKey = useMemo(() => goals.map((goal) => goal.id).sort().join("|"), [goals]);
  const currentEnvironmentsKey = useMemo(() => stableStringify({ environments, activeRuntimeEnvId }), [environments, activeRuntimeEnvId]);
  const currentEventsKey = useMemo(() => stableStringify(events), [events]);
  const isApplyingRemoteRef = useRef(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const sseDisconnectedRef = useRef(false);
  const remoteRevisionRef = useRef<RuntimeStateRevision>(EMPTY_REVISION);
  const eventCursorRef = useRef<Record<string, number>>({});
  const remoteGoalKeysRef = useRef<Record<string, string>>({});
  const materializingGoalKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      try {
        const snapshot = await fetchRuntimeStateSnapshot();
        if (cancelled) return;
        isApplyingRemoteRef.current = true;
        remoteRevisionRef.current = revisionFromSnapshot(snapshot);
        remoteGoalKeysRef.current = snapshotGoalKeys(snapshot.goals);
        replaceGoals(mergeRemoteSnapshotWithPendingLocalGoals(snapshot.goals, useGoalStore.getState().goals));
        replaceEnvironments(snapshot.runtimeEnvironments);
        replaceEvents(snapshot.scheduleEvents);
        setBootstrapped(true);
      } catch {
        setBootstrapped(true);
      } finally {
        window.setTimeout(() => {
          isApplyingRemoteRef.current = false;
        }, 0);
      }
    };
    void hydrate();

    const timer = window.setInterval(async () => {
      if (!sseDisconnectedRef.current) return;
      try {
        const snapshot = await fetchRuntimeStateSnapshot();
        if (cancelled) return;
        const nextGoals = mergeRemoteSnapshotWithPendingLocalGoals(snapshot.goals, useGoalStore.getState().goals);
        const remoteGoalsKey = stableStringify(nextGoals);
        const remoteEnvironmentsKey = stableStringify({
          environments: snapshot.runtimeEnvironments,
          activeRuntimeEnvId: snapshot.runtimeEnvironments.find((item) => item.isDefault)?.id ?? null,
        });
        const remoteEventsKey = stableStringify(snapshot.scheduleEvents);
        const remoteRevision = revisionFromSnapshot(snapshot);
        if (
          remoteGoalsKey !== stableStringify(useGoalStore.getState().goals) ||
          remoteEnvironmentsKey !==
            stableStringify({
              environments: useRuntimeEnvStore.getState().environments,
              activeRuntimeEnvId: useRuntimeEnvStore.getState().activeRuntimeEnvId,
            }) ||
          remoteEventsKey !== stableStringify(useScheduleStore.getState().events)
        ) {
          isApplyingRemoteRef.current = true;
          remoteRevisionRef.current = remoteRevision;
          remoteGoalKeysRef.current = snapshotGoalKeys(snapshot.goals);
          replaceGoals(nextGoals);
          replaceEnvironments(snapshot.runtimeEnvironments);
          replaceEvents(snapshot.scheduleEvents);
          window.setTimeout(() => {
            isApplyingRemoteRef.current = false;
          }, 0);
        } else {
          remoteRevisionRef.current = remoteRevision;
          remoteGoalKeysRef.current = snapshotGoalKeys(snapshot.goals);
        }
      } catch {
        // ignore polling failures
      }
    }, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [replaceEnvironments, replaceEvents, replaceGoals]);

  useEffect(() => {
    if (!bootstrapped || goals.length === 0) return;
    const sources: EventSource[] = [];
    let cancelled = false;
    const goalIds = currentGoalIdsKey.split("|").filter(Boolean);
    const bootstrapEvents = async () => {
      for (const goalId of goalIds) {
        try {
          const response = await fetchGoalEvents({
            goalId,
            fromId: eventCursorRef.current[goalId] ?? 0,
            limit: 500,
          });
          if (cancelled) return;
          response.events.forEach(applyGoalEvent);
          eventCursorRef.current[goalId] = response.nextCursor;
          sseDisconnectedRef.current = false;
        } catch {
          // ignore event bootstrap failures
        }
      }
      if (cancelled) return;
      for (const goalId of goalIds) {
        const source = createGoalEventsSource({
          goalId,
          fromId: eventCursorRef.current[goalId] ?? 0,
        });
        source.addEventListener("events", (message) => {
          try {
            const payload = JSON.parse((message as MessageEvent).data) as {
              events?: GoalEventRecord[];
              nextCursor?: number;
            };
            payload.events?.forEach(applyGoalEvent);
            if (typeof payload.nextCursor === "number") {
              eventCursorRef.current[goalId] = payload.nextCursor;
            }
          } catch {
            // ignore malformed event payloads
          }
        });
        source.addEventListener("open", () => {
          sseDisconnectedRef.current = false;
        });
        source.addEventListener("error", () => {
          sseDisconnectedRef.current = true;
        });
        sources.push(source);
      }
    };
    void bootstrapEvents();
    return () => {
      cancelled = true;
      sources.forEach((source) => source.close());
    };
  }, [bootstrapped, currentGoalIdsKey, goals.length]);

  useEffect(() => {
    if (!bootstrapped || pendingGoalEvents.size === 0) return;
    for (const event of Array.from(pendingGoalEvents.values())) {
      applyGoalEvent(event);
    }
  }, [bootstrapped, currentGoalsKey]);

  useEffect(() => {
    if (!bootstrapped || isApplyingRemoteRef.current) return;
    const confirmedGoals = goals.filter((goal) => goal.workflow?.planDecision === "confirmed");
    for (const goal of confirmedGoals) {
      const key = goalMaterializeKey(goal);
      if (remoteGoalKeysRef.current[goal.id] === key || materializingGoalKeysRef.current.has(key)) continue;
      materializingGoalKeysRef.current.add(key);
      void materializeGoalSnapshot(goal)
        .then(() => {
          remoteGoalKeysRef.current = {
            ...remoteGoalKeysRef.current,
            [goal.id]: key,
          };
        })
        .catch(() => {
          materializingGoalKeysRef.current.delete(key);
        });
    }
  }, [bootstrapped, currentGoalsKey, goals]);

  useEffect(() => {
    if (!bootstrapped || isApplyingRemoteRef.current) return;
    const syncSnapshot = async () => {
      try {
        const result = await syncRuntimeStateSnapshot({
          baseRevision: remoteRevisionRef.current,
          runtimeEnvironments: environments.map((environment) => ({
            ...environment,
            isDefault: environment.id === activeRuntimeEnvId,
          })),
          scheduleEvents: events,
        });
        remoteRevisionRef.current = mergeSyncRevision(remoteRevisionRef.current, result);
      } catch {
        try {
          const snapshot = await fetchRuntimeStateSnapshot();
          isApplyingRemoteRef.current = true;
          remoteRevisionRef.current = revisionFromSnapshot(snapshot);
          remoteGoalKeysRef.current = snapshotGoalKeys(snapshot.goals);
          replaceEnvironments(snapshot.runtimeEnvironments);
          replaceEvents(snapshot.scheduleEvents);
          window.setTimeout(() => {
            isApplyingRemoteRef.current = false;
          }, 0);
        } catch {
          // ignore transient sync and refresh failures
        }
      }
    };
    void syncSnapshot();
  }, [
    currentEnvironmentsKey,
    currentEventsKey,
    environments,
    activeRuntimeEnvId,
    events,
    replaceEnvironments,
    replaceEvents,
    bootstrapped,
  ]);

  return null;
}
