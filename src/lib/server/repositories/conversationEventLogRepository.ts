import { getDatabase } from "@/lib/server/db/client";
import { createEventLogRepository } from "@/lib/server/repositories/eventLogRepositoryFactory";
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

const repository = createEventLogRepository<
  ConversationEventLogRow,
  ConversationEventRecord,
  AppendConversationEventInput
>({
  table: "conversation_event_log",
  eventIdPrefix: "conversation-event",
  ownerColumns: ["conversation_id"],
  toOwnerParams: (input) => ({ conversation_id: input.conversationId }),
  mapRow,
});

export function getConversationEventByIdempotencyKey<K extends ConversationEventKind = ConversationEventKind>(
  idempotencyKey: string,
) {
  return repository.getByIdempotencyKey(idempotencyKey) as ConversationEventRecord<K> | null;
}

export function appendConversationEvent<K extends ConversationEventKind>(input: AppendConversationEventInput<K>) {
  return repository.append(input) as ConversationEventRecord<K> | null;
}

export function appendConversationEventOnce<K extends ConversationEventKind>(
  input: AppendConversationEventInput<K>,
) {
  return repository.appendOnce(input) as ConversationEventRecord<K> | null;
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
