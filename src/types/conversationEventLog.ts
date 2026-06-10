import type { Conversation, ConversationMessage } from "@/types/kiki";

export type ConversationEventKind =
  | "conversation.created"
  | "conversation.renamed"
  | "conversation.deleted"
  | "conversation.pinned_toggled"
  | "conversation.goal_set"
  | "conversation.workspace_set"
  | "conversation.runtime_env_set"
  | "conversation.runtime_session_set"
  | "conversation.status_changed"
  | "conversation.goal_info_collection_updated"
  | "conversation.planning_run_state_updated"
  | "conversation.read"
  | "conversation.unread"
  | "message.appended"
  | "message.updated"
  | "message.deleted"
  | "message.read";

export type ConversationEventProducer = "user" | "system" | "worker" | "migration";

export type ConversationEventPayloadMap = {
  "conversation.created": { conversation: Conversation };
  "conversation.renamed": { title: string; revision: number };
  "conversation.deleted": { conversationId: string };
  "conversation.pinned_toggled": { pinned: boolean; revision: number };
  "conversation.goal_set": { goalId: string; revision: number };
  "conversation.workspace_set": { workspacePath: string; workspaceInitializedAt?: string; revision: number };
  "conversation.runtime_env_set": { runtimeEnvId: string; revision: number };
  "conversation.runtime_session_set": { runtimeKind: string; sessionId: string; revision: number };
  "conversation.status_changed": { status: Conversation["status"]; revision: number };
  "conversation.goal_info_collection_updated": { collection: Conversation["goalInfoCollection"] | null; revision: number };
  "conversation.planning_run_state_updated": { state: Conversation["planningRunState"] | null; revision: number };
  "conversation.read": { messageIds: string[]; revision: number };
  "conversation.unread": { revision: number };
  "message.appended": { message: ConversationMessage };
  "message.updated": { message: ConversationMessage; version: number };
  "message.deleted": { messageId: string };
  "message.read": { messageId: string; version: number };
};

export type ConversationEventPayload<K extends ConversationEventKind = ConversationEventKind> =
  ConversationEventPayloadMap[K];

export type ConversationEventRecord<K extends ConversationEventKind = ConversationEventKind> = {
  id: number;
  eventId: string;
  conversationId: string;
  kind: K;
  payload: ConversationEventPayload<K>;
  producedBy: ConversationEventProducer;
  idempotencyKey?: string;
  createdAt: string;
};
