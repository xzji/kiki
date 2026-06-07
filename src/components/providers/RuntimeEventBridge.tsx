"use client";

import { useEffect, useRef, useState } from "react";

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
import { formatMessageTime } from "@/lib/date";
import type { RuntimeStatePayload, RuntimeStateRevision } from "@/lib/api/runtime-daemon";
import { useConversationStore } from "@/stores/conversationStore";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import { useScheduleStore } from "@/stores/scheduleStore";
import { useAgentRunsStore } from "@/stores/agentRunsStore";
import { useSagaInstancesStore } from "@/stores/sagaInstancesStore";
import type { Conversation, InboxItem } from "@/types/kiki";
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
// 已应用事件 id 仅作 cursor 之外的二级去重；事件 id 全局单调递增，且 applyGoalEventAndAdvance
// 已用 per-goal cursor 拦截旧事件，故超过上限时按最小 id（最旧）淘汰是安全的，防止长程运行无界增长。
const APPLIED_GOAL_EVENT_IDS_MAX = 5000;

function rememberAppliedGoalEventId(id: number) {
  appliedGoalEventIds.add(id);
  if (appliedGoalEventIds.size <= APPLIED_GOAL_EVENT_IDS_MAX) return;
  const overflow = appliedGoalEventIds.size - APPLIED_GOAL_EVENT_IDS_MAX;
  const iterator = appliedGoalEventIds.values();
  for (let i = 0; i < overflow; i += 1) {
    const next = iterator.next();
    if (next.done) break;
    appliedGoalEventIds.delete(next.value);
  }
}

// pending 队列存放依赖本地实例但实例尚未投影到位的事件，等待 goals 刷新后重放。
// 正常路径下会很快被消费/删除；设上限防止异常场景（实例永不出现）下无界堆积。
const PENDING_GOAL_EVENTS_MAX = 2000;

function rememberPendingGoalEvent(event: GoalEventRecord) {
  pendingGoalEvents.set(event.id, event);
  if (pendingGoalEvents.size <= PENDING_GOAL_EVENTS_MAX) return;
  const overflow = pendingGoalEvents.size - PENDING_GOAL_EVENTS_MAX;
  const iterator = pendingGoalEvents.keys();
  for (let i = 0; i < overflow; i += 1) {
    const next = iterator.next();
    if (next.done) break;
    pendingGoalEvents.delete(next.value);
  }
}
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

// SSE 连接建立后服务端会以多批 goal-events 回填初始事件（实测各批间隔约 85ms），逐批各自拉取一次全量
// 快照会形成串行 /api/runtime/state 瀑布。用固定窗口去抖把窗口内多批事件的收敛刷新合并为一次拉取：
// 窗口取 200ms 以覆盖服务端的批间隔，既消除瀑布又把后台收敛延迟控制在不可感知范围内。
const SSE_REFRESH_COALESCE_MS = 200;

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
    timeLabel: formatMessageTime(notification.createdAt || input.instance.createdAt),
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
    timeLabel: formatMessageTime(createdAt),
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

// 这些事件类型只需重新拉取一次完整 goals 快照即可收敛——/api/runtime/state 始终返回最新全量状态，
// 因此同一批事件内多次拉取结果一致。用于把"每条事件一次全量刷新"合并为"每批一次"。
// notification.delivered 也计入：批量模式下其处理器不再自行内联刷新，需由批级合并刷新统一收敛
// （刷新会 bump goalProjectionRevision，从而触发 pending 重试构建收件箱/会话卡片）。
function eventNeedsGoalsRefresh(event: GoalEventRecord) {
  return (
    event.kind === "instance.status_changed" ||
    event.kind === "instance.created" ||
    event.kind === "job.status_changed" ||
    event.kind === "instance.progress" ||
    event.kind === "instance.timeout_paused" ||
    event.kind === "notification.delivered"
  );
}

function eventNeedsScheduleRefresh(event: GoalEventRecord) {
  return event.kind === "schedule.event_synthesized";
}

async function applyGoalEvent(event: GoalEventRecord, options?: { refreshSnapshot?: boolean }) {
  const refreshSnapshot = options?.refreshSnapshot ?? true;
  if (appliedGoalEventIds.has(event.id)) {
    pendingGoalEvents.delete(event.id);
    runtimeEventMetrics.duplicates += 1;
    return true;
  }
  if (dependsOnLocalInstance(event) && event.taskId && event.instanceId && !findTaskByEvent(event)) {
    rememberPendingGoalEvent(event);
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
    // 批量回放时跳过内联全量拉取，由批末统一刷新一次，避免 N+1 串行快照请求。
    if (refreshSnapshot) await refreshGoalsFromSnapshot();
    rememberAppliedGoalEventId(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind === "schedule.event_synthesized") {
    if (refreshSnapshot) await refreshScheduleEventsFromSnapshot();
    rememberAppliedGoalEventId(event.id);
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
    rememberAppliedGoalEventId(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind === "saga.step.advanced") {
    useSagaInstancesStore.getState().advance({
      payload: event.payload as Record<string, unknown>,
    });
    rememberAppliedGoalEventId(event.id);
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
    rememberAppliedGoalEventId(event.id);
    runtimeEventMetrics.applied += 1;
    pendingGoalEvents.delete(event.id);
    return true;
  }
  if (event.kind !== "notification.delivered") return true;
  // 仅在调用方未声明「批量/延迟刷新」时才内联拉取快照。批量回放（启动/SSE）时 store 已由 hydrate
  // 或批级合并刷新保持最新，这里无需逐条再各自拉取，否则会形成多条 notification.delivered 的串行
  // /api/runtime/state 瀑布。若此时 store 仍缺该实例，下方 findTaskByEvent 会落入 pending 重试兜底。
  if (refreshSnapshot) await refreshGoalsFromSnapshot();
  const located = findTaskByEvent(event);
  if (!located) {
    rememberPendingGoalEvent(event);
    return false;
  }
  rememberAppliedGoalEventId(event.id);
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
  const goalProjectionRevision = useGoalStore((state) => state.goalProjectionRevision);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const replaceEnvironments = useRuntimeEnvStore((state) => state.replaceEnvironments);
  const replaceEvents = useScheduleStore((state) => state.replaceEvents);
  const hydrateConversations = useConversationStore((state) => state.hydrateConversations);
  const applyConversationEvent = useConversationStore((state) => state.applyConversationEvent);

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
  const sseRefreshTimerRef = useRef<number | null>(null);
  const sseRefreshPendingRef = useRef<{ goals: boolean; schedule: boolean }>({ goals: false, schedule: false });

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

  const applyGoalEventAndAdvance = async (event: GoalEventRecord, options?: { refreshSnapshot?: boolean }) => {
    const goalId = event.goalId;
    if (event.id <= (eventCursorRef.current[goalId] ?? 0)) {
      runtimeEventMetrics.duplicates += 1;
      return true;
    }
    const applied = await applyGoalEvent(event, options);
    if (applied) persistCursor(goalId, event.id);
    return applied;
  };

  const applyGoalEventsSequentially = async (
    events: GoalEventRecord[],
    options?: { deferRefresh?: boolean },
  ) => {
    // 批量回放：逐条事件不再各自全量拉取快照，统计本批是否涉及 goals/schedule 刷新，
    // 在批末合并为一次拉取，消除回放历史事件时的 N+1 串行 /api/runtime/state 瀑布。
    // deferRefresh=true 时不在本批末刷新，而是把刷新需求返回给调用方，由其跨多批合并为一次拉取
    // （启动阶段多个目标的历史回放共用一次收敛刷新）。
    const deferRefresh = options?.deferRefresh ?? false;
    let needGoalsRefresh = false;
    let needScheduleRefresh = false;
    for (const event of events) {
      // 仅当事件是「首次应用」时才计入收敛刷新需求。SSE 初始回填会重发已在启动回放中应用过的事件，
      // 这些重复事件不应再触发全量快照拉取，否则会形成多次冗余的串行 /api/runtime/state。
      const isDuplicate =
        appliedGoalEventIds.has(event.id) || event.id <= (eventCursorRef.current[event.goalId] ?? 0);
      const applied = await applyGoalEventAndAdvance(event, { refreshSnapshot: false });
      if (!applied) break;
      if (isDuplicate) continue;
      if (eventNeedsGoalsRefresh(event)) needGoalsRefresh = true;
      if (eventNeedsScheduleRefresh(event)) needScheduleRefresh = true;
    }
    if (!deferRefresh) {
      if (needGoalsRefresh) await refreshGoalsFromSnapshot();
      if (needScheduleRefresh) await refreshScheduleEventsFromSnapshot();
    }
    return { needGoalsRefresh, needScheduleRefresh };
  };

  // SSE 实时事件的收敛刷新去抖：把短时间内多批事件的刷新需求累计到 sseRefreshPendingRef，
  // 在 SSE_REFRESH_COALESCE_MS 后合并成一次快照拉取，避免逐批各自一次 /api/runtime/state 的串行瀑布。
  const scheduleCoalescedRefresh = (need: { goals: boolean; schedule: boolean }) => {
    if (!need.goals && !need.schedule) return;
    sseRefreshPendingRef.current.goals = sseRefreshPendingRef.current.goals || need.goals;
    sseRefreshPendingRef.current.schedule = sseRefreshPendingRef.current.schedule || need.schedule;
    if (sseRefreshTimerRef.current !== null) return;
    sseRefreshTimerRef.current = window.setTimeout(() => {
      sseRefreshTimerRef.current = null;
      const pending = sseRefreshPendingRef.current;
      sseRefreshPendingRef.current = { goals: false, schedule: false };
      goalEventQueueRef.current = goalEventQueueRef.current
        .then(async () => {
          if (pending.goals) await refreshGoalsFromSnapshot();
          if (pending.schedule) await refreshScheduleEventsFromSnapshot();
        })
        .catch(() => {
          sseDisconnectedRef.current = true;
        });
    }, SSE_REFRESH_COALESCE_MS);
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
      // 并行拉取各目标的历史事件（仅 N 个只读 GET，互不依赖），避免逐目标串行往返的启动瀑布。
      const responses = await Promise.all(
        goalIds.map((goalId) =>
          fetchGoalEvents({
            goalId,
            fromId: eventCursorRef.current[goalId] ?? 0,
            limit: 500,
          })
            .then((response) => ({ goalId, response }))
            .catch(() => null),
        ),
      );
      if (cancelled) return;
      // 历史回放按目标顺序应用以保证因果，但把各目标的收敛刷新需求合并为一次快照拉取，
      // 消除"每目标一次 /api/runtime/state"的尾部串行瀑布。
      let needGoalsRefresh = false;
      let needScheduleRefresh = false;
      for (const item of responses) {
        if (cancelled) return;
        if (!item) continue;
        const result = await applyGoalEventsSequentially(item.response.events, { deferRefresh: true });
        needGoalsRefresh = needGoalsRefresh || result.needGoalsRefresh;
        needScheduleRefresh = needScheduleRefresh || result.needScheduleRefresh;
        sseDisconnectedRef.current = false;
      }
      if (cancelled) return;
      if (needGoalsRefresh) await refreshGoalsFromSnapshot();
      if (needScheduleRefresh) await refreshScheduleEventsFromSnapshot();
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
            .then(async () => {
              const result = await applyGoalEventsSequentially(events, { deferRefresh: true });
              // 不在本批末同步拉取快照，改为去抖合并；多批 SSE 初始回填只触发一次 /api/runtime/state。
              scheduleCoalescedRefresh({ goals: result.needGoalsRefresh, schedule: result.needScheduleRefresh });
            })
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
      if (sseRefreshTimerRef.current !== null) {
        window.clearTimeout(sseRefreshTimerRef.current);
        sseRefreshTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapped, conversationHydrated]);

  useEffect(() => {
    if (!bootstrapped || pendingGoalEvents.size === 0) return;
    const events = Array.from(pendingGoalEvents.values());
    goalEventQueueRef.current = goalEventQueueRef.current
      .then(async () => {
        // 逐条应用但不各自内联拉取快照；这些 instance.* 事件的应用语义即「触发一次收敛刷新」，
        // 因此收集刷新需求后用去抖合并为一次拉取，避免「每条 pending 事件一次 /api/runtime/state」的串行尾巴。
        let needGoalsRefresh = false;
        let needScheduleRefresh = false;
        for (const event of events) {
          const isDuplicate =
            appliedGoalEventIds.has(event.id) || event.id <= (eventCursorRef.current[event.goalId] ?? 0);
          const applied = await applyGoalEventAndAdvance(event, { refreshSnapshot: false });
          if (applied) {
            runtimeEventMetrics.replayed += 1;
            if (!isDuplicate) {
              if (eventNeedsGoalsRefresh(event)) needGoalsRefresh = true;
              if (eventNeedsScheduleRefresh(event)) needScheduleRefresh = true;
            }
          }
        }
        scheduleCoalescedRefresh({ goals: needGoalsRefresh, schedule: needScheduleRefresh });
      })
      .catch(() => {
        sseDisconnectedRef.current = true;
      });
  }, [bootstrapped, goalProjectionRevision]);

  return null;
}
