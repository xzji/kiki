import fs from "fs";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import { deleteClaudeSessionFileSync } from "@/lib/server/claudeSession";
import { getDatabase } from "@/lib/server/db/client";
import { appendMemoryAuditEvent } from "@/lib/server/memory/memoryAudit";
import { cleanupUserMemoryCandidatesForConversationSync } from "@/lib/server/memory/userMemoryCandidates";
import {
  appendConversationEvent,
  getConversationEventByIdempotencyKey,
  getLatestConversationEventId,
} from "@/lib/server/repositories/conversationEventLogRepository";
import {
  countConversations,
  deleteConversation,
  getConversation,
  getConversationRevision,
  insertConversation,
  listConversationMetas,
  listConversationSummaries,
  updateConversationFields,
} from "@/lib/server/repositories/conversationsRepository";
import {
  deleteConversationMessage,
  getConversationMessage,
  insertConversationMessage,
  listConversationMessages,
  markConversationMessageRead,
  markConversationMessagesRead,
  markLastMessageUnread,
  updateConversationMessage,
} from "@/lib/server/repositories/conversationMessagesRepository";
import {
  deleteConversationWorkspace,
  getConversationSessionMemoryFilePath,
  getConversationWorkspaceDir,
} from "@/lib/server/workspace/conversationWorkspace";
import type { ConversationEventRecord } from "@/types/conversationEventLog";
import type { Conversation, ConversationMessage, GoalInfoCollection, GoalPlanningRunState } from "@/types/kiki";

export type ConversationCommand =
  | { type: "create_conversation"; conversation: Pick<Conversation, "id" | "title"> & Partial<Conversation> }
  | { type: "rename_conversation"; conversationId: string; title: string }
  | { type: "delete_conversation"; conversationId: string }
  | { type: "toggle_pinned"; conversationId: string }
  | { type: "set_goal"; conversationId: string; goalId: string }
  | { type: "set_workspace"; conversationId: string; workspacePath: string; workspaceInitializedAt?: string }
  | { type: "set_runtime_env"; conversationId: string; runtimeEnvId: string }
  | { type: "set_runtime_session"; conversationId: string; runtimeKind: string; sessionId: string | null }
  | { type: "set_status"; conversationId: string; status: Conversation["status"] }
  | { type: "set_goal_info_collection"; conversationId: string; collection: GoalInfoCollection | null }
  | { type: "set_planning_run_state"; conversationId: string; state: GoalPlanningRunState | null }
  | { type: "append_message"; conversationId: string; message: ConversationMessage }
  | {
      type: "update_message";
      conversationId: string;
      messageId: string;
      patch: Partial<ConversationMessage>;
      expectedVersion?: number;
    }
  | { type: "delete_message"; conversationId: string; messageId: string }
  | { type: "mark_conversation_read"; conversationId: string }
  | { type: "mark_conversation_unread"; conversationId: string }
  | { type: "mark_message_read"; conversationId: string; messageId: string };

export type ConversationCommandResult = {
  event: ConversationEventRecord;
  conversation?: Conversation;
  conversations?: ReturnType<typeof listConversationMetas>;
  messages?: ConversationMessage[];
  revision?: number;
};

export class ConversationCommandValidationError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "ConversationCommandValidationError";
  }
}

export class ConversationCommandConflictError extends Error {
  constructor(
    message: string,
    public currentRevision?: number,
    public expectedRevision?: number,
  ) {
    super(message);
    this.name = "ConversationCommandConflictError";
  }
}

export class ConversationCommandIdempotencyConflictError extends Error {
  constructor(message = "Idempotency-Key 已被使用，请生成新的命令键") {
    super(message);
    this.name = "ConversationCommandIdempotencyConflictError";
  }
}

export type DeleteConversationDeepResult = {
  deletedConversation: boolean;
  deletedWorkspace: boolean;
  deletedClaudeSession: boolean;
  deletedClaudeSessionCount: number;
  removedMemoryCandidates: number;
  prunedMemoryCandidateSources: number;
  auditEvents: number;
};

function requireNonEmptyString(value: string | undefined, field: string) {
  if (!value?.trim()) throw new ConversationCommandValidationError(`${field} 不能为空`);
  return value.trim();
}

/**
 * 基于现有 runtimeSessions，对指定 runtimeKind 写入或清除 sessionId，返回新的映射。
 * sessionId 为 null 时删除该 runtimeKind 的条目；返回 null 表示清空整个映射。
 */
function buildRuntimeSessionsPatch(
  current: Record<string, string> | undefined,
  runtimeKind: string,
  sessionId: string | null,
): Record<string, string> | null {
  const next = { ...(current ?? {}) };
  if (sessionId === null) {
    delete next[runtimeKind];
  } else {
    next[runtimeKind] = sessionId;
  }
  return Object.keys(next).length > 0 ? next : null;
}

function assertExpectedRevision(conversationId: string, expectedRevision?: number) {
  if (expectedRevision === undefined) return;
  const currentRevision = getConversationRevision(conversationId);
  if (currentRevision === undefined) {
    throw new ConversationCommandValidationError("会话不存在", 404);
  }
  if (currentRevision !== expectedRevision) {
    throw new ConversationCommandConflictError("会话已更新，请刷新后重试", currentRevision, expectedRevision);
  }
}

function requireConversation(conversationId: string) {
  const current = getConversation(conversationId);
  if (!current) throw new ConversationCommandValidationError("会话不存在", 404);
  return current;
}

function assertUnusedIdempotencyKey(idempotencyKey: string) {
  if (getConversationEventByIdempotencyKey(idempotencyKey)) {
    throw new ConversationCommandIdempotencyConflictError();
  }
}

function appendEvent(input: Parameters<typeof appendConversationEvent>[0]) {
  const event = appendConversationEvent(input);
  if (!event) throw new ConversationCommandValidationError("会话事件写入失败", 500);
  return event;
}

export function deleteConversationDeep(conversationId: string): DeleteConversationDeepResult {
  const current = getConversation(conversationId)?.conversation ?? null;
  const workspaceDir = getConversationWorkspaceDir(conversationId);
  const sessionMemoryFilePath = getConversationSessionMemoryFilePath(conversationId);
  const hadWorkspace = fs.existsSync(workspaceDir);
  const hadSessionMemory = fs.existsSync(sessionMemoryFilePath);
  let auditEvents = 0;

  const memoryCandidates = cleanupUserMemoryCandidatesForConversationSync(conversationId);
  if (memoryCandidates.prunedSources > 0 || memoryCandidates.removed > 0) {
    appendMemoryAuditEvent({
      target: "candidate",
      conversationId,
      source: "后台晋升",
      action: "clear",
    });
    auditEvents += 1;
  }

  let claudeSessionResult = { deleted: false, deletedCount: 0 };
  // 仅 claude runtime 的 session 以本地文件形式落盘（~/.claude/projects），需级联清理；
  // 其它 CLI（如 pi）的 session 由各自 CLI 管理，这里不做文件删除。
  const claudeSessionId = current?.runtimeSessions?.claude;
  if (claudeSessionId) {
    claudeSessionResult = deleteClaudeSessionFileSync({
      sessionId: claudeSessionId,
      workingDirectory: workspaceDir,
    });
  }

  deleteConversationWorkspace(conversationId);
  if (hadSessionMemory || hadWorkspace) {
    appendMemoryAuditEvent({
      target: "session",
      conversationId,
      source: "后台晋升",
      action: "clear",
    });
    auditEvents += 1;
  }

  const deletedConversation = deleteConversation(conversationId);
  return {
    deletedConversation,
    deletedWorkspace: hadWorkspace,
    deletedClaudeSession: claudeSessionResult.deleted,
    deletedClaudeSessionCount: claudeSessionResult.deletedCount,
    removedMemoryCandidates: memoryCandidates.removed,
    prunedMemoryCandidateSources: memoryCandidates.prunedSources,
    auditEvents,
  };
}


function commandConversationId(command: ConversationCommand) {
  return command.type === "create_conversation" ? command.conversation.id : command.conversationId;
}

export function readConversationState(input?: { includeMessages?: boolean }) {
  if (!input?.includeMessages) {
    const conversations = listConversationSummaries();
    return {
      conversations,
      latestEventId: getLatestConversationEventId() ?? 0,
      meta: {
        mode: "summary" as const,
        conversationCount: conversations.length,
        totalMessageCount: conversations.reduce((sum, conversation) => sum + conversation.messageCount, 0),
        totalUnreadCount: conversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0),
      },
    };
  }
  const conversations = listConversationMetas().map((meta) => {
    const detail = getConversation(meta.id);
    return {
      ...meta,
      messages: detail?.conversation.messages ?? [],
    };
  });
  return {
    conversations,
    latestEventId: getLatestConversationEventId() ?? 0,
    meta: {
      mode: "full" as const,
      conversationCount: conversations.length,
      totalMessageCount: conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0),
      totalUnreadCount: conversations.reduce(
        (sum, conversation) => sum + conversation.messages.filter((message) => message.unread).length,
        0,
      ),
    },
  };
}

export function readConversationMessages(conversationId: string, afterSeq = 0, limit = 200) {
  requireConversation(conversationId);
  return listConversationMessages({ conversationId, afterSeq, limit });
}

export function applyConversationCommand(input: {
  command: ConversationCommand;
  idempotencyKey: string;
  expectedRevision?: number;
  producedBy?: "user" | "system" | "worker" | "migration";
}): ConversationCommandResult {
  const idempotencyKey = requireNonEmptyString(input.idempotencyKey, "Idempotency-Key");
  const producedBy = input.producedBy ?? "user";
  const command = input.command;
  const conversationId = requireNonEmptyString(commandConversationId(command), "conversationId");

  return getDatabase().transaction(() => {
    if (command.type === "append_message" && getConversationMessage(conversationId, command.message.id)) {
      const current = requireConversation(conversationId);
      const duplicateIdempotencyKey = `${idempotencyKey}:duplicate`;
      const existingDuplicateEvent = getConversationEventByIdempotencyKey<"message.appended">(duplicateIdempotencyKey);
      return {
        event:
          existingDuplicateEvent ??
          appendEvent({
            conversationId,
            kind: "message.appended",
            payload: { message: command.message },
            producedBy,
            idempotencyKey: duplicateIdempotencyKey,
          }),
        conversation: current.conversation,
        revision: current.revision,
      };
    }

    if (command.type === "delete_conversation") {
      const existingEvent = getConversationEventByIdempotencyKey(idempotencyKey);
      if (existingEvent) {
        if (existingEvent.kind !== "conversation.deleted" || existingEvent.conversationId !== conversationId) {
          throw new ConversationCommandIdempotencyConflictError();
        }
        return { event: existingEvent, conversations: listConversationMetas() };
      }

      const currentRevision = getConversationRevision(conversationId);
      if (currentRevision !== undefined) {
        assertExpectedRevision(conversationId, input.expectedRevision);
      }
      deleteConversationDeep(conversationId);
      const event = appendEvent({
        conversationId,
        kind: "conversation.deleted",
        payload: { conversationId },
        producedBy,
        idempotencyKey,
      });
      return { event, conversations: listConversationMetas() };
    }

    assertUnusedIdempotencyKey(idempotencyKey);

    if (command.type === "create_conversation") {
      const id = requireNonEmptyString(command.conversation.id, "conversation.id");
      const title = requireNonEmptyString(command.conversation.title, "conversation.title");
      if (getConversation(id)) {
        throw new ConversationCommandConflictError("会话已存在", getConversationRevision(id), input.expectedRevision);
      }
      const now = new Date().toISOString();
      const created = insertConversation({
        id,
        title,
        messages: [],
        createdAt: command.conversation.createdAt ?? command.conversation.updatedAt ?? now,
        updatedAt: command.conversation.updatedAt ?? now,
        status: command.conversation.status ?? "idle",
        goalId: command.conversation.goalId,
        goalInfoCollection: command.conversation.goalInfoCollection,
        planningRunState: command.conversation.planningRunState,
        workspacePath: command.conversation.workspacePath,
        workspaceInitializedAt: command.conversation.workspaceInitializedAt,
        runtimeEnvId: command.conversation.runtimeEnvId,
        runtimeSessions: command.conversation.runtimeSessions,
        pinned: command.conversation.pinned,
      });
      if (!created) throw new ConversationCommandValidationError("会话创建失败", 500);
      const event = appendEvent({
        conversationId: id,
        kind: "conversation.created",
        payload: { conversation: created.conversation },
        producedBy,
        idempotencyKey,
      });
      return { event, conversation: created.conversation, revision: created.revision };
    }

    assertExpectedRevision(conversationId, input.expectedRevision);
    const current = requireConversation(conversationId);

    if (command.type === "append_message") {
      const inserted = insertConversationMessage(conversationId, command.message);
      const event = appendEvent({
        conversationId,
        kind: "message.appended",
        payload: { message: inserted.message },
        producedBy,
        idempotencyKey,
      });
      return { event, conversation: getConversation(conversationId)?.conversation, revision: current.revision };
    }

    if (command.type === "update_message") {
      const updated = updateConversationMessage({
        conversationId,
        messageId: command.messageId,
        patch: command.patch,
        expectedVersion: command.expectedVersion,
      });
      if (!updated) throw new ConversationCommandValidationError("消息不存在", 404);
      if ("conflict" in updated && updated.conflict) {
        throw new ConversationCommandConflictError("消息已更新，请刷新后重试", updated.version, command.expectedVersion);
      }
      const event = appendEvent({
        conversationId,
        kind: "message.updated",
        payload: { message: updated.message, version: updated.version },
        producedBy,
        idempotencyKey,
      });
      return { event, conversation: getConversation(conversationId)?.conversation, revision: current.revision };
    }

    if (command.type === "delete_message") {
      deleteConversationMessage(conversationId, command.messageId);
      const event = appendEvent({
        conversationId,
        kind: "message.deleted",
        payload: { messageId: command.messageId },
        producedBy,
        idempotencyKey,
      });
      return { event, conversation: getConversation(conversationId)?.conversation, revision: current.revision };
    }

    if (command.type === "mark_conversation_read") {
      const messageIds = markConversationMessagesRead(conversationId);
      const event = appendEvent({
        conversationId,
        kind: "conversation.read",
        payload: { messageIds, revision: current.revision },
        producedBy,
        idempotencyKey,
      });
      return { event, conversation: getConversation(conversationId)?.conversation, revision: current.revision };
    }

    if (command.type === "mark_message_read") {
      const read = markConversationMessageRead(conversationId, command.messageId);
      if (!read) throw new ConversationCommandValidationError("消息不存在", 404);
      const event = appendEvent({
        conversationId,
        kind: "message.read",
        payload: { messageId: command.messageId, version: read.version },
        producedBy,
        idempotencyKey,
      });
      return { event, conversation: getConversation(conversationId)?.conversation, revision: current.revision };
    }

    if (command.type === "mark_conversation_unread") {
      const messageId = markLastMessageUnread(conversationId);
      const event = appendEvent({
        conversationId,
        kind: "conversation.unread",
        payload: { revision: current.revision, messageId: messageId ?? undefined },
        producedBy,
        idempotencyKey,
      });
      return { event, conversation: getConversation(conversationId)?.conversation, revision: current.revision };
    }

    const patch =
      command.type === "rename_conversation"
        ? { title: requireNonEmptyString(command.title, "title") }
        : command.type === "toggle_pinned"
          ? { pinned: !current.conversation.pinned }
          : command.type === "set_goal"
            ? { goalId: requireNonEmptyString(command.goalId, "goalId") }
            : command.type === "set_workspace"
              ? {
                  workspacePath: requireNonEmptyString(command.workspacePath, "workspacePath"),
                  workspaceInitializedAt: command.workspaceInitializedAt ?? new Date().toISOString(),
                }
              : command.type === "set_runtime_env"
                ? { runtimeEnvId: requireNonEmptyString(command.runtimeEnvId, "runtimeEnvId") }
                : command.type === "set_runtime_session"
                  ? {
                      runtimeSessions: buildRuntimeSessionsPatch(
                        current.conversation.runtimeSessions,
                        requireNonEmptyString(command.runtimeKind, "runtimeKind"),
                        command.sessionId === null
                          ? null
                          : requireNonEmptyString(command.sessionId, "sessionId"),
                      ),
                    }
                  : command.type === "set_status"
                    ? { status: command.status ?? "idle" }
                    : command.type === "set_goal_info_collection"
                      ? { goalInfoCollection: command.collection }
                      : command.type === "set_planning_run_state"
                        ? { planningRunState: command.state }
                        : {};
    const updated = updateConversationFields(conversationId, patch);
    if (!updated) throw new ConversationCommandValidationError("会话不存在", 404);
    const kind =
      command.type === "rename_conversation"
        ? "conversation.renamed"
        : command.type === "toggle_pinned"
          ? "conversation.pinned_toggled"
          : command.type === "set_goal"
            ? "conversation.goal_set"
            : command.type === "set_workspace"
              ? "conversation.workspace_set"
              : command.type === "set_runtime_env"
                ? "conversation.runtime_env_set"
                : command.type === "set_runtime_session"
                  ? "conversation.runtime_session_set"
                  : command.type === "set_status"
                    ? "conversation.status_changed"
                    : command.type === "set_goal_info_collection"
                      ? "conversation.goal_info_collection_updated"
                      : "conversation.planning_run_state_updated";
    const event = appendEvent({
      conversationId,
      kind,
      payload:
        kind === "conversation.renamed"
          ? { title: updated.conversation.title, revision: updated.revision }
          : kind === "conversation.pinned_toggled"
            ? { pinned: Boolean(updated.conversation.pinned), revision: updated.revision }
            : kind === "conversation.goal_set"
              ? { goalId: updated.conversation.goalId ?? "", revision: updated.revision }
              : kind === "conversation.workspace_set"
                ? {
                    workspacePath: updated.conversation.workspacePath ?? "",
                    workspaceInitializedAt: updated.conversation.workspaceInitializedAt,
                    revision: updated.revision,
                  }
                : kind === "conversation.runtime_env_set"
                  ? { runtimeEnvId: updated.conversation.runtimeEnvId ?? "", revision: updated.revision }
                  : kind === "conversation.runtime_session_set"
                    ? {
                        runtimeKind: command.type === "set_runtime_session" ? command.runtimeKind : "",
                        sessionId:
                          command.type === "set_runtime_session" ? (command.sessionId ?? "") : "",
                        revision: updated.revision,
                      }
                    : kind === "conversation.status_changed"
                      ? { status: updated.conversation.status, revision: updated.revision }
                      : kind === "conversation.goal_info_collection_updated"
                        ? { collection: updated.conversation.goalInfoCollection ?? null, revision: updated.revision }
                        : kind === "conversation.planning_run_state_updated"
                          ? { state: updated.conversation.planningRunState ?? null, revision: updated.revision }
                          : { revision: updated.revision },
      producedBy,
      idempotencyKey,
    } as Parameters<typeof appendConversationEvent>[0]);
    return { event, conversation: updated.conversation, revision: updated.revision };
  })();
}

export function importConversations(conversations: Conversation[]) {
  return getDatabase().transaction(() => {
    if (countConversations() > 0) {
      throw new ConversationCommandConflictError("服务端已存在会话，拒绝覆盖导入");
    }
    const imported: Conversation[] = [];
    for (const conversation of conversations) {
      const created = applyConversationCommand({
        command: { type: "create_conversation", conversation },
        idempotencyKey: createIdempotencyKey("conversation.import.create", conversation.id),
        producedBy: "migration",
      });
      if (created.conversation) imported.push(created.conversation);
      for (const message of conversation.messages) {
        applyConversationCommand({
          command: { type: "append_message", conversationId: conversation.id, message },
          idempotencyKey: createIdempotencyKey("conversation.import.message", conversation.id, message.id),
          producedBy: "migration",
        });
      }
    }
    return imported;
  })();
}
