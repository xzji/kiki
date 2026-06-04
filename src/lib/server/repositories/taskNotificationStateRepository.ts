import { normalizeGoalId, normalizeInstanceId, normalizeTaskId } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import {
  normalizeNotificationFromProgress,
  notificationContentHash,
} from "@/lib/server/runtime/goalStateSnapshot";
import type { GoalServerProgress } from "@/types/goalTelemetry";
import type { Goal, TaskInstance, TaskInstanceNotificationState } from "@/types/kiki";

type TaskNotificationStateRow = {
  instance_id: string;
  goal_id: string | null;
  task_id: string | null;
  notification_json: string;
  delivery_state: TaskInstanceNotificationState["deliveryState"];
  notification_sequence: number;
  inbox_item_id: string | null;
  conversation_message_ids_json: string | null;
  delivered_at: string | null;
  updated_at: string;
  created_at: string;
};

export type TaskNotificationStateRecord = {
  instanceId: string;
  goalId?: string;
  taskId?: string;
  notification: TaskInstanceNotificationState;
  updatedAt: string;
  createdAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

function parseConversationMessageIds(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : undefined;
  } catch {
    return undefined;
  }
}

function mapRow(row: TaskNotificationStateRow): TaskNotificationStateRecord {
  const notification = JSON.parse(row.notification_json) as TaskInstanceNotificationState;
  const pushedConversationMessageIds =
    notification.pushedConversationMessageIds ?? parseConversationMessageIds(row.conversation_message_ids_json);
  return {
    instanceId: normalizeInstanceId(row.instance_id),
    goalId: row.goal_id ? normalizeGoalId(row.goal_id) : undefined,
    taskId: row.task_id ? normalizeTaskId(row.task_id) : undefined,
    notification: {
      ...notification,
      deliveryState: row.delivery_state,
      deliveredAt: row.delivered_at ?? notification.deliveredAt,
      inboxItemId: row.inbox_item_id ?? notification.inboxItemId,
      notificationSequence: row.notification_sequence,
      pushedConversationMessageIds,
    },
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export function upsertTaskNotificationState(input: {
  goalId?: string;
  taskId?: string;
  instanceId: string;
  notification: TaskInstanceNotificationState;
}) {
  const db = getDatabase();
  const now = nowIso();
  const existing = getTaskNotificationStateByInstanceId(input.instanceId);
  const createdAt = existing?.createdAt ?? now;
  const sequence = input.notification.notificationSequence ?? existing?.notification.notificationSequence ?? 0;
  const notification: TaskInstanceNotificationState = {
    ...input.notification,
    notificationSequence: sequence,
  };
  db.prepare(
    `
      INSERT INTO task_notification_states (
        instance_id, goal_id, task_id, notification_json, delivery_state, notification_sequence,
        inbox_item_id, conversation_message_ids_json, delivered_at, updated_at, created_at
      ) VALUES (
        @instance_id, @goal_id, @task_id, @notification_json, @delivery_state, @notification_sequence,
        @inbox_item_id, @conversation_message_ids_json, @delivered_at, @updated_at, @created_at
      )
      ON CONFLICT(instance_id) DO UPDATE SET
        goal_id = excluded.goal_id,
        task_id = excluded.task_id,
        notification_json = excluded.notification_json,
        delivery_state = excluded.delivery_state,
        notification_sequence = excluded.notification_sequence,
        inbox_item_id = excluded.inbox_item_id,
        conversation_message_ids_json = excluded.conversation_message_ids_json,
        delivered_at = excluded.delivered_at,
        updated_at = excluded.updated_at
    `,
  ).run({
    instance_id: normalizeInstanceId(input.instanceId),
    goal_id: input.goalId ? normalizeGoalId(input.goalId) : null,
    task_id: input.taskId ? normalizeTaskId(input.taskId) : null,
    notification_json: JSON.stringify(notification),
    delivery_state: notification.deliveryState,
    notification_sequence: sequence,
    inbox_item_id: notification.inboxItemId ?? null,
    conversation_message_ids_json: notification.pushedConversationMessageIds
      ? JSON.stringify(notification.pushedConversationMessageIds)
      : null,
    delivered_at: notification.deliveredAt ?? null,
    updated_at: now,
    created_at: createdAt,
  });
  return getTaskNotificationStateByInstanceId(input.instanceId);
}

export function upsertTaskNotificationStateFromProgress(input: {
  goalId?: string;
  taskId?: string;
  instance: TaskInstance;
  progress: GoalServerProgress | null;
}) {
  const existing = getTaskNotificationStateByInstanceId(input.instance.id);
  const baseInstance = existing
    ? {
        ...input.instance,
        notification: existing.notification,
      }
    : input.instance;
  const notification = normalizeNotificationFromProgress(input.progress, baseInstance);
  if (!notification) return null;
  return upsertTaskNotificationState({
    goalId: input.goalId,
    taskId: input.taskId,
    instanceId: input.instance.id,
    notification,
  });
}

export function getTaskNotificationStateByInstanceId(instanceId: string) {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM task_notification_states WHERE instance_id = ? LIMIT 1`)
    .get(normalizeInstanceId(instanceId)) as TaskNotificationStateRow | undefined;
  return row ? mapRow(row) : null;
}

export function listTaskNotificationStatesByInstanceIds(instanceIds: string[]) {
  const uniqueIds = Array.from(new Set(instanceIds.filter(Boolean).map((id) => normalizeInstanceId(id))));
  if (uniqueIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM task_notification_states WHERE instance_id IN (${placeholders})`)
    .all(...uniqueIds) as TaskNotificationStateRow[];
  return rows.map((row) => mapRow(row));
}

export function listPendingTaskNotificationStates() {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT * FROM task_notification_states
        WHERE delivery_state = 'pending'
        ORDER BY updated_at ASC
      `,
    )
    .all() as TaskNotificationStateRow[];
  return rows.map((row) => mapRow(row));
}

export function markTaskNotificationDeliveredState(input: {
  instanceId: string;
  inboxItemId?: string;
  conversationMessageId?: string;
  notificationSequence?: number;
}) {
  const existing = getTaskNotificationStateByInstanceId(input.instanceId);
  if (!existing) return null;
  const now = nowIso();
  const previousIds = existing.notification.pushedConversationMessageIds ?? [];
  const nextPushedIds = input.conversationMessageId
    ? Array.from(new Set([...previousIds, input.conversationMessageId]))
    : previousIds;
  const sequence = input.notificationSequence ?? existing.notification.notificationSequence ?? 0;
  const notification: TaskInstanceNotificationState = {
    ...existing.notification,
    deliveryState: "delivered",
    deliveredAt: now,
    inboxItemId: input.inboxItemId ?? existing.notification.inboxItemId,
    conversationMessageId: input.conversationMessageId ?? existing.notification.conversationMessageId,
    notificationSequence: sequence,
    pushedConversationMessageIds: nextPushedIds,
    lastDeliveredHash: notificationContentHash(existing.notification),
  };
  return upsertTaskNotificationState({
    goalId: existing.goalId,
    taskId: existing.taskId,
    instanceId: existing.instanceId,
    notification,
  });
}

export function backfillTaskNotificationStatesFromGoals(goals: Goal[]) {
  let changed = 0;
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          if (!instance.notification) continue;
          const existing = getTaskNotificationStateByInstanceId(instance.id);
          if (existing) continue;
          upsertTaskNotificationState({
            goalId: goal.id,
            taskId: task.id,
            instanceId: instance.id,
            notification: instance.notification,
          });
          changed += 1;
        }
      }
    }
  }
  return { changed };
}
