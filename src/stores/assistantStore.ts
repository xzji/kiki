"use client";

import { create } from "zustand";

export type AssistantMessage = {
  id: string;
  role: "user" | "kiki";
  content: string;
  createdAt: string;
};

type AssistantState = {
  hydrated: boolean;
  isOpen: boolean;
  messages: AssistantMessage[];
  hydrate: () => void;
  open: () => void;
  close: () => void;
  toggle: () => void;
  send: (content: string) => void;
};

const STORAGE_KEY = "dora.assistant.isOpen";

function readPersistedOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "1";
  } catch {
    return false;
  }
}

function writePersistedOpen(open: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
}

function mockKiKiReply(input: string): string {
  if (input.length < 6) return "我听到了，继续说说看？";
  if (input.includes("?") || input.includes("？")) return "好问题，我在后台帮你拆解一下，稍后同步你结果。";
  return "收到，我会把它加入你的收件箱并在合适的时候推进。";
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  hydrated: false,
  isOpen: false,
  messages: [],
  hydrate: () => {
    if (get().hydrated) return;
    set({ hydrated: true, isOpen: readPersistedOpen() });
  },
  open: () => {
    set({ isOpen: true });
    writePersistedOpen(true);
  },
  close: () => {
    set({ isOpen: false });
    writePersistedOpen(false);
  },
  toggle: () => {
    const next = !get().isOpen;
    set({ isOpen: next });
    writePersistedOpen(next);
  },
  send: (content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    const userMsg: AssistantMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
      createdAt: now
    };
    const kikiMsg: AssistantMessage = {
      id: `k-${Date.now() + 1}`,
      role: "kiki",
      content: mockKiKiReply(trimmed),
      createdAt: now
    };
    set({ messages: [...get().messages, userMsg, kikiMsg] });
  }
}));
