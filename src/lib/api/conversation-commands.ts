"use client";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import type { ConversationEventRecord } from "@/types/conversationEventLog";
import type { Conversation, ConversationMessage, GoalInfoCollection, GoalPlanningRunState } from "@/types/kiki";

export class ConversationCommandError extends Error {
  constructor(
    public status: number,
    public reason: string,
    public details?: Record<string, unknown>,
  ) {
    super(reason);
    this.name = "ConversationCommandError";
  }
}

type ConversationCommandResponse = {
  ok?: boolean;
  reason?: string;
  event?: ConversationEventRecord;
  conversation?: Conversation;
  conversations?: Conversation[];
  revision?: number;
  currentRevision?: number;
  expectedRevision?: number;
};

async function readCommandResponse(response: Response): Promise<ConversationCommandResponse> {
  try {
    return (await response.json()) as ConversationCommandResponse;
  } catch {
    return {};
  }
}

async function postConversationCommand(input: {
  command: unknown;
  expectedRevision?: number;
  idempotencyKey: string;
}) {
  const response = await fetch("/api/conversations/commands", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      command: input.command,
      expectedRevision: input.expectedRevision,
    }),
  });
  const data = await readCommandResponse(response);
  if (!response.ok) {
    throw new ConversationCommandError(response.status, data.reason || "会话命令执行失败", {
      currentRevision: data.currentRevision,
      expectedRevision: data.expectedRevision,
    });
  }
  return data;
}

export async function fetchConversationState() {
  const response = await fetch("/api/conversations/state", { cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    conversations?: Conversation[];
    latestEventId?: number;
    reason?: string;
  };
  if (!response.ok || !data.ok) throw new ConversationCommandError(response.status, data.reason || "读取会话状态失败");
  return { conversations: data.conversations ?? [], latestEventId: data.latestEventId ?? 0 };
}

export async function fetchConversationMessages(conversationId: string, afterSeq = 0, limit = 200) {
  const response = await fetch(`/api/conversations/${conversationId}/messages?after=${afterSeq}&limit=${limit}`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; messages?: ConversationMessage[]; reason?: string };
  if (!response.ok || !data.ok) throw new ConversationCommandError(response.status, data.reason || "读取会话消息失败");
  return data.messages ?? [];
}

export function createConversationCommand(conversation: Conversation) {
  return postConversationCommand({
    command: { type: "create_conversation", conversation },
    idempotencyKey: createIdempotencyKey("conversation.create", conversation.id),
  });
}

export function appendConversationMessageCommand(conversationId: string, message: ConversationMessage) {
  return postConversationCommand({
    command: { type: "append_message", conversationId, message },
    idempotencyKey: createIdempotencyKey("conversation.message.append", conversationId, message.id),
  });
}

export function updateConversationMessageCommand(
  conversationId: string,
  messageId: string,
  patch: Partial<ConversationMessage>,
) {
  return postConversationCommand({
    command: { type: "update_message", conversationId, messageId, patch },
    idempotencyKey: createIdempotencyKey("conversation.message.update", conversationId, messageId, String(Date.now())),
  });
}

export function deleteConversationMessageCommand(conversationId: string, messageId: string) {
  return postConversationCommand({
    command: { type: "delete_message", conversationId, messageId },
    idempotencyKey: createIdempotencyKey("conversation.message.delete", conversationId, messageId),
  });
}

export function deleteConversationCommand(conversationId: string) {
  return postConversationCommand({
    command: { type: "delete_conversation", conversationId },
    idempotencyKey: createIdempotencyKey("conversation.delete", conversationId),
  });
}

export function renameConversationCommand(conversationId: string, title: string) {
  return postConversationCommand({
    command: { type: "rename_conversation", conversationId, title },
    idempotencyKey: createIdempotencyKey("conversation.rename", conversationId, title),
  });
}

export function toggleConversationPinnedCommand(conversationId: string) {
  return postConversationCommand({
    command: { type: "toggle_pinned", conversationId },
    idempotencyKey: createIdempotencyKey("conversation.toggle_pinned", conversationId, String(Date.now())),
  });
}

export function markConversationReadCommand(conversationId: string) {
  return postConversationCommand({
    command: { type: "mark_conversation_read", conversationId },
    idempotencyKey: createIdempotencyKey("conversation.read", conversationId, String(Date.now())),
  });
}

export function markConversationUnreadCommand(conversationId: string) {
  return postConversationCommand({
    command: { type: "mark_conversation_unread", conversationId },
    idempotencyKey: createIdempotencyKey("conversation.unread", conversationId, String(Date.now())),
  });
}

export function markConversationMessageReadCommand(conversationId: string, messageId: string) {
  return postConversationCommand({
    command: { type: "mark_message_read", conversationId, messageId },
    idempotencyKey: createIdempotencyKey("conversation.message.read", conversationId, messageId),
  });
}

export function setConversationGoalCommand(conversationId: string, goalId: string) {
  return postConversationCommand({
    command: { type: "set_goal", conversationId, goalId },
    idempotencyKey: createIdempotencyKey("conversation.goal.set", conversationId, goalId),
  });
}

export function setConversationWorkspaceCommand(conversationId: string, workspacePath: string) {
  return postConversationCommand({
    command: { type: "set_workspace", conversationId, workspacePath },
    idempotencyKey: createIdempotencyKey("conversation.workspace.set", conversationId, workspacePath),
  });
}

export function setConversationRuntimeEnvCommand(conversationId: string, runtimeEnvId: string) {
  return postConversationCommand({
    command: { type: "set_runtime_env", conversationId, runtimeEnvId },
    idempotencyKey: createIdempotencyKey("conversation.runtime_env.set", conversationId, runtimeEnvId),
  });
}

export function setConversationClaudeSessionCommand(conversationId: string, claudeSessionId: string) {
  return postConversationCommand({
    command: { type: "set_claude_session", conversationId, claudeSessionId },
    idempotencyKey: createIdempotencyKey("conversation.claude_session.set", conversationId, claudeSessionId),
  });
}

export function setConversationStatusCommand(conversationId: string, status: Conversation["status"]) {
  return postConversationCommand({
    command: { type: "set_status", conversationId, status },
    idempotencyKey: createIdempotencyKey("conversation.status.set", conversationId, status, String(Date.now())),
  });
}

export function setGoalInfoCollectionCommand(conversationId: string, collection: GoalInfoCollection | null) {
  return postConversationCommand({
    command: { type: "set_goal_info_collection", conversationId, collection },
    idempotencyKey: createIdempotencyKey("conversation.goal_info.set", conversationId, String(Date.now())),
  });
}

export function setPlanningRunStateCommand(conversationId: string, state: GoalPlanningRunState | null) {
  return postConversationCommand({
    command: { type: "set_planning_run_state", conversationId, state },
    idempotencyKey: createIdempotencyKey("conversation.planning_state.set", conversationId, String(Date.now())),
  });
}

export async function importLegacyConversations(conversations: Conversation[]) {
  const response = await fetch("/api/conversations/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversations }),
  });
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; reason?: string; conversations?: Conversation[] };
  if (!response.ok || !data.ok) throw new ConversationCommandError(response.status, data.reason || "导入会话失败");
  return data.conversations ?? [];
}
