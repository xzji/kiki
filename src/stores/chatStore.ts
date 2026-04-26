"use client";

import { create } from "zustand";

import { formatMessageTime } from "@/lib/date";
import { makeId } from "@/lib/utils";
import type { DoraMessage } from "@/types/dora";

type ChatStore = {
  threads: Record<string, DoraMessage[]>;
  seedThread: (threadId: string, messages: DoraMessage[]) => void;
  sendUserMessage: (threadId: string, content: string) => DoraMessage;
  sendDoraMessage: (threadId: string, content: string) => DoraMessage;
};

export const useChatStore = create<ChatStore>((set) => ({
  threads: {},
  seedThread: (threadId, messages) => set((state) => (state.threads[threadId] ? state : { threads: { ...state.threads, [threadId]: messages } })),
  sendUserMessage: (threadId, content) => {
    const message = { id: makeId("msg"), role: "user" as const, content, timestamp: formatMessageTime(new Date()) };
    set((state) => ({ threads: { ...state.threads, [threadId]: [...(state.threads[threadId] ?? []), message] } }));
    return message;
  },
  sendDoraMessage: (threadId, content) => {
    const message = { id: makeId("msg"), role: "dora" as const, content, timestamp: formatMessageTime(new Date()) };
    set((state) => ({ threads: { ...state.threads, [threadId]: [...(state.threads[threadId] ?? []), message] } }));
    return message;
  },
}));
