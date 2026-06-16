import { getDatabase } from "@/lib/server/db/client";
import {
  getConversationMessage,
  mapConversationMessageRow,
} from "@/lib/server/repositories/conversationMessagesRepository";
import { getConversation } from "@/lib/server/repositories/conversationsRepository";
import {
  deleteMessageFeedback,
  listMessageFeedbacksByConversation,
  upsertMessageFeedback,
} from "@/lib/server/repositories/messageFeedbackRepository";
import type { ConversationMessage } from "@/types/kiki";
import {
  MESSAGE_FEEDBACK_REASON_CODES,
  type MessageFeedbackContextSnapshot,
  type MessageFeedbackRating,
  type MessageFeedbackReasonCode,
  type MessageFeedbackSnapshotMessage,
  type MessageFeedbackTargetFallback,
} from "@/types/messageFeedback";

const MAX_CONTEXT_MESSAGES = 8;
const MAX_MESSAGE_CONTENT_LENGTH = 4096;

export class MessageFeedbackError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "MessageFeedbackError";
  }
}

type ConversationMessageRow = Parameters<typeof mapConversationMessageRow>[0];

export type SubmitMessageFeedbackInput = {
  conversationId: string;
  messageId: string;
  rating: MessageFeedbackRating;
  reasonCodes?: MessageFeedbackReasonCode[];
  comment?: string;
  runtimeEnvId?: string;
  targetMessageFallback?: MessageFeedbackTargetFallback;
};

function truncateContent(content: string) {
  if (content.length <= MAX_MESSAGE_CONTENT_LENGTH) {
    return { content };
  }
  return {
    content: content.slice(0, MAX_MESSAGE_CONTENT_LENGTH),
    truncated: true,
  };
}

function buildSnapshotMessage(message: ConversationMessage): MessageFeedbackSnapshotMessage {
  const content = truncateContent(message.content);
  const refs: MessageFeedbackSnapshotMessage["refs"] = {};
  if (message.kind === "text") {
    if (message.sagaRequestId) refs.sagaRequestId = message.sagaRequestId;
    if (message.cliProcess?.runId) refs.cliProcessRunId = message.cliProcess.runId;
  }
  if (message.kind === "goal_plan_card") {
    refs.goalRef = message.goalRef;
    if (message.sagaRequestId) refs.sagaRequestId = message.sagaRequestId;
    if (message.cliProcess?.runId) refs.cliProcessRunId = message.cliProcess.runId;
  }
  if (message.kind === "task_card" || message.kind === "task_interaction_request") {
    refs.taskRef = message.taskRef;
  }
  if (message.kind === "governance_confirmation") {
    refs.governanceIntent = message.governance.payload.intent;
  }
  return {
    id: message.id,
    kind: message.kind,
    role: message.role,
    content: content.content,
    createdAt: message.createdAt,
    status: message.status,
    source: message.source,
    truncated: content.truncated,
    refs: Object.keys(refs).length ? refs : undefined,
  };
}

function fallbackToMessage(fallback: MessageFeedbackTargetFallback): ConversationMessage {
  return {
    id: fallback.id,
    kind: fallback.kind,
    role: "kiki",
    content: fallback.content,
    createdAt: fallback.createdAt,
    status: fallback.status,
    source: fallback.source,
  } as ConversationMessage;
}

function listPreviousMessages(conversationId: string, beforeSeq?: number) {
  const db = getDatabase();
  const rows = beforeSeq
    ? (db
        .prepare(
          `
            SELECT *
            FROM conversation_messages
            WHERE conversation_id = ? AND seq < ?
            ORDER BY seq DESC
            LIMIT ?
          `,
        )
        .all(conversationId, beforeSeq, MAX_CONTEXT_MESSAGES) as ConversationMessageRow[])
    : (db
        .prepare(
          `
            SELECT *
            FROM conversation_messages
            WHERE conversation_id = ?
            ORDER BY seq DESC
            LIMIT ?
          `,
        )
        .all(conversationId, MAX_CONTEXT_MESSAGES) as ConversationMessageRow[]);

  return rows.reverse().map((row) => buildSnapshotMessage(mapConversationMessageRow(row)));
}

function normalizeReasonCodes(reasonCodes: MessageFeedbackReasonCode[] | undefined) {
  const validReasonCodes = new Set<MessageFeedbackReasonCode>(MESSAGE_FEEDBACK_REASON_CODES);
  return Array.from(new Set(reasonCodes ?? [])).filter((code) => validReasonCodes.has(code));
}

function validateInput(input: SubmitMessageFeedbackInput) {
  if (!input.conversationId.trim() || !input.messageId.trim()) {
    throw new MessageFeedbackError(400, "反馈参数不完整");
  }
  if (input.rating !== "good" && input.rating !== "bad") {
    throw new MessageFeedbackError(400, "反馈类型无效");
  }
  const reasonCodes = normalizeReasonCodes(input.reasonCodes);
  if (input.rating === "bad" && reasonCodes.length === 0 && !input.comment?.trim()) {
    throw new MessageFeedbackError(400, "差评需要选择原因或填写说明");
  }
  return reasonCodes;
}

export function submitMessageFeedback(input: SubmitMessageFeedbackInput) {
  const reasonCodes = validateInput(input);
  if (!getConversation(input.conversationId)) {
    throw new MessageFeedbackError(404, "会话不存在");
  }
  const found = getConversationMessage(input.conversationId, input.messageId);
  const fallback =
    !found && input.targetMessageFallback?.id === input.messageId ? fallbackToMessage(input.targetMessageFallback) : null;
  const targetMessage = found?.message ?? fallback;
  if (!targetMessage) {
    throw new MessageFeedbackError(404, "未找到被反馈的消息");
  }
  if (targetMessage.role !== "kiki") {
    throw new MessageFeedbackError(400, "只能反馈 KiKi 的回复");
  }
  if (targetMessage.status === "streaming" || targetMessage.status === "error" || !targetMessage.content.trim()) {
    throw new MessageFeedbackError(400, "当前消息暂不能反馈");
  }

  const now = new Date().toISOString();
  const contextSnapshot: MessageFeedbackContextSnapshot = {
    conversationId: input.conversationId,
    runtimeEnvId: input.runtimeEnvId,
    createdAt: now,
    source: found ? "database" : "client_fallback",
    targetMessage: buildSnapshotMessage(targetMessage),
    previousMessages: listPreviousMessages(input.conversationId, found?.seq),
  };

  return upsertMessageFeedback({
    conversationId: input.conversationId,
    messageId: input.messageId,
    rating: input.rating,
    reasonCodes,
    comment: input.comment,
    contextSnapshot,
    runtimeEnvId: input.runtimeEnvId,
  });
}

export function listConversationMessageFeedback(conversationId: string) {
  if (!conversationId.trim()) {
    throw new MessageFeedbackError(400, "缺少 conversationId");
  }
  if (!getConversation(conversationId)) {
    throw new MessageFeedbackError(404, "会话不存在");
  }
  return listMessageFeedbacksByConversation(conversationId);
}

export function clearMessageFeedback(input: { conversationId: string; messageId: string }) {
  if (!input.conversationId.trim() || !input.messageId.trim()) {
    throw new MessageFeedbackError(400, "反馈参数不完整");
  }
  if (!getConversation(input.conversationId)) {
    throw new MessageFeedbackError(404, "会话不存在");
  }
  deleteMessageFeedback(input.conversationId, input.messageId);
}
