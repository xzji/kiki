"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  fetchConversationState,
  importLegacyConversations,
} from "@/lib/api/conversation-commands";
import { fetchGoalEvents } from "@/lib/api/goal-events";
import { fetchInboxBootstrap } from "@/lib/api/inbox-commands";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { createRuntimeEventsSource } from "@/lib/api/runtime-events";
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
import { useAgentRunsStore } from "@/stores/agentRunsStore";
import { useSagaInstancesStore } from "@/stores/sagaInstancesStore";
import type { Conversation, InboxItem, TaskInstance } from "@/types/kiki";
import type { GoalEventRecord } from "@/types/goalEventLog";
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
  return `/topics/${goalId}/tasks/${taskId}?view=exec&instanceId=${instanceId}`;
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

async function refreshScheduleEventsFromSnapshot() {
  const snapshot = await fetchRuntimeStateSnapshot();
  useScheduleStore.getState().replaceEvents(snapshot.scheduleEvents, snapshot.meta?.revisions?.scheduleEvents);
}

async function refreshGoalsFromSnapshot() {
  const snapshot = await fetchRuntimeStateSnapshot();
  const remoteRevision = revisionFromSnapshot(snapshot);
  useGoalStore.getState().applyGoalsProjection(snapshot.goals, remoteRevision.goals);
}

function dependsOnLocalInstance(event: GoalEventRecord) {
  return (
    event.kind === "instance.status_changed" ||
    event.kind === "instance.progress" ||
    event.kind === "instance.timeout_paused" ||
    event.kind === "notification.delivered"
  );
}

async function applyGoalEvent(event: GoalEventRecord) {
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
  if (
    event.kind === "instance.status_changed" ||
    event.kind === "instance.created" ||
    event.kind === "job.status_changed" ||
    event.kind === "instance.progress" ||
    event.kind === "instance.timeout_paused"
  ) {
    await refreshGoalsFromSnapshot();
    appliedGoalEventIds.add(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind === "schedule.event_synthesized") {
    await refreshScheduleEventsFromSnapshot();
    appliedGoalEventIds.add(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  // Topic/Thread runtime — Plan ref: §10.6 problem 26
  if (
    event.kind === "agent.run.started" ||
    event.kind === "agent.run.event" ||
    event.kind === "agent.run.completed"
  ) {
    useAgentRunsStore.getState().applyEvent({
      kind: event.kind,
      payload: event.payload as Record<string, unknown>,
    });
    appliedGoalEventIds.add(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind === "saga.step.advanced") {
    useSagaInstancesStore.getState().advance({
      payload: event.payload as Record<string, unknown>,
    });
    appliedGoalEventIds.add(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (
    event.kind === "topic.created" ||
    event.kind === "topic.updated" ||
    event.kind === "thread.tick.started" ||
    event.kind === "thread.tick.completed"
  ) {
    // P0 stage: Topic/Thread stores are introduced in PR4+; until then we
    // only acknowledge the cursor so the SSE stream keeps draining without
    // re-queueing these kinds as pending.
    appliedGoalEventIds.add(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind !== "notification.delivered") return true;
  await refreshGoalsFromSnapshot();
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
  const isApplyingRemoteRef = useRef(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [conversationHydrated, setConversationHydrated] = useState(false);
  const sseDisconnectedRef = useRef(false);
  const remoteRevisionRef = useRef<RuntimeStateRevision>(EMPTY_REVISION);
  const eventCursorRef = useRef<GoalEventCursorMap>(readGoalEventCursors());
  const cursorChannelRef = useRef<BroadcastChannel | null>(null);
  const runtimeStateChannelRef = useRef<BroadcastChannel | null>(null);
  const conversationCursorRef = useRef(0);
  const goalEventQueueRef = useRef(Promise.resolve());

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

  const applyGoalEventAndAdvance = async (event: GoalEventRecord) => {
    const goalId = event.goalId;
    if (event.id <= (eventCursorRef.current[goalId] ?? 0)) {
      runtimeEventMetrics.duplicates += 1;
      return true;
    }
    const applied = await applyGoalEvent(event);
    if (applied) persistCursor(goalId, event.id);
    return applied;
  };

  const applyGoalEventsSequentially = async (events: GoalEventRecord[]) => {
    for (const event of events) {
      const applied = await applyGoalEventAndAdvance(event);
      if (!applied) break;
    }
  };

  useEffect(() => {
    let cancelled = false;
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
              setConversationHydrated(true);
              return;
            } catch {
              window.localStorage.setItem("kiki.conversations.migrated.failed_at", new Date().toISOString());
            }
          }
        }
        hydrateConversations(remote.conversations);
        setConversationHydrated(true);
      } catch {
        // 会话投影失败时保留本地乐观状态，后续聚合 SSE/轮询继续收敛；
        // 仍标记 hydrated，让聚合 SSE 至少以本地 cursor=0 起步，并由 30s 快照兜底收敛。
        setConversationHydrated(true);
      }
    };
    void hydrateConversationsFromServer();

    return () => {
      cancelled = true;
    };
  }, [hydrateConversations]);

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
        // 先就绪 inbox 操作覆盖层，确保后续 notification.delivered 事件重投影时
        // 已归档/稍后卡片不会被拉回首页。失败静默。
        try {
          const inboxBootstrap = await fetchInboxBootstrap();
          if (!cancelled) {
            const inboxStore = useInboxStore.getState();
            inboxStore.hydrateStates(inboxBootstrap.states);
            for (const item of inboxBootstrap.items) inboxStore.upsertItem(item);
          }
        } catch {
          // ignore inbox state hydration failures
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
    if (!bootstrapped || !conversationHydrated) return;
    let cancelled = false;
    let source: EventSource | null = null;

    const computeAggregateGoalCursor = () => {
      const cursors = eventCursorRef.current;
      let max = 0;
      for (const value of Object.values(cursors)) {
        if (typeof value === "number" && value > max) max = value;
      }
      return max;
    };

    const start = async () => {
      const goalIds = useGoalStore
        .getState()
        .goals.map((goal) => goal.id);
      // 串行 await，避免一次性打开 N 个并发 HTTP 再次占满浏览器连接池。
      for (const goalId of goalIds) {
        if (cancelled) return;
        try {
          const response = await fetchGoalEvents({
            goalId,
            fromId: eventCursorRef.current[goalId] ?? 0,
            limit: 500,
          });
          if (cancelled) return;
          await applyGoalEventsSequentially(response.events);
          sseDisconnectedRef.current = false;
        } catch {
          // ignore event bootstrap failures
        }
      }
      if (cancelled) return;

      let aggregateGoalCursor = computeAggregateGoalCursor();
      source = createRuntimeEventsSource({
        goalCursor: aggregateGoalCursor,
        conversationCursor: conversationCursorRef.current,
      });
      source.addEventListener("goal-events", (message) => {
        try {
          const payload = JSON.parse((message as MessageEvent).data) as {
            events?: GoalEventRecord[];
            nextCursor?: number;
          };
          const events = payload.events ?? [];
          goalEventQueueRef.current = goalEventQueueRef.current
            .then(() => applyGoalEventsSequentially(events))
            .catch(() => {
              sseDisconnectedRef.current = true;
            });
          if (typeof payload.nextCursor === "number" && payload.nextCursor > aggregateGoalCursor) {
            aggregateGoalCursor = payload.nextCursor;
          }
        } catch {
          // ignore malformed goal event payloads
        }
      });
      source.addEventListener("conversation-events", (message) => {
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
      source.addEventListener("open", () => {
        sseDisconnectedRef.current = false;
      });
      source.addEventListener("error", () => {
        runtimeEventMetrics.sseErrors += 1;
        sseDisconnectedRef.current = true;
      });
    };

    void start();

    return () => {
      cancelled = true;
      source?.close();
      source = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapped, conversationHydrated]);

  useEffect(() => {
    if (!bootstrapped || pendingGoalEvents.size === 0) return;
    const events = Array.from(pendingGoalEvents.values());
    goalEventQueueRef.current = goalEventQueueRef.current
      .then(async () => {
        for (const event of events) {
          const applied = await applyGoalEventAndAdvance(event);
          if (applied) runtimeEventMetrics.replayed += 1;
        }
      })
      .catch(() => {
        sseDisconnectedRef.current = true;
      });
  }, [bootstrapped, currentGoalsKey]);

  return null;
}
