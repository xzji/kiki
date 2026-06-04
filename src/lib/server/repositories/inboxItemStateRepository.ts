/**
 * inboxItemStateRepository — Inbox 卡片用户操作状态覆盖表（v14）。
 *
 * inbox 卡片内容仍由 goal_event_log 的 notification.delivered 事件派生；
 * 本表仅按 inbox_item_id 记录用户操作覆盖层（归档/稍后/收藏/未读），
 * 前端投影时叠加该层决定卡片分区与 unread/favorite。
 */

import { getDatabase } from "@/lib/server/db/client";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import type { Goal, InboxItem, InboxItemState, InboxItemStatus } from "@/types/kiki";

type InboxItemStateRow = {
  inbox_item_id: string;
  goal_id: string | null;
  status: InboxItemStatus;
  favorite: number;
  unread: number;
  snooze_until: string | null;
  updated_at: string;
  created_at: string;
};

type InboxDeliveredEventRow = {
  id: number;
  goal_id: string;
  task_id: string | null;
  instance_id: string | null;
  payload_json: string;
  created_at: string;
};

type InboxDeliveredPayload = {
  target?: string;
  notificationId?: string;
};

function mapRow(row: InboxItemStateRow): InboxItemState {
  return {
    inboxItemId: row.inbox_item_id,
    goalId: row.goal_id ?? undefined,
    status: row.status,
    favorite: Boolean(row.favorite),
    unread: Boolean(row.unread),
    snoozeUntil: row.snooze_until ?? undefined,
  };
}

function formatLocalTime(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function buildTaskLink(goalId: string, taskId: string, instanceId: string) {
  return `/topics/${goalId}/tasks/${taskId}?view=exec&instanceId=${instanceId}`;
}

function findTaskInstance(goals: Goal[], input: { goalId: string; taskId?: string | null; instanceId?: string | null }) {
  for (const goal of goals) {
    if (goal.id !== input.goalId) continue;
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        if (input.taskId && task.id !== input.taskId) continue;
        const instance = task.instances.find((entry) => entry.id === input.instanceId);
        if (instance) return { goal, task, instance };
      }
    }
  }
  return null;
}

function inboxItemFromDeliveredEvent(row: InboxDeliveredEventRow, goals: Goal[]): InboxItem | null {
  let payload: InboxDeliveredPayload;
  try {
    payload = JSON.parse(row.payload_json) as InboxDeliveredPayload;
  } catch {
    return null;
  }
  if (payload.target !== "inbox" || !row.task_id || !row.instance_id) return null;
  const located = findTaskInstance(goals, {
    goalId: row.goal_id,
    taskId: row.task_id,
    instanceId: row.instance_id,
  });
  const notification = located?.instance.notification;
  if (!located || !notification?.shouldNotify) return null;
  const createdAt = notification.createdAt || located.instance.createdAt || row.created_at;
  return {
    id: notification.inboxItemId || payload.notificationId || `inbox-${located.instance.id}`,
    iconType: "task",
    title: notification.title,
    snippet: notification.snippet,
    badge: notification.badge ?? null,
    unreadCount: 1,
    timeLabel: formatLocalTime(new Date(createdAt)),
    linkTo: buildTaskLink(located.goal.id, located.task.id, located.instance.id),
    goalId: located.goal.id,
    createdAt,
  };
}

export function listInboxItemStates(): InboxItemState[] {
  const rows = getDatabase()
    .prepare(`SELECT * FROM inbox_item_states ORDER BY updated_at DESC`)
    .all() as InboxItemStateRow[];
  return rows.map(mapRow);
}

export function listInboxItemsFromDeliveredEvents(): InboxItem[] {
  const goals = readGoalsSnapshot([]);
  const rows = getDatabase()
    .prepare(
      `
        SELECT id, goal_id, task_id, instance_id, payload_json, created_at
        FROM goal_event_log
        WHERE kind = 'notification.delivered'
        ORDER BY id DESC
      `,
    )
    .all() as InboxDeliveredEventRow[];
  const seen = new Set<string>();
  const items: InboxItem[] = [];
  for (const row of rows) {
    const item = inboxItemFromDeliveredEvent(row, goals);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

export function getInboxItemState(inboxItemId: string): InboxItemState | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM inbox_item_states WHERE inbox_item_id = ? LIMIT 1`)
    .get(inboxItemId) as InboxItemStateRow | undefined;
  return row ? mapRow(row) : null;
}

export type UpsertInboxItemStateInput = {
  inboxItemId: string;
  goalId?: string;
  status?: InboxItemStatus;
  favorite?: boolean;
  unread?: boolean;
  snoozeUntil?: string | null;
};

export function upsertInboxItemState(input: UpsertInboxItemStateInput): InboxItemState {
  const db = getDatabase();
  const now = new Date().toISOString();
  const existing = getInboxItemState(input.inboxItemId);

  const next: InboxItemState = {
    inboxItemId: input.inboxItemId,
    goalId: input.goalId ?? existing?.goalId,
    status: input.status ?? existing?.status ?? "active",
    favorite: input.favorite ?? existing?.favorite ?? false,
    unread: input.unread ?? existing?.unread ?? true,
    snoozeUntil:
      input.snoozeUntil === null
        ? undefined
        : input.snoozeUntil ?? existing?.snoozeUntil,
  };

  db.prepare(
    `
      INSERT INTO inbox_item_states (
        inbox_item_id, goal_id, status, favorite, unread, snooze_until, updated_at, created_at
      ) VALUES (
        @inbox_item_id, @goal_id, @status, @favorite, @unread, @snooze_until, @updated_at, @created_at
      )
      ON CONFLICT(inbox_item_id) DO UPDATE SET
        goal_id = @goal_id,
        status = @status,
        favorite = @favorite,
        unread = @unread,
        snooze_until = @snooze_until,
        updated_at = @updated_at
    `,
  ).run({
    inbox_item_id: next.inboxItemId,
    goal_id: next.goalId ?? null,
    status: next.status,
    favorite: next.favorite ? 1 : 0,
    unread: next.unread ? 1 : 0,
    snooze_until: next.snoozeUntil ?? null,
    updated_at: now,
    created_at: now,
  });

  return next;
}
