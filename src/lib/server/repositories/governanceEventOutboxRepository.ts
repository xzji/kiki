import { normalizeGoalId, normalizeInstanceId, normalizeSubGoalId, normalizeTaskId } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import type { EventSourceKind } from "@/types/trigger";

export type GovernanceEventType =
  | "thread_governance_tick_requested"
  | "task_completed"
  | "task_failed"
  | "user_replied";

export type GovernanceEventOutboxRecord<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  id: number;
  eventId: string;
  eventType: GovernanceEventType;
  source: EventSourceKind;
  topicId?: string;
  threadId?: string;
  taskId?: string;
  instanceId?: string;
  payload: TPayload;
  idempotencyKey?: string;
  createdAt: string;
};

export type AppendGovernanceEventInput<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  eventId?: string;
  eventType: GovernanceEventType;
  source: EventSourceKind;
  topicId?: string;
  threadId?: string;
  taskId?: string;
  instanceId?: string;
  payload?: TPayload;
  idempotencyKey?: string;
  createdAt?: string;
};

type GovernanceEventOutboxRow = {
  id: number;
  event_id: string;
  event_type: GovernanceEventType;
  source: EventSourceKind;
  topic_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  instance_id: string | null;
  payload_json: string;
  idempotency_key: string | null;
  created_at: string;
};

const DEFAULT_CONSUMER = "default";

function nowIso() {
  return new Date().toISOString();
}

function createEventId() {
  return `governance-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTopicId(value: string | undefined) {
  return value ? normalizeGoalId(value) : undefined;
}

function normalizeThreadId(value: string | undefined) {
  return value ? normalizeSubGoalId(value) : undefined;
}

function mapRow<TPayload extends Record<string, unknown> = Record<string, unknown>>(
  row: GovernanceEventOutboxRow,
): GovernanceEventOutboxRecord<TPayload> {
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    source: row.source,
    topicId: row.topic_id ? normalizeGoalId(row.topic_id) : undefined,
    threadId: row.thread_id ? normalizeSubGoalId(row.thread_id) : undefined,
    taskId: row.task_id ? normalizeTaskId(row.task_id) : undefined,
    instanceId: row.instance_id ? normalizeInstanceId(row.instance_id) : undefined,
    payload: JSON.parse(row.payload_json) as TPayload,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at,
  };
}

function getByEventId(eventId: string) {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM governance_event_outbox WHERE event_id = ? LIMIT 1`)
    .get(eventId) as GovernanceEventOutboxRow | undefined;
  return row ? mapRow(row) : null;
}

export function getGovernanceEventByIdempotencyKey(idempotencyKey: string) {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM governance_event_outbox WHERE idempotency_key = ? LIMIT 1`)
    .get(idempotencyKey) as GovernanceEventOutboxRow | undefined;
  return row ? mapRow(row) : null;
}

export function appendGovernanceEvent<TPayload extends Record<string, unknown> = Record<string, unknown>>(
  input: AppendGovernanceEventInput<TPayload>,
): GovernanceEventOutboxRecord<TPayload> {
  const db = getDatabase();
  const eventId = input.eventId ?? createEventId();
  const createdAt = input.createdAt ?? nowIso();
  const topicId = normalizeTopicId(input.topicId);
  const threadId = normalizeThreadId(input.threadId);
  const taskId = input.taskId ? normalizeTaskId(input.taskId) : undefined;
  const instanceId = input.instanceId ? normalizeInstanceId(input.instanceId) : undefined;

  db.prepare(
    `
      INSERT OR IGNORE INTO governance_event_outbox (
        event_id, event_type, source, topic_id, thread_id, task_id, instance_id,
        payload_json, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    eventId,
    input.eventType,
    input.source,
    topicId ?? null,
    threadId ?? null,
    taskId ?? null,
    instanceId ?? null,
    JSON.stringify(input.payload ?? {}),
    input.idempotencyKey ?? null,
    createdAt,
  );

  const record = input.idempotencyKey
    ? getGovernanceEventByIdempotencyKey(input.idempotencyKey)
    : getByEventId(eventId);
  if (!record) {
    throw new Error("governance event outbox append failed");
  }
  return record as GovernanceEventOutboxRecord<TPayload>;
}

export function listPendingGovernanceEvents(input: {
  consumer?: string;
  afterId?: number;
  limit?: number;
  eventTypes?: GovernanceEventType[];
} = {}) {
  const db = getDatabase();
  const consumer = input.consumer ?? DEFAULT_CONSUMER;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const params: Array<string | number> = [consumer, input.afterId ?? 0];
  const eventTypeFilter = input.eventTypes?.length
    ? `AND o.event_type IN (${input.eventTypes.map(() => "?").join(", ")})`
    : "";
  if (input.eventTypes?.length) params.push(...input.eventTypes);
  params.push(limit);

  const rows = db
    .prepare(
      `
        SELECT o.*
        FROM governance_event_outbox o
        LEFT JOIN governance_event_outbox_consumption c
          ON c.event_id = o.event_id AND c.consumer = ?
        WHERE c.event_id IS NULL
          AND o.id > ?
          ${eventTypeFilter}
        ORDER BY o.id ASC
        LIMIT ?
      `,
    )
    .all(...params) as GovernanceEventOutboxRow[];
  return rows.map((row) => mapRow(row));
}

export function markGovernanceEventConsumed(input: {
  eventId: string;
  consumer?: string;
  consumedAt?: string;
}) {
  const db = getDatabase();
  const consumedAt = input.consumedAt ?? nowIso();
  const consumer = input.consumer ?? DEFAULT_CONSUMER;
  db.prepare(
    `
      INSERT INTO governance_event_outbox_consumption (event_id, consumer, consumed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(event_id, consumer) DO UPDATE SET consumed_at = consumed_at
    `,
  ).run(input.eventId, consumer, consumedAt);
  return { eventId: input.eventId, consumer, consumedAt };
}

export function countPendingGovernanceEventBridgeDeliveries() {
  const row = getDatabase()
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM governance_event_outbox o
        WHERE (
            o.event_type IN ('thread_governance_tick_requested', 'task_completed', 'task_failed', 'user_replied')
            AND NOT EXISTS (
              SELECT 1
              FROM governance_event_outbox_consumption c
              WHERE c.event_id = o.event_id
                AND c.consumer = 'thread-event-bridge'
            )
          )
          OR (
            o.event_type IN ('task_completed', 'task_failed', 'user_replied')
            AND NOT EXISTS (
              SELECT 1
              FROM governance_event_outbox_consumption c
              WHERE c.event_id = o.event_id
                AND c.consumer = 'topic-event-bridge'
            )
          )
          OR (
            o.event_type IN ('task_completed', 'task_failed', 'user_replied')
            AND NOT EXISTS (
              SELECT 1
              FROM governance_event_outbox_consumption c
              WHERE c.event_id = o.event_id
                AND c.consumer = 'task-event-bridge'
            )
          )
      `,
    )
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}
