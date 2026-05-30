import { getDatabase } from "@/lib/server/db/client";
import type { ConversationMessage } from "@/types/kiki";

type ConversationMessageRow = {
  id: string;
  conversation_id: string;
  seq: number;
  kind: ConversationMessage["kind"];
  role: ConversationMessage["role"];
  source: ConversationMessage["source"] | null;
  status: ConversationMessage["status"] | null;
  content: string;
  unread: number;
  ref_json: string | null;
  snapshot_json: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as T;
}

function messageRefs(message: ConversationMessage) {
  if (message.kind === "goal_plan_card") {
    return {
      refJson: JSON.stringify({ goalRef: message.goalRef }),
      snapshotJson: null,
    };
  }
  if (message.kind === "task_card") {
    return {
      refJson: JSON.stringify({ taskRef: message.taskRef }),
      snapshotJson: message.taskSnapshot ? JSON.stringify({ taskSnapshot: message.taskSnapshot }) : null,
    };
  }
  return { refJson: null, snapshotJson: null };
}

export function mapConversationMessageRow(row: ConversationMessageRow): ConversationMessage {
  const base = {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    unread: Boolean(row.unread),
    status: row.status ?? undefined,
    source: row.source ?? undefined,
  };
  if (row.kind === "goal_plan_card") {
    const refs = parseJson<{ goalRef: ConversationMessage & { goalRef: never } }>(row.ref_json) as
      | { goalRef: Extract<ConversationMessage, { kind: "goal_plan_card" }>["goalRef"] }
      | undefined;
    return {
      ...base,
      kind: "goal_plan_card",
      role: "kiki",
      goalRef: refs?.goalRef ?? { goalId: "", title: "", subGoalCount: 0, taskCount: 0 },
    };
  }
  if (row.kind === "task_card") {
    const refs = parseJson<{ taskRef: Extract<ConversationMessage, { kind: "task_card" }>["taskRef"] }>(row.ref_json);
    const snapshot = parseJson<{ taskSnapshot: Extract<ConversationMessage, { kind: "task_card" }>["taskSnapshot"] }>(
      row.snapshot_json,
    );
    return {
      ...base,
      kind: "task_card",
      role: "kiki",
      taskRef: refs?.taskRef ?? { goalId: "", subGoalId: "", taskId: "", instanceId: "" },
      taskSnapshot: snapshot?.taskSnapshot,
    };
  }
  return {
    ...base,
    kind: "text",
    role: row.role,
  };
}

function nextMessageSeq(conversationId: string) {
  const row = getDatabase()
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM conversation_messages WHERE conversation_id = ?`)
    .get(conversationId) as { seq: number };
  return row.seq;
}

export function listConversationMessages(input: { conversationId: string; afterSeq?: number; limit?: number }) {
  const rows = getDatabase()
    .prepare(
      `
        SELECT * FROM conversation_messages
        WHERE conversation_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
      `,
    )
    .all(input.conversationId, input.afterSeq ?? 0, input.limit ?? 200) as ConversationMessageRow[];
  return rows.map(mapConversationMessageRow);
}

export function getConversationMessage(conversationId: string, messageId: string) {
  const row = getDatabase()
    .prepare(`SELECT * FROM conversation_messages WHERE conversation_id = ? AND id = ? LIMIT 1`)
    .get(conversationId, messageId) as ConversationMessageRow | undefined;
  return row ? { message: mapConversationMessageRow(row), version: row.version, seq: row.seq } : null;
}

export function insertConversationMessage(conversationId: string, message: ConversationMessage) {
  const db = getDatabase();
  const existing = getConversationMessage(conversationId, message.id);
  if (existing) return { ...existing, inserted: false };
  const now = new Date().toISOString();
  const { refJson, snapshotJson } = messageRefs(message);
  const seq = nextMessageSeq(conversationId);
  db.prepare(
    `
      INSERT INTO conversation_messages (
        id, conversation_id, seq, kind, role, source, status, content, unread,
        ref_json, snapshot_json, version, created_at, updated_at
      ) VALUES (
        @id, @conversation_id, @seq, @kind, @role, @source, @status, @content, @unread,
        @ref_json, @snapshot_json, @version, @created_at, @updated_at
      )
    `,
  ).run({
    id: message.id,
    conversation_id: conversationId,
    seq,
    kind: message.kind,
    role: message.role,
    source: message.source ?? null,
    status: message.status ?? null,
    content: message.content,
    unread: message.unread ? 1 : 0,
    ref_json: refJson,
    snapshot_json: snapshotJson,
    version: 1,
    created_at: message.createdAt,
    updated_at: now,
  });
  return { message, version: 1, seq, inserted: true };
}

export function updateConversationMessage(input: {
  conversationId: string;
  messageId: string;
  patch: Partial<ConversationMessage>;
  expectedVersion?: number;
}) {
  const current = getConversationMessage(input.conversationId, input.messageId);
  if (!current) return null;
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    return { ...current, conflict: true as const };
  }
  const next = { ...current.message, ...input.patch, id: current.message.id } as ConversationMessage;
  const { refJson, snapshotJson } = messageRefs(next);
  const version = current.version + 1;
  getDatabase()
    .prepare(
      `
        UPDATE conversation_messages
        SET kind = @kind,
            role = @role,
            source = @source,
            status = @status,
            content = @content,
            unread = @unread,
            ref_json = @ref_json,
            snapshot_json = @snapshot_json,
            version = @version,
            updated_at = @updated_at
        WHERE conversation_id = @conversation_id AND id = @id
      `,
    )
    .run({
      id: input.messageId,
      conversation_id: input.conversationId,
      kind: next.kind,
      role: next.role,
      source: next.source ?? null,
      status: next.status ?? null,
      content: next.content,
      unread: next.unread ? 1 : 0,
      ref_json: refJson,
      snapshot_json: snapshotJson,
      version,
      updated_at: new Date().toISOString(),
    });
  return { message: next, version, seq: current.seq, conflict: false as const };
}

export function deleteConversationMessage(conversationId: string, messageId: string) {
  const result = getDatabase()
    .prepare(`DELETE FROM conversation_messages WHERE conversation_id = ? AND id = ?`)
    .run(conversationId, messageId);
  return result.changes > 0;
}

export function markConversationMessagesRead(conversationId: string) {
  const rows = getDatabase()
    .prepare(`SELECT id FROM conversation_messages WHERE conversation_id = ? AND unread = 1`)
    .all(conversationId) as Array<{ id: string }>;
  getDatabase()
    .prepare(
      `
        UPDATE conversation_messages
        SET unread = 0, version = version + 1, updated_at = ?
        WHERE conversation_id = ? AND unread = 1
      `,
    )
    .run(new Date().toISOString(), conversationId);
  return rows.map((row) => row.id);
}

export function markConversationMessageRead(conversationId: string, messageId: string) {
  const current = getConversationMessage(conversationId, messageId);
  if (!current) return null;
  getDatabase()
    .prepare(
      `
        UPDATE conversation_messages
        SET unread = 0, version = version + 1, updated_at = ?
        WHERE conversation_id = ? AND id = ?
      `,
    )
    .run(new Date().toISOString(), conversationId, messageId);
  return { message: { ...current.message, unread: false }, version: current.version + 1 };
}

export function markLastMessageUnread(conversationId: string) {
  const row = getDatabase()
    .prepare(
      `
        SELECT id FROM conversation_messages
        WHERE conversation_id = ?
        ORDER BY seq DESC
        LIMIT 1
      `,
    )
    .get(conversationId) as { id: string } | undefined;
  if (!row) return null;
  getDatabase()
    .prepare(
      `
        UPDATE conversation_messages
        SET unread = 1, version = version + 1, updated_at = ?
        WHERE conversation_id = ? AND id = ?
      `,
    )
    .run(new Date().toISOString(), conversationId, row.id);
  return row.id;
}
