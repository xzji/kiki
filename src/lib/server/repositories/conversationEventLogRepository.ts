import { randomUUID } from "crypto";

import { getDatabase } from "@/lib/server/db/client";
import type {
  ConversationEventKind,
  ConversationEventPayload,
  ConversationEventProducer,
  ConversationEventRecord,
} from "@/types/conversationEventLog";

type ConversationEventLogRow = {
  id: number;
  event_id: string;
  conversation_id: string;
  kind: ConversationEventKind;
  payload_json: string;
  produced_by: ConversationEventProducer;
  idempotency_key: string | null;
  created_at: string;
};

export type AppendConversationEventInput<K extends ConversationEventKind = ConversationEventKind> = {
  eventId?: string;
  conversationId: string;
  kind: K;
  payload: ConversationEventPayload<K>;
  producedBy: ConversationEventProducer;
  idempotencyKey?: string;
  createdAt?: string;
};

function nowIso() {
  return new Date().toISOString();
}

function createEventId() {
  return `conversation-event-${randomUUID()}`;
}

function mapRow<K extends ConversationEventKind = ConversationEventKind>(
  row: ConversationEventLogRow,
): ConversationEventRecord<K> {
  return {
    id: row.id,
    eventId: row.event_id,
    conversationId: row.conversation_id,
    kind: row.kind as K,
    payload: JSON.parse(row.payload_json) as ConversationEventPayload<K>,
    producedBy: row.produced_by,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at,
  };
}

export function getConversationEventByIdempotencyKey<K extends ConversationEventKind = ConversationEventKind>(
  idempotencyKey: string,
) {
  const row = getDatabase()
    .prepare(`SELECT * FROM conversation_event_log WHERE idempotency_key = ? LIMIT 1`)
    .get(idempotencyKey) as ConversationEventLogRow | undefined;
  return row ? mapRow<K>(row) : null;
}

export function appendConversationEvent<K extends ConversationEventKind>(input: AppendConversationEventInput<K>) {
  const eventId = input.eventId ?? createEventId();
  const createdAt = input.createdAt ?? nowIso();
  getDatabase()
    .prepare(
      `
        INSERT INTO conversation_event_log (
          event_id, conversation_id, kind, payload_json, produced_by, idempotency_key, created_at
        ) VALUES (
          @event_id, @conversation_id, @kind, @payload_json, @produced_by, @idempotency_key, @created_at
        )
        ON CONFLICT(event_id) DO NOTHING
      `,
    )
    .run({
      event_id: eventId,
      conversation_id: input.conversationId,
      kind: input.kind,
      payload_json: JSON.stringify(input.payload),
      produced_by: input.producedBy,
      idempotency_key: input.idempotencyKey ?? null,
      created_at: createdAt,
    });
  const row = getDatabase()
    .prepare(`SELECT * FROM conversation_event_log WHERE event_id = ? LIMIT 1`)
    .get(eventId) as ConversationEventLogRow | undefined;
  return row ? mapRow<K>(row) : null;
}

export function appendConversationEventOnce<K extends ConversationEventKind>(
  input: AppendConversationEventInput<K>,
) {
  if (!input.idempotencyKey) return appendConversationEvent(input);
  const existing = getConversationEventByIdempotencyKey<K>(input.idempotencyKey);
  if (existing) return existing;
  const eventId = input.eventId ?? createEventId();
  const createdAt = input.createdAt ?? nowIso();
  getDatabase()
    .prepare(
      `
        INSERT OR IGNORE INTO conversation_event_log (
          event_id, conversation_id, kind, payload_json, produced_by, idempotency_key, created_at
        ) VALUES (
          @event_id, @conversation_id, @kind, @payload_json, @produced_by, @idempotency_key, @created_at
        )
      `,
    )
    .run({
      event_id: eventId,
      conversation_id: input.conversationId,
      kind: input.kind,
      payload_json: JSON.stringify(input.payload),
      produced_by: input.producedBy,
      idempotency_key: input.idempotencyKey,
      created_at: createdAt,
    });
  const row = getDatabase()
    .prepare(`SELECT * FROM conversation_event_log WHERE idempotency_key = ? LIMIT 1`)
    .get(input.idempotencyKey) as ConversationEventLogRow | undefined;
  return row ? mapRow<K>(row) : null;
}

export function getConversationEvents(input: { conversationId?: string; fromId?: number; limit?: number }) {
  const limit = input.limit ?? 200;
  if (input.conversationId) {
    const rows = getDatabase()
      .prepare(
        `
          SELECT * FROM conversation_event_log
          WHERE id > ? AND conversation_id = ?
          ORDER BY id ASC
          LIMIT ?
        `,
      )
      .all(input.fromId ?? 0, input.conversationId, limit) as ConversationEventLogRow[];
    return rows.map((row) => mapRow(row));
  }
  const rows = getDatabase()
    .prepare(
      `
        SELECT * FROM conversation_event_log
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?
      `,
    )
    .all(input.fromId ?? 0, limit) as ConversationEventLogRow[];
  return rows.map((row) => mapRow(row));
}

export function getLatestConversationEventId() {
  const row = getDatabase()
    .prepare(`SELECT MAX(id) AS id FROM conversation_event_log`)
    .get() as { id: number | null };
  return row.id ?? 0;
}
