"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  fetchConversationState,
  importLegacyConversations,
} from "@/lib/api/conversation-commands";
import { createGoalEventsSource, fetchGoalEvents } from "@/lib/api/goal-events";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import {
  advanceGoalEventCursor,
  GOAL_EVENT_CURSOR_CHANNEL,
  GOAL_EVENT_CURSOR_STORAGE_KEY,
  type GoalEventCursorMap,
  mergeGoalEventCursors,
  normalizeGoalEventCursors,
  readGoalEventCursors,
  writeGoalEventCursors,
} from "@/lib/goalEventCursor";
import {
  isRuntimeStateChannelMessage,
  RUNTIME_STATE_CHANNEL,
} from "@/lib/runtimeStateChannel";
import type { RuntimeStatePayload, RuntimeStateRevision } from "@/lib/api/runtime-daemon";
import { useConversationStore } from "@/stores/conversationStore";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import { useScheduleStore } from "@/stores/scheduleStore";
import type { Conversation, InboxItem, TaskInstance } from "@/types/kiki";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type { GoalEventRecord } from "@/types/goalEventLog";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { ConversationEventRecord } from "@/types/conversationEventLog";

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
const runtimeEventMetrics = {
  applied: 0,
  duplicates: 0,
  pending: 0,
  replayed: 0,
  sseErrors: 0,
  snapshotRefreshes: 0,
};

const LEGACY_BUSINESS_STATE_KEYS = [
  "kiki.runtime.environments",
  "kiki.schedule.events",
  "kiki.schedule.events.reset-version",
  "kiki.goals",
];

type RuntimeEventMetricsWindow = Window & {
  __KIKI_RUNTIME_EVENT_METRICS__?: typeof runtimeEventMetrics;
};

function readLegacyConversations(): Conversation[] {
  try {
    const raw = window.localStorage.getItem("kiki.conversations");
    if (!raw || window.localStorage.getItem("kiki.conversations.migrated") === "1") return [];
    const parsed = JSON.parse(raw) as { state?: { conversations?: Conversation[] }; conversations?: Conversation[] };
    const conversations = parsed.state?.conversations ?? parsed.conversations ?? [];
    return Array.isArray(conversations) ? conversations : [];
  } catch {
    return [];
  }
}

function revisionFromSnapshot(snapshot: RuntimeStatePayload): RuntimeStateRevision {
  return {
    ...EMPTY_REVISION,
    ...(snapshot.meta?.revisions ?? {}),
  };
}

function formatLocalTime(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getTaskIconType(): InboxItem["iconType"] {
  return "task";
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
    iconType: getTaskIconType(),
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
  useGoalStore.getState().applyInstanceStatusProjection(event.taskId, event.instanceId, nextStatus);
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
  useGoalStore.getState().applyInstanceProgressProjection({
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
  useGoalStore.getState().applyInstanceStatusProjection(event.taskId, event.instanceId, "paused");
  return true;
}

function refreshScheduleEventsFromSnapshot() {
  void fetchRuntimeStateSnapshot()
    .then((snapshot) => {
      useScheduleStore.getState().replaceEvents(snapshot.scheduleEvents, snapshot.meta?.revisions?.scheduleEvents);
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
    runtimeEventMetrics.duplicates += 1;
    return true;
  }
  if (dependsOnLocalInstance(event) && event.taskId && event.instanceId && !findTaskByEvent(event)) {
    pendingGoalEvents.set(event.id, event);
    runtimeEventMetrics.pending += 1;
    return false;
  }
  if (event.kind === "instance.status_changed") {
    if (applyInstanceStatusEvent(event)) {
      appliedGoalEventIds.add(event.id);
      runtimeEventMetrics.applied += 1;
      pendingGoalEvents.delete(event.id);
      return true;
    }
    appliedGoalEventIds.add(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind === "instance.progress") {
    if (applyInstanceProgressEvent(event)) {
      appliedGoalEventIds.add(event.id);
      runtimeEventMetrics.applied += 1;
      pendingGoalEvents.delete(event.id);
      return true;
    }
    appliedGoalEventIds.add(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind === "instance.timeout_paused") {
    if (applyTimeoutPausedEvent(event)) {
      appliedGoalEventIds.add(event.id);
      runtimeEventMetrics.applied += 1;
      pendingGoalEvents.delete(event.id);
      return true;
    }
    appliedGoalEventIds.add(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind === "schedule.event_synthesized") {
    refreshScheduleEventsFromSnapshot();
    appliedGoalEventIds.add(event.id);
    runtimeEventMetrics.applied += 1;
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
  runtimeEventMetrics.applied += 1;
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
    if (!notification?.userMessage) return true;
    // 单一 append 通道：messageId 必须由 worker 透传（payload.notificationId）。
    // 缺失则跳过，不再 fallback 到 instance 级稳定 id；避免历史卡片被新消息替换。
    const messageId = payload.notificationId;
    if (!messageId) return true;
    const conversationStore = useConversationStore.getState();
    const conversation = conversationStore.conversations.find((entry) => entry.id === located.goal.conversationId);
    // 幂等：同一 messageId 已存在（SSE 断线重发场景）则跳过，不做任何内容覆盖。
    if (conversation?.messages.some((message) => message.id === messageId)) return true;
    conversationStore.appendMessage(located.goal.conversationId, {
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
    });
  }
  return true;
}

// Browser state is read-only projection: writes go through command APIs and server snapshots/events.
export function RuntimeEventBridge() {
  const goals = useGoalStore((state) => state.goals);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const replaceEnvironments = useRuntimeEnvStore((state) => state.replaceEnvironments);
  const replaceEvents = useScheduleStore((state) => state.replaceEvents);
  const hydrateConversations = useConversationStore((state) => state.hydrateConversations);
  const applyConversationEvent = useConversationStore((state) => state.applyConversationEvent);

  const currentGoalsKey = useMemo(() => stableStringify(goals), [goals]);
  const currentGoalIdsKey = useMemo(() => goals.map((goal) => goal.id).sort().join("|"), [goals]);
  const isApplyingRemoteRef = useRef(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const sseDisconnectedRef = useRef(false);
  const remoteRevisionRef = useRef<RuntimeStateRevision>(EMPTY_REVISION);
  const eventCursorRef = useRef<GoalEventCursorMap>(readGoalEventCursors());
  const cursorChannelRef = useRef<BroadcastChannel | null>(null);
  const runtimeStateChannelRef = useRef<BroadcastChannel | null>(null);
  const conversationCursorRef = useRef(0);

  const refreshSnapshot = async () => {
    const snapshot = await fetchRuntimeStateSnapshot();
    const remoteRevision = revisionFromSnapshot(snapshot);
    runtimeEventMetrics.snapshotRefreshes += 1;
    remoteRevisionRef.current = remoteRevision;
    isApplyingRemoteRef.current = true;
    applyGoalsProjection(snapshot.goals, remoteRevision.goals);
    replaceEnvironments(snapshot.runtimeEnvironments, null, remoteRevision.runtimeEnvironments);
    replaceEvents(snapshot.scheduleEvents, remoteRevision.scheduleEvents);
    window.setTimeout(() => {
      isApplyingRemoteRef.current = false;
    }, 0);
  };

  const persistCursor = (goalId: string, cursor: number) => {
    const next = advanceGoalEventCursor(eventCursorRef.current, goalId, cursor);
    if (next === eventCursorRef.current) return;
    eventCursorRef.current = next;
    writeGoalEventCursors(next);
    cursorChannelRef.current?.postMessage(next);
  };

  const applyGoalEventAndAdvance = (event: GoalEventRecord) => {
    const goalId = event.goalId;
    if (event.id <= (eventCursorRef.current[goalId] ?? 0)) {
      runtimeEventMetrics.duplicates += 1;
      return true;
    }
    const applied = applyGoalEvent(event);
    if (applied) persistCursor(goalId, event.id);
    return applied;
  };

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    const startSse = () => {
      if (cancelled) return;
      source = new EventSource(`/api/conversations/events/stream?fromId=${conversationCursorRef.current}`);
      source.addEventListener("events", (message) => {
        try {
          const payload = JSON.parse((message as MessageEvent).data) as {
            events?: ConversationEventRecord[];
            nextCursor?: number;
          };
          for (const event of payload.events ?? []) {
            if (event.id <= conversationCursorRef.current) continue;
            applyConversationEvent(event);
            conversationCursorRef.current = event.id;
          }
        } catch {
          // ignore malformed conversation event payloads
        }
      });
    };
    const hydrateConversationsFromServer = async () => {
      try {
        const remote = await fetchConversationState();
        if (cancelled) return;
        conversationCursorRef.current = remote.latestEventId;
        if (remote.conversations.length === 0) {
          const legacy = readLegacyConversations();
          if (legacy.length > 0) {
            try {
              const imported = await importLegacyConversations(legacy);
              if (cancelled) return;
              hydrateConversations(imported);
              window.localStorage.setItem("kiki.conversations.migrated", "1");
              window.localStorage.removeItem("kiki.conversations");
              const after = await fetchConversationState();
              if (cancelled) return;
              conversationCursorRef.current = after.latestEventId;
              startSse();
              return;
            } catch {
              window.localStorage.setItem("kiki.conversations.migrated.failed_at", new Date().toISOString());
            }
          }
        }
        hydrateConversations(remote.conversations);
        startSse();
      } catch {
        // 会话投影失败时保留本地乐观状态，后续 SSE/轮询继续收敛。
        startSse();
      }
    };
    void hydrateConversationsFromServer();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [applyConversationEvent, hydrateConversations]);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      try {
        const snapshot = await fetchRuntimeStateSnapshot();
        if (cancelled) return;
        isApplyingRemoteRef.current = true;
        const remoteRevision = revisionFromSnapshot(snapshot);
        remoteRevisionRef.current = remoteRevision;
        applyGoalsProjection(snapshot.goals, remoteRevision.goals);
        replaceEnvironments(snapshot.runtimeEnvironments, null, remoteRevision.runtimeEnvironments);
        replaceEvents(snapshot.scheduleEvents, remoteRevision.scheduleEvents);
        for (const key of LEGACY_BUSINESS_STATE_KEYS) {
          window.localStorage.removeItem(key);
        }
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
          applyGoalsProjection(snapshot.goals, remoteRevision.goals);
          replaceEnvironments(snapshot.runtimeEnvironments, null, remoteRevision.runtimeEnvironments);
          replaceEvents(snapshot.scheduleEvents, remoteRevision.scheduleEvents);
          window.setTimeout(() => {
            isApplyingRemoteRef.current = false;
          }, 0);
        } else {
          remoteRevisionRef.current = remoteRevision;
        }
      } catch {
        // ignore polling failures
      }
    }, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyGoalsProjection, replaceEnvironments, replaceEvents]);

  useEffect(() => {
    const mergeExternalCursors = (incoming: GoalEventCursorMap) => {
      const next = mergeGoalEventCursors(eventCursorRef.current, incoming);
      if (next === eventCursorRef.current || stableStringify(next) === stableStringify(eventCursorRef.current)) return;
      eventCursorRef.current = next;
      writeGoalEventCursors(next);
      void refreshSnapshot().catch(() => {
        // Snapshot refresh is a convergence aid; SSE/polling remain active if it fails.
      });
    };

    if ("BroadcastChannel" in window) {
      cursorChannelRef.current = new BroadcastChannel(GOAL_EVENT_CURSOR_CHANNEL);
      cursorChannelRef.current.onmessage = (event) => {
        mergeExternalCursors(normalizeGoalEventCursors(event.data));
      };
      runtimeStateChannelRef.current = new BroadcastChannel(RUNTIME_STATE_CHANNEL);
      runtimeStateChannelRef.current.onmessage = (event) => {
        if (!isRuntimeStateChannelMessage(event.data)) return;
        const currentRevision = remoteRevisionRef.current[event.data.kind];
        if (event.data.revision <= currentRevision) return;
        void refreshSnapshot().catch(() => {
          // BroadcastChannel is a convergence aid; polling/SSE remain as fallback.
        });
      };
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== GOAL_EVENT_CURSOR_STORAGE_KEY) return;
      try {
        mergeExternalCursors(normalizeGoalEventCursors(JSON.parse(event.newValue ?? "{}")));
      } catch {
        // ignore malformed external cursor state
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      cursorChannelRef.current?.close();
      cursorChannelRef.current = null;
      runtimeStateChannelRef.current?.close();
      runtimeStateChannelRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const publish = () => {
      (window as RuntimeEventMetricsWindow).__KIKI_RUNTIME_EVENT_METRICS__ = { ...runtimeEventMetrics };
      window.localStorage.setItem("kiki.runtime-event.metrics.v1", JSON.stringify(runtimeEventMetrics));
    };
    publish();
    const timer = window.setInterval(publish, 10000);
    return () => window.clearInterval(timer);
  }, []);

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
          for (const event of response.events) {
            if (!applyGoalEventAndAdvance(event)) break;
          }
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
            for (const event of payload.events ?? []) {
              if (!applyGoalEventAndAdvance(event)) break;
            }
          } catch {
            // ignore malformed event payloads
          }
        });
        source.addEventListener("open", () => {
          sseDisconnectedRef.current = false;
        });
        source.addEventListener("error", () => {
          runtimeEventMetrics.sseErrors += 1;
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
      if (applyGoalEventAndAdvance(event)) {
        runtimeEventMetrics.replayed += 1;
      }
    }
  }, [bootstrapped, currentGoalsKey]);

  return null;
}
