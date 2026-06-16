import { getDatabase } from "@/lib/server/db/client";
import type {
  MessageFeedbackContextSnapshot,
  MessageFeedbackRating,
  MessageFeedbackReasonCode,
  MessageFeedbackRecord,
} from "@/types/messageFeedback";

type MessageFeedbackRow = {
  id: string;
  conversation_id: string;
  message_id: string;
  rating: MessageFeedbackRating;
  reason_codes_json: string;
  comment: string | null;
  context_snapshot_json: string;
  runtime_env_id: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertMessageFeedbackInput = {
  id?: string;
  conversationId: string;
  messageId: string;
  rating: MessageFeedbackRating;
  reasonCodes: MessageFeedbackReasonCode[];
  comment?: string;
  contextSnapshot: MessageFeedbackContextSnapshot;
  runtimeEnvId?: string;
};

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function createFeedbackId() {
  return `message-feedback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function mapRow(row: MessageFeedbackRow): MessageFeedbackRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    rating: row.rating,
    reasonCodes: parseJson<MessageFeedbackReasonCode[]>(row.reason_codes_json),
    comment: row.comment ?? undefined,
    contextSnapshot: parseJson<MessageFeedbackContextSnapshot>(row.context_snapshot_json),
    runtimeEnvId: row.runtime_env_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getMessageFeedback(conversationId: string, messageId: string) {
  const row = getDatabase()
    .prepare(
      `
        SELECT *
        FROM message_feedbacks
        WHERE conversation_id = ? AND message_id = ?
        LIMIT 1
      `,
    )
    .get(conversationId, messageId) as MessageFeedbackRow | undefined;
  return row ? mapRow(row) : null;
}

export function listMessageFeedbacksByConversation(conversationId: string) {
  const rows = getDatabase()
    .prepare(
      `
        SELECT *
        FROM message_feedbacks
        WHERE conversation_id = ?
        ORDER BY updated_at DESC
      `,
    )
    .all(conversationId) as MessageFeedbackRow[];
  return rows.map(mapRow);
}

export function deleteMessageFeedback(conversationId: string, messageId: string) {
  getDatabase()
    .prepare(
      `
        DELETE FROM message_feedbacks
        WHERE conversation_id = ? AND message_id = ?
      `,
    )
    .run(conversationId, messageId);
}

export function upsertMessageFeedback(input: UpsertMessageFeedbackInput) {
  const now = new Date().toISOString();
  const existing = getMessageFeedback(input.conversationId, input.messageId);
  const id = existing?.id ?? input.id ?? createFeedbackId();
  const createdAt = existing?.createdAt ?? now;

  getDatabase()
    .prepare(
      `
        INSERT INTO message_feedbacks (
          id, conversation_id, message_id, rating, reason_codes_json, comment,
          context_snapshot_json, runtime_env_id, created_at, updated_at
        ) VALUES (
          @id, @conversation_id, @message_id, @rating, @reason_codes_json, @comment,
          @context_snapshot_json, @runtime_env_id, @created_at, @updated_at
        )
        ON CONFLICT(conversation_id, message_id) DO UPDATE SET
          rating = @rating,
          reason_codes_json = @reason_codes_json,
          comment = @comment,
          context_snapshot_json = @context_snapshot_json,
          runtime_env_id = @runtime_env_id,
          updated_at = @updated_at
      `,
    )
    .run({
      id,
      conversation_id: input.conversationId,
      message_id: input.messageId,
      rating: input.rating,
      reason_codes_json: JSON.stringify(input.reasonCodes),
      comment: input.comment?.trim() || null,
      context_snapshot_json: JSON.stringify(input.contextSnapshot),
      runtime_env_id: input.runtimeEnvId ?? null,
      created_at: createdAt,
      updated_at: now,
    });

  const saved = getMessageFeedback(input.conversationId, input.messageId);
  if (!saved) {
    throw new Error("消息反馈保存失败");
  }
  return saved;
}
