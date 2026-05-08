"use client";

import { create } from "zustand";

import { buildConversationsFromGoals } from "@/mocks/conversations";
import { initialGoals } from "@/mocks/goals";
import type { Conversation, ConversationMessage } from "@/types/dora";

type ConversationStore = {
  conversations: Conversation[];
  createConversation: (title?: string) => Conversation;
  appendMessage: (conversationId: string, message: ConversationMessage) => void;
  markConversationRead: (conversationId: string) => void;
  markConversationUnread: (conversationId: string) => void;
  markMessageRead: (conversationId: string, messageId: string) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  deleteConversation: (conversationId: string) => void;
  toggleConversationPinned: (conversationId: string) => void;
  setGoalForConversation: (conversationId: string, goalId: string) => void;
  renameConversation: (conversationId: string, title: string) => void;
};

export const useConversationStore = create<ConversationStore>((set, get) => ({
  conversations: buildConversationsFromGoals(initialGoals),
  createConversation: (title) => {
    const now = new Date().toISOString();
    const next: Conversation = {
      id: `conv-new-${Date.now()}`,
      title: title || "新会话",
      messages: [],
      updatedAt: now,
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
  renameConversation: (conversationId, title) => {
    set({
      conversations: get().conversations.map((item) =>
        item.id === conversationId ? { ...item, title } : item,
      ),
    });
  },
}));

export function getConversationUnreadCount(conversation: Conversation) {
  return conversation.messages.filter((msg) => msg.unread).length;
}
