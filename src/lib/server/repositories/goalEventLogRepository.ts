import { normalizeGoalId, normalizeInstanceId, normalizeTaskId } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import { createEventLogRepository } from "@/lib/server/repositories/eventLogRepositoryFactory";
import type { GoalEventKind, GoalEventPayload, GoalEventProducer, GoalEventRecord } from "@/types/goalEventLog";

type GoalEventLogRow = {
  id: number;
  event_id: string;
  goal_id: string;
  task_id: string | null;
  instance_id: string | null;
  kind: GoalEventKind;
  payload_json: string;
  produced_by: GoalEventProducer;
  idempotency_key: string | null;
  created_at: string;
};

export type AppendGoalEventInput<K extends GoalEventKind = GoalEventKind> = {
  eventId?: string;
  goalId: string;
  taskId?: string;
  instanceId?: string;
  kind: K;
  payload: GoalEventPayload<K>;
  producedBy: GoalEventProducer;
  idempotencyKey?: string;
  createdAt?: string;
};

function mapRow<K extends GoalEventKind = GoalEventKind>(row: GoalEventLogRow): GoalEventRecord<K> {
  return {
    id: row.id,
    eventId: row.event_id,
    goalId: normalizeGoalId(row.goal_id),
    taskId: row.task_id ? normalizeTaskId(row.task_id) : undefined,
    instanceId: row.instance_id ? normalizeInstanceId(row.instance_id) : undefined,
    kind: row.kind as K,
    payload: JSON.parse(row.payload_json) as GoalEventPayload<K>,
    producedBy: row.produced_by,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at,
  };
}

const repository = createEventLogRepository<GoalEventLogRow, GoalEventRecord, AppendGoalEventInput>({
  table: "goal_event_log",
  eventIdPrefix: "goal-event",
  ownerColumns: ["goal_id", "task_id", "instance_id"],
  toOwnerParams: (input) => ({
    goal_id: normalizeGoalId(input.goalId),
    task_id: input.taskId ? normalizeTaskId(input.taskId) : null,
    instance_id: input.instanceId ? normalizeInstanceId(input.instanceId) : null,
  }),
  mapRow,
});

export function appendGoalEvent<K extends GoalEventKind>(input: AppendGoalEventInput<K>) {
  return repository.append(input) as GoalEventRecord<K> | null;
}

export function getGoalEventByIdempotencyKey<K extends GoalEventKind = GoalEventKind>(idempotencyKey: string) {
  return repository.getByIdempotencyKey(idempotencyKey) as GoalEventRecord<K> | null;
}

export function appendGoalEventOnce<K extends GoalEventKind>(input: AppendGoalEventInput<K>) {
  return repository.appendOnce(input) as GoalEventRecord<K> | null;
}

export function getGoalEvents(input: { goalId: string; fromId?: number; limit?: number }) {
  const db = getDatabase();
  const normalizedGoalId = normalizeGoalId(input.goalId);
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  // 把 goal_id 过滤与 LIMIT 下推到 SQL，命中 idx_goal_event_log_goal(goal_id, id)，
  // 避免全表 SELECT * + JS 端逐行 JSON.parse 再 filter/slice。
  const rows = db
    .prepare(
      `
        SELECT * FROM goal_event_log
        WHERE goal_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?
      `,
    )
    .all(normalizedGoalId, input.fromId ?? 0, limit) as GoalEventLogRow[];
  return rows.map((row) => mapRow(row));
}

export function getGoalEventsSince(input: { fromId?: number; limit?: number }) {
  const db = getDatabase();
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const rows = db
    .prepare(
      `
        SELECT * FROM goal_event_log
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?
      `,
    )
    .all(input.fromId ?? 0, limit) as GoalEventLogRow[];
  return rows.map((row) => mapRow(row));
}

export function getLatestGoalEventId(goalId: string) {
  const db = getDatabase();
  const normalizedGoalId = normalizeGoalId(goalId);
  // 用聚合 MAX(id) 命中索引取最新 id，避免全表 SELECT * + 逐行 mapRow（与 conversationEventLog 写法对齐）。
  const row = db
    .prepare(`SELECT MAX(id) AS id FROM goal_event_log WHERE goal_id = ?`)
    .get(normalizedGoalId) as { id: number | null };
  return row.id ?? 0;
}
