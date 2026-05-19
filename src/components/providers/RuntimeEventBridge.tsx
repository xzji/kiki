"use client";

import { useEffect, useMemo, useRef } from "react";

import { createGoalEventsSource, fetchGoalEvents } from "@/lib/api/goal-events";
import { fetchRuntimeStateSnapshot, materializeGoalSnapshot, syncRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import type { RuntimeStatePayload, RuntimeStateRevision, RuntimeStateSyncResponse } from "@/lib/api/runtime-daemon";
import { useConversationStore } from "@/stores/conversationStore";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import { useScheduleStore } from "@/stores/scheduleStore";
import type { Goal, InboxItem, Task } from "@/types/kiki";
import type { GoalEventRecord } from "@/types/goalEventLog";

function stableStringify(value: unknown) {
  return JSON.stringify(value);
}

const EMPTY_REVISION: RuntimeStateRevision = {
  goals: 0,
  runtimeEnvironments: 0,
  scheduleEvents: 0,
};

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

function applyGoalEvent(event: GoalEventRecord) {
  if (event.kind !== "notification.delivered") return;
  const located = findTaskByEvent(event);
  if (!located) return;
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
  const currentEnvironmentsKey = useMemo(() => stableStringify({ environments, activeRuntimeEnvId }), [environments, activeRuntimeEnvId]);
  const currentEventsKey = useMemo(() => stableStringify(events), [events]);
  const isApplyingRemoteRef = useRef(false);
  const didBootstrapRef = useRef(false);
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
        replaceGoals(snapshot.goals);
        replaceEnvironments(snapshot.runtimeEnvironments);
        replaceEvents(snapshot.scheduleEvents);
        didBootstrapRef.current = true;
      } catch {
        didBootstrapRef.current = true;
      } finally {
        window.setTimeout(() => {
          isApplyingRemoteRef.current = false;
        }, 0);
      }
    };
    void hydrate();

    const timer = window.setInterval(async () => {
      try {
        const snapshot = await fetchRuntimeStateSnapshot();
        if (cancelled) return;
        const remoteGoalsKey = stableStringify(snapshot.goals);
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
          replaceGoals(snapshot.goals);
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
    if (!didBootstrapRef.current || goals.length === 0) return;
    const sources: EventSource[] = [];
    let cancelled = false;
    const goalIds = goals.map((goal) => goal.id);
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
        sources.push(source);
      }
    };
    void bootstrapEvents();
    return () => {
      cancelled = true;
      sources.forEach((source) => source.close());
    };
  }, [currentGoalsKey, goals]);

  useEffect(() => {
    if (!didBootstrapRef.current || isApplyingRemoteRef.current) return;
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
  }, [currentGoalsKey, goals]);

  useEffect(() => {
    if (!didBootstrapRef.current || isApplyingRemoteRef.current) return;
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
  ]);

  return null;
}
