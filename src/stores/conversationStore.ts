"use client";

import { create } from "zustand";

import {
  appendConversationMessageCommand,
  createConversationCommand,
  deleteConversationCommand,
  deleteConversationMessageCommand,
  fetchConversationState,
  markConversationMessageReadCommand,
  markConversationReadCommand,
  markConversationUnreadCommand,
  renameConversationCommand,
  setConversationClaudeSessionCommand,
  setConversationGoalCommand,
  setConversationRuntimeEnvCommand,
  setConversationStatusCommand,
  setConversationWorkspaceCommand,
  setGoalInfoCollectionCommand,
  setPlanningRunStateCommand,
  toggleConversationPinnedCommand,
  updateConversationMessageCommand,
} from "@/lib/api/conversation-commands";
import { migrateConversationIds, normalizeGoalId } from "@/lib/opaqueIds";
import type { ConversationEventRecord } from "@/types/conversationEventLog";
import type { Conversation, ConversationMessage, GoalInfoCollection, GoalPlanningRunState } from "@/types/kiki";

type ConversationStore = {
  conversations: Conversation[];
  hydrateConversations: (conversations: Conversation[]) => void;
  applyConversationEvent: (event: ConversationEventRecord) => void;
  createConversation: (title?: string) => Conversation;
  appendMessage: (conversationId: string, message: ConversationMessage) => void;
  updateMessage: (
    conversationId: string,
    messageId: string,
    updater: (message: ConversationMessage) => ConversationMessage,
  ) => void;
  markConversationRead: (conversationId: string) => void;
  markConversationUnread: (conversationId: string) => void;
  markMessageRead: (conversationId: string, messageId: string) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  deleteConversation: (conversationId: string) => void;
  toggleConversationPinned: (conversationId: string) => void;
  setGoalForConversation: (conversationId: string, goalId: string) => void;
  setGoalInfoCollection: (conversationId: string, collection: GoalInfoCollection | null) => void;
  setPlanningRunState: (conversationId: string, state: GoalPlanningRunState | null) => void;
  renameConversation: (conversationId: string, title: string) => void;
  setConversationWorkspace: (conversationId: string, workspacePath: string) => void;
  setConversationRuntimeEnv: (conversationId: string, runtimeEnvId: string) => void;
  setClaudeSessionId: (conversationId: string, claudeSessionId: string | undefined) => void;
  setConversationStatus: (conversationId: string, status: Conversation["status"]) => void;
};

const MOCK_GOAL_IDS = new Set(
  [
    "goal-toefl",
    "goal-suv",
    "goal-osaka",
    "goal-mail",
    "goal-news",
    "goal-job",
    "goal-tomato-egg",
  ].map((id) => normalizeGoalId(id)),
);
const MOCK_CONVERSATION_IDS = new Set([
  "conv-new-1779009317391",
  ...Array.from(MOCK_GOAL_IDS, (goalId) => `conv-${goalId}`),
]);
const LEGACY_MOCK_CONVERSATION_TITLES = new Set(["越南玩5天"]);
const TERMINAL_CONTROL_NOTICE_PATTERNS = [
  /^\s*（已停止，未检测到正在运行的任务）\s*$/gm,
  /^\s*已停止，未检测到正在运行的任务。\s*$/gm,
];

function sanitizeConversationMessageContent(content: string) {
  return TERMINAL_CONTROL_NOTICE_PATTERNS.reduce(
    (next, pattern) => next.replace(pattern, ""),
    content,
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeConversationHistory(conversations: Conversation[]) {
  return conversations
    .map((conversation) => migrateConversationIds(conversation))
    .filter((conversation) => !MOCK_CONVERSATION_IDS.has(conversation.id))
    .filter((conversation) => !conversation.goalId || !MOCK_GOAL_IDS.has(conversation.goalId))
    .filter((conversation) => !LEGACY_MOCK_CONVERSATION_TITLES.has(conversation.title))
    .map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => ({
        ...message,
        content: sanitizeConversationMessageContent(message.content),
      })),
    }));
}

function mergeConversationsById(...groups: Conversation[][]) {
  const merged = new Map<string, Conversation>();
  for (const group of groups) {
    for (const conversation of group) {
      if (!merged.has(conversation.id)) merged.set(conversation.id, conversation);
    }
  }
  return Array.from(merged.values()).sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
}

function sendConversationCommand(task: Promise<unknown>) {
  task.catch((error) => {
    console.error("[conversation-command]", error);
    void resyncConversations();
  });
}

let resyncPending = false;
async function resyncConversations() {
  if (resyncPending) return;
  resyncPending = true;
  try {
    const remote = await fetchConversationState();
    useConversationStore.getState().hydrateConversations(remote.conversations);
  } catch (error) {
    console.error("[conversation-resync]", error);
  } finally {
    resyncPending = false;
  }
}

function upsertConversation(conversations: Conversation[], next: Conversation) {
  const found = conversations.some((item) => item.id === next.id);
  return found
    ? conversations.map((item) => (item.id === next.id ? { ...item, ...next } : item))
    : [next, ...conversations];
}

type ConversationEventLoosePayload = {
  conversation?: Conversation;
  title?: string;
  pinned?: boolean;
  goalId?: string;
  workspacePath?: string;
  workspaceInitializedAt?: string;
  runtimeEnvId?: string;
  claudeSessionId?: string;
  status?: Conversation["status"];
  collection?: GoalInfoCollection | null;
  state?: GoalPlanningRunState | null;
  message?: ConversationMessage;
  messageId?: string;
};

function applyConversationEventToList(conversations: Conversation[], event: ConversationEventRecord) {
  const payload = event.payload as ConversationEventLoosePayload;
  if (event.kind === "conversation.created") return upsertConversation(conversations, payload.conversation as Conversation);
  if (event.kind === "conversation.deleted") return conversations.filter((item) => item.id !== event.conversationId);
  return conversations.map((conversation) => {
    if (conversation.id !== event.conversationId) return conversation;
    switch (event.kind) {
      case "conversation.renamed":
        return { ...conversation, title: payload.title ?? conversation.title };
      case "conversation.pinned_toggled":
        return { ...conversation, pinned: payload.pinned ?? conversation.pinned };
      case "conversation.goal_set":
        return { ...conversation, goalId: payload.goalId };
      case "conversation.workspace_set":
        return {
          ...conversation,
          workspacePath: payload.workspacePath,
          workspaceInitializedAt: payload.workspaceInitializedAt,
        };
      case "conversation.runtime_env_set":
        return { ...conversation, runtimeEnvId: payload.runtimeEnvId };
      case "conversation.claude_session_set":
        return { ...conversation, claudeSessionId: payload.claudeSessionId };
      case "conversation.status_changed":
        return { ...conversation, status: payload.status ?? conversation.status };
      case "conversation.goal_info_collection_updated":
        return { ...conversation, goalInfoCollection: payload.collection ?? undefined };
      case "conversation.planning_run_state_updated":
        return { ...conversation, planningRunState: payload.state ?? undefined };
      case "conversation.read":
        return { ...conversation, messages: conversation.messages.map((message) => ({ ...message, unread: false })) };
      case "conversation.unread": {
        const lastIndex = conversation.messages.length - 1;
        return {
          ...conversation,
          messages: conversation.messages.map((message, index) =>
            index === lastIndex ? { ...message, unread: true } : message,
          ),
        };
      }
      case "message.appended": {
        if (!payload.message) return conversation;
        return conversation.messages.some((message) => message.id === payload.message?.id)
          ? conversation
          : { ...conversation, messages: [...conversation.messages, payload.message] };
      }
      case "message.updated": {
        if (!payload.message) return conversation;
        return {
          ...conversation,
          messages: conversation.messages.map((message) =>
            message.id === payload.message?.id && payload.message ? payload.message : message,
          ),
        };
      }
      case "message.deleted":
        return {
          ...conversation,
          messages: conversation.messages.filter((message) => message.id !== payload.messageId),
        };
      case "message.read":
        return {
          ...conversation,
          messages: conversation.messages.map((message) =>
            message.id === payload.messageId ? { ...message, unread: false } : message,
          ),
        };
      default:
        return conversation;
    }
  });
}

export const useConversationStore = create<ConversationStore>()(
  (set, get) => ({
      conversations: [],
      hydrateConversations: (conversations) => {
        set({ conversations: sanitizeConversationHistory(mergeConversationsById(conversations)) });
      },
      applyConversationEvent: (event) => {
        set({ conversations: applyConversationEventToList(get().conversations, event) });
      },
      createConversation: (title) => {
        const now = new Date().toISOString();
        const next: Conversation = {
          id: `conv-new-${Date.now()}`,
          title: title || "新会话",
          messages: [],
          updatedAt: now,
          status: "idle",
        };
        set({ conversations: [next, ...get().conversations] });
        sendConversationCommand(createConversationCommand(next));
        return next;
      },
      appendMessage: (conversationId, message) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  messages: [...item.messages, message],
                  updatedAt: message.createdAt,
                }
              : item,
          ),
        });
        sendConversationCommand(appendConversationMessageCommand(conversationId, message));
      },
      updateMessage: (conversationId, messageId, updater) => {
        const currentMessage = get()
          .conversations.find((item) => item.id === conversationId)
          ?.messages.find((message) => message.id === messageId);
        const nextMessage = currentMessage ? updater(currentMessage) : null;
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  messages: item.messages.map((message) =>
                    message.id === messageId ? updater(message) : message,
                  ),
                }
              : item,
          ),
        });
        if (nextMessage) {
          sendConversationCommand(updateConversationMessageCommand(conversationId, messageId, nextMessage));
        }
      },
      markConversationRead: (conversationId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  messages: item.messages.map((msg) => ({ ...msg, unread: false })),
                }
              : item,
          ),
        });
        sendConversationCommand(markConversationReadCommand(conversationId));
      },
      markConversationUnread: (conversationId) => {
        set({
          conversations: get().conversations.map((item) => {
            if (item.id !== conversationId || item.messages.length === 0) return item;
            const lastIndex = item.messages.length - 1;
            return {
              ...item,
              messages: item.messages.map((msg, index) =>
                index === lastIndex ? { ...msg, unread: true } : msg,
              ),
            };
          }),
        });
        sendConversationCommand(markConversationUnreadCommand(conversationId));
      },
      markMessageRead: (conversationId, messageId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  messages: item.messages.map((msg) =>
                    msg.id === messageId ? { ...msg, unread: false } : msg,
                  ),
                }
              : item,
          ),
        });
        sendConversationCommand(markConversationMessageReadCommand(conversationId, messageId));
      },
      deleteMessage: (conversationId, messageId) => {
        set({
          conversations: get().conversations.map((item) => {
            if (item.id !== conversationId) return item;
            const nextMessages = item.messages.filter((msg) => msg.id !== messageId);
            const latest = nextMessages[nextMessages.length - 1];
            return {
              ...item,
              messages: nextMessages,
              updatedAt: latest?.createdAt ?? item.updatedAt,
            };
          }),
        });
        sendConversationCommand(deleteConversationMessageCommand(conversationId, messageId));
      },
      deleteConversation: (conversationId) => {
        set({
          conversations: get().conversations.filter((item) => item.id !== conversationId),
        });
        sendConversationCommand(deleteConversationCommand(conversationId));
      },
      toggleConversationPinned: (conversationId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, pinned: !item.pinned } : item,
          ),
        });
        sendConversationCommand(toggleConversationPinnedCommand(conversationId));
      },
      setGoalForConversation: (conversationId, goalId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, goalId } : item,
          ),
        });
        sendConversationCommand(setConversationGoalCommand(conversationId, goalId));
      },
      setGoalInfoCollection: (conversationId, collection) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? { ...item, goalInfoCollection: collection ?? undefined }
              : item,
          ),
        });
        sendConversationCommand(setGoalInfoCollectionCommand(conversationId, collection));
      },
      setPlanningRunState: (conversationId, state) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, planningRunState: state ?? undefined } : item,
          ),
        });
        sendConversationCommand(setPlanningRunStateCommand(conversationId, state));
      },
      renameConversation: (conversationId, title) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, title } : item,
          ),
        });
        sendConversationCommand(renameConversationCommand(conversationId, title));
      },
      setConversationWorkspace: (conversationId, workspacePath) => {
        const now = new Date().toISOString();
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  workspacePath,
                  workspaceInitializedAt: item.workspaceInitializedAt || now,
                }
              : item,
          ),
        });
        sendConversationCommand(setConversationWorkspaceCommand(conversationId, workspacePath));
      },
      setConversationRuntimeEnv: (conversationId, runtimeEnvId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, runtimeEnvId } : item,
          ),
        });
        sendConversationCommand(setConversationRuntimeEnvCommand(conversationId, runtimeEnvId));
      },
      setClaudeSessionId: (conversationId, claudeSessionId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, claudeSessionId } : item,
          ),
        });
        sendConversationCommand(setConversationClaudeSessionCommand(conversationId, claudeSessionId));
      },
      setConversationStatus: (conversationId, status) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, status } : item,
          ),
        });
        sendConversationCommand(setConversationStatusCommand(conversationId, status));
      },
    }),
);

export function getConversationUnreadCount(conversation: Conversation) {
  return conversation.messages.filter((msg) => msg.unread).length;
}
