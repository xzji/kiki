"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { buildConversationsFromGoals } from "@/mocks/conversations";
import { initialGoals } from "@/mocks/goals";
import type { Conversation, ConversationMessage, GoalInfoCollection } from "@/types/kiki";

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
  renameConversation: (conversationId: string, title: string) => void;
  setConversationRuntimeEnv: (conversationId: string, runtimeEnvId: string) => void;
  setClaudeSessionId: (conversationId: string, claudeSessionId: string) => void;
  setConversationStatus: (conversationId: string, status: Conversation["status"]) => void;
};

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
      renameConversation: (conversationId, title) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, title } : item,
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
      partialize: (state) => ({
        conversations: state.conversations,
      }),
    },
  ),
);

export function getConversationUnreadCount(conversation: Conversation) {
  return conversation.messages.filter((msg) => msg.unread).length;
}
