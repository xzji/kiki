import { normalizeGoalId } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import type { ConversationMessage } from "@/types/kiki";
import type { ThreadTickPostMessageSeverity } from "@/types/topic";

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
  if (message.kind === "text") {
    const refs: {
      quotedMessage?: Extract<ConversationMessage, { kind: "text" }>["quotedMessage"];
      artifactRefs?: Extract<ConversationMessage, { kind: "text" }>["artifactRefs"];
      cliProcess?: Extract<ConversationMessage, { kind: "text" }>["cliProcess"];
    } = {};
    if (message.quotedMessage) refs.quotedMessage = message.quotedMessage;
    if (message.artifactRefs?.length) refs.artifactRefs = message.artifactRefs;
    if (message.cliProcess) refs.cliProcess = message.cliProcess;
    return {
      refJson: Object.keys(refs).length > 0 ? JSON.stringify(refs) : null,
      snapshotJson: null,
    };
  }
  if (message.kind === "goal_plan_card") {
    const refs: {
      goalRef: Extract<ConversationMessage, { kind: "goal_plan_card" }>["goalRef"];
      cliProcess?: Extract<ConversationMessage, { kind: "goal_plan_card" }>["cliProcess"];
    } = {
      goalRef: message.goalRef,
    };
    if (message.cliProcess) refs.cliProcess = message.cliProcess;
    return {
      refJson: JSON.stringify(refs),
      snapshotJson: null,
    };
  }
  if (message.kind === "task_card") {
    return {
      refJson: JSON.stringify({ taskRef: message.taskRef }),
      snapshotJson: message.taskSnapshot ? JSON.stringify({ taskSnapshot: message.taskSnapshot }) : null,
    };
  }
  if (message.kind === "governance_confirmation") {
    return {
      refJson: JSON.stringify({ governance: message.governance }),
      snapshotJson: null,
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
    const refs = parseJson<{
      goalRef: Extract<ConversationMessage, { kind: "goal_plan_card" }>["goalRef"];
      cliProcess?: Extract<ConversationMessage, { kind: "goal_plan_card" }>["cliProcess"];
    }>(row.ref_json) as
      | {
          goalRef: Extract<ConversationMessage, { kind: "goal_plan_card" }>["goalRef"];
          cliProcess?: Extract<ConversationMessage, { kind: "goal_plan_card" }>["cliProcess"];
        }
      | undefined;
    return {
      ...base,
      kind: "goal_plan_card",
      role: "kiki",
      goalRef: refs?.goalRef ?? { goalId: "", title: "", subGoalCount: 0, taskCount: 0 },
      cliProcess: refs?.cliProcess,
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
  if (row.kind === "governance_confirmation") {
    const refs = parseJson<{
      governance: Extract<ConversationMessage, { kind: "governance_confirmation" }>["governance"];
    }>(row.ref_json);
    return {
      ...base,
      kind: "governance_confirmation",
      role: "kiki",
      governance: refs?.governance ?? {
        status: "error",
        summary: row.content,
        payload: { intent: "" },
        userMessage: "",
        error: "确认卡数据缺失，请重新发起任务治理操作。",
      },
    };
  }
  const refs = parseJson<{
    quotedMessage: Extract<ConversationMessage, { kind: "text" }>["quotedMessage"];
    artifactRefs: Extract<ConversationMessage, { kind: "text" }>["artifactRefs"];
    cliProcess: Extract<ConversationMessage, { kind: "text" }>["cliProcess"];
  }>(row.ref_json);
  return {
    ...base,
    kind: "text",
    role: row.role,
    quotedMessage: refs?.quotedMessage,
    artifactRefs: refs?.artifactRefs,
    cliProcess: refs?.cliProcess,
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

// ---------------------------------------------------------------------------
// PR14.4: Thread 派生消息追加（计划 §12.3.1.4）
// ---------------------------------------------------------------------------

/**
 * Thread tick post_message 写入对话流的薄包装。
 *
 * 现有 conversation_messages 表无 thread_id / severity 列；本方法不扩 schema，
 * 走以下约定：
 *  - 通过 `conversations.goal_id === topicId` 反查 conversation（topic↔goal
 *    双写期 goal_id 即 topicId）；找不到 conversation 抛错（thread post_message
 *    必须挂在某个 conversation 下）。
 *  - 消息 id 形如 `msg-thread-${threadId}-${traceId}`，在 conversationId×messageId
 *    维度幂等（重入直接复用既有消息）。
 *  - severity 经由 inboxRepository.appendInboxMessage 的事件 payload 透传，
 *    本表只保留文本（warning/important 在 UI 端通过 inbox unread 状态高亮）。
 *  - kind 固定 "text"，role 固定 "kiki"，source "system"，unread=true 以便
 *    inbox/会话两端同时点亮未读数。
 */
export type AppendThreadMessageInput = {
  topicId: string;
  threadId: string;
  text: string;
  severity: ThreadTickPostMessageSeverity;
  /** 同 traceId 重入会幂等。默认 nowIso()。 */
  traceId?: string;
  /** 注入时钟，spec 用；默认 new Date()。 */
  now?: () => Date;
};

export type AppendThreadMessageResult = {
  conversationMessageId: string;
  conversationId: string;
};

export function appendThreadMessage(input: AppendThreadMessageInput): AppendThreadMessageResult {
  if (!input.topicId) throw new Error("appendThreadMessage: topicId required");
  if (!input.threadId) throw new Error("appendThreadMessage: threadId required");
  const text = input.text?.trim();
  if (!text) throw new Error("appendThreadMessage: text required");

  const nowFn = input.now ?? (() => new Date());
  const traceId = input.traceId ?? nowFn().toISOString();
  const conversationMessageId = `msg-thread-${input.threadId}-${traceId}`;
  const db = getDatabase();

  // conversations.goal_id 由 migrateConversationIds normalize 成 goal-opq-* 形式；
  // 此处必须用 normalize 后的 ID 查询，否则原始 topicId 永远查不到。
  const normalizedTopicId = normalizeGoalId(input.topicId);
  const convRow = db
    .prepare(`SELECT id FROM conversations WHERE goal_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(normalizedTopicId) as { id: string } | undefined;
  if (!convRow) {
    throw new Error(`appendThreadMessage: no conversation linked to topic ${input.topicId}`);
  }
  const conversationId = convRow.id;

  // 幂等：同 messageId 直接返回
  const existing = db
    .prepare(`SELECT id FROM conversation_messages WHERE conversation_id = ? AND id = ? LIMIT 1`)
    .get(conversationId, conversationMessageId) as { id: string } | undefined;
  if (existing) {
    return { conversationMessageId: existing.id, conversationId };
  }

  const createdAt = nowFn().toISOString();
  insertConversationMessage(conversationId, {
    id: conversationMessageId,
    kind: "text",
    role: "kiki",
    content: text,
    createdAt,
    unread: true,
    status: "done",
    source: "system",
  });

  return { conversationMessageId, conversationId };
}
