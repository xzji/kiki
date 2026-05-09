"use client";

import { create } from "zustand";

import { formatMessageTime } from "@/lib/date";
import { makeId } from "@/lib/utils";
import type { KikiMessage } from "@/types/kiki";

type ChatStore = {
  threads: Record<string, KikiMessage[]>;
  seedThread: (threadId: string, messages: KikiMessage[]) => void;
  sendUserMessage: (threadId: string, content: string) => KikiMessage;
  sendKikiMessage: (threadId: string, content: string) => KikiMessage;
};

export const useChatStore = create<ChatStore>((set) => ({
  threads: {},
  seedThread: (threadId, messages) => set((state) => (state.threads[threadId] ? state : { threads: { ...state.threads, [threadId]: messages } })),
  sendUserMessage: (threadId, content) => {
    const message = { id: makeId("msg"), role: "user" as const, content, timestamp: formatMessageTime(new Date()) };
    set((state) => ({ threads: { ...state.threads, [threadId]: [...(state.threads[threadId] ?? []), message] } }));
    return message;
  },
  sendKikiMessage: (threadId, content) => {
    const message = { id: makeId("msg"), role: "kiki" as const, content, timestamp: formatMessageTime(new Date()) };
    set((state) => ({ threads: { ...state.threads, [threadId]: [...(state.threads[threadId] ?? []), message] } }));
    return message;
  },
}));
