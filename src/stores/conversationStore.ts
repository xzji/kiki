"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { migrateConversationIds } from "@/lib/opaqueIds";
import { buildConversationsFromGoals } from "@/mocks/conversations";
import { initialGoals } from "@/mocks/goals";
import type { Conversation, ConversationMessage, GoalInfoCollection, GoalPlanningRunState } from "@/types/kiki";

type ConversationStore = {
  conversations: Conversation[];
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
  setClaudeSessionId: (conversationId: string, claudeSessionId: string) => void;
  setConversationStatus: (conversationId: string, status: Conversation["status"]) => void;
};

const MOCK_BASELINE_RESET_VERSION = 10;
const TERMINAL_CONTROL_NOTICE_PATTERNS = [
  /^\s*（已停止，未检测到正在运行的任务）\s*$/gm,
  /^\s*已停止，未检测到正在运行的任务。\s*$/gm,
];
const RECOVERED_WORKSPACE_CONVERSATIONS: Conversation[] = [
  {
    id: "conv-new-1779009317391",
    title: "越南玩5天",
    status: "error",
    workspacePath: "/Users/bytedance/Documents/trae/long_horizon_agent/data/workspaces/conversations/conv-new-1779009317391",
    workspaceInitializedAt: "2026-05-17T09:15:17.453Z",
    updatedAt: "2026-05-17T09:28:17.486Z",
    planningRunState: {
      status: "failed",
      phase: "generating_tasks",
      action: "resume_plan",
      goalText: "越南玩5天",
      errorMessage: "任务生成已中断",
      failedAt: "2026-05-17T09:28:17.486Z",
      updatedAt: "2026-05-17T09:28:17.486Z",
      lastUserMessage: "计划5.21去，胡志明和芽庄、预算3000没人",
    },
    messages: [
      {
        id: "msg-recovered-1779009320539-user",
        role: "user",
        kind: "text",
        content: "/goal 越南玩5天",
        createdAt: "2026-05-17T09:15:20.539Z",
        unread: false,
      },
      {
        id: "msg-recovered-1779009320539-kiki",
        role: "kiki",
        kind: "text",
        content: "正在理解目标和关键约束...\n正在准备几个关键澄清问题...\n正在生成首轮澄清问题...",
        createdAt: "2026-05-17T09:15:20.539Z",
        unread: false,
        status: "done",
      },
      {
        id: "msg-recovered-1779010097486-kiki",
        role: "kiki",
        kind: "text",
        content: "目标规划生成失败：任务生成已中断。可从已保存的 checkpoint 继续恢复。",
        createdAt: "2026-05-17T09:28:17.486Z",
        unread: true,
        status: "error",
      },
    ],
  },
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
  return conversations.map((conversation) => {
    const migratedConversation = migrateConversationIds(conversation);
    return {
      ...migratedConversation,
      messages: migratedConversation.messages.map((message) => ({
        ...message,
        content: sanitizeConversationMessageContent(message.content),
      })),
    };
  });
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

function migrateConversationState(persistedState: unknown) {
  const persisted = persistedState as Partial<ConversationStore> | undefined;
  const baseline = buildConversationsFromGoals(initialGoals);
  const persistedConversations = Array.isArray(persisted?.conversations) ? persisted.conversations : [];
  return {
    conversations: sanitizeConversationHistory(
      mergeConversationsById(persistedConversations, RECOVERED_WORKSPACE_CONVERSATIONS, baseline),
    ),
  };
}

export const useConversationStore = create<ConversationStore>()(
  persist(
    (set, get) => ({
      conversations: buildConversationsFromGoals(initialGoals),
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
      },
      updateMessage: (conversationId, messageId, updater) => {
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
      },
      deleteConversation: (conversationId) => {
        set({
          conversations: get().conversations.filter((item) => item.id !== conversationId),
        });
      },
      toggleConversationPinned: (conversationId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, pinned: !item.pinned } : item,
          ),
        });
      },
      setGoalForConversation: (conversationId, goalId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, goalId } : item,
          ),
        });
      },
      setGoalInfoCollection: (conversationId, collection) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? { ...item, goalInfoCollection: collection ?? undefined }
              : item,
          ),
        });
      },
      setPlanningRunState: (conversationId, state) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, planningRunState: state ?? undefined } : item,
          ),
        });
      },
      renameConversation: (conversationId, title) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, title } : item,
          ),
        });
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
      },
      setConversationRuntimeEnv: (conversationId, runtimeEnvId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, runtimeEnvId } : item,
          ),
        });
      },
      setClaudeSessionId: (conversationId, claudeSessionId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, claudeSessionId } : item,
          ),
        });
      },
      setConversationStatus: (conversationId, status) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, status } : item,
          ),
        });
      },
    }),
    {
      name: "kiki.conversations",
      version: MOCK_BASELINE_RESET_VERSION,
      migrate: migrateConversationState,
      partialize: (state) => ({
        conversations: state.conversations,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<ConversationStore> | undefined;
        return {
          ...currentState,
          ...persisted,
          conversations: sanitizeConversationHistory(
            mergeConversationsById(
              persisted?.conversations ?? currentState.conversations,
              RECOVERED_WORKSPACE_CONVERSATIONS,
              buildConversationsFromGoals(initialGoals),
            ),
          ),
        };
      },
    },
  ),
);

export function getConversationUnreadCount(conversation: Conversation) {
  return conversation.messages.filter((msg) => msg.unread).length;
}
