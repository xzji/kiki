import { randomUUID } from "crypto";

import { normalizeGoalId, normalizeInstanceId, normalizeTaskId } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
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

function nowIso() {
  return new Date().toISOString();
}

function createEventId() {
  return `goal-event-${randomUUID()}`;
}

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

export function appendGoalEvent<K extends GoalEventKind>(input: AppendGoalEventInput<K>) {
  const db = getDatabase();
  const eventId = input.eventId ?? createEventId();
  const createdAt = input.createdAt ?? nowIso();
  db.prepare(
    `
      INSERT INTO goal_event_log (
        event_id, goal_id, task_id, instance_id, kind, payload_json, produced_by, idempotency_key, created_at
      ) VALUES (
        @event_id, @goal_id, @task_id, @instance_id, @kind, @payload_json, @produced_by, @idempotency_key, @created_at
      )
      ON CONFLICT(event_id) DO NOTHING
    `,
  ).run({
    event_id: eventId,
    goal_id: normalizeGoalId(input.goalId),
    task_id: input.taskId ? normalizeTaskId(input.taskId) : null,
    instance_id: input.instanceId ? normalizeInstanceId(input.instanceId) : null,
    kind: input.kind,
    payload_json: JSON.stringify(input.payload),
    produced_by: input.producedBy,
    idempotency_key: input.idempotencyKey ?? null,
    created_at: createdAt,
  });
  const row = db
    .prepare(`SELECT * FROM goal_event_log WHERE event_id = ? LIMIT 1`)
    .get(eventId) as GoalEventLogRow | undefined;
  return row ? mapRow<K>(row) : null;
}

export function getGoalEventByIdempotencyKey<K extends GoalEventKind = GoalEventKind>(idempotencyKey: string) {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM goal_event_log WHERE idempotency_key = ? LIMIT 1`)
    .get(idempotencyKey) as GoalEventLogRow | undefined;
  return row ? mapRow<K>(row) : null;
}

export function appendGoalEventOnce<K extends GoalEventKind>(input: AppendGoalEventInput<K>) {
  if (!input.idempotencyKey) return appendGoalEvent(input);
  const db = getDatabase();
  const existing = getGoalEventByIdempotencyKey<K>(input.idempotencyKey);
  if (existing) return existing;
  const eventId = input.eventId ?? createEventId();
  const createdAt = input.createdAt ?? nowIso();
  db.prepare(
    `
      INSERT OR IGNORE INTO goal_event_log (
        event_id, goal_id, task_id, instance_id, kind, payload_json, produced_by, idempotency_key, created_at
      ) VALUES (
        @event_id, @goal_id, @task_id, @instance_id, @kind, @payload_json, @produced_by, @idempotency_key, @created_at
      )
    `,
  ).run({
    event_id: eventId,
    goal_id: normalizeGoalId(input.goalId),
    task_id: input.taskId ? normalizeTaskId(input.taskId) : null,
    instance_id: input.instanceId ? normalizeInstanceId(input.instanceId) : null,
    kind: input.kind,
    payload_json: JSON.stringify(input.payload),
    produced_by: input.producedBy,
    idempotency_key: input.idempotencyKey,
    created_at: createdAt,
  });
  const row = db
    .prepare(`SELECT * FROM goal_event_log WHERE idempotency_key = ? LIMIT 1`)
    .get(input.idempotencyKey) as GoalEventLogRow | undefined;
  return row ? mapRow<K>(row) : null;
}

export function getGoalEvents(input: { goalId: string; fromId?: number; limit?: number }) {
  const db = getDatabase();
  const normalizedGoalId = normalizeGoalId(input.goalId);
  const rows = db
    .prepare(
      `
        SELECT * FROM goal_event_log
        WHERE id > ?
        ORDER BY id ASC
      `,
    )
    .all(input.fromId ?? 0) as GoalEventLogRow[];
  return rows
    .map((row) => mapRow(row))
    .filter((event) => event.goalId === normalizedGoalId)
    .slice(0, input.limit ?? 200);
}

export function getLatestGoalEventId(goalId: string) {
  const db = getDatabase();
  const normalizedGoalId = normalizeGoalId(goalId);
  const rows = db.prepare(`SELECT * FROM goal_event_log ORDER BY id DESC`).all() as GoalEventLogRow[];
  const row = rows.find((candidate) => mapRow(candidate).goalId === normalizedGoalId);
  return row?.id ?? 0;
}
