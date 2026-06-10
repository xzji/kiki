"use client";

import { create } from "zustand";

type ConversationProcessSidebarState = {
  hydrated: boolean;
  isOpen: boolean;
  hydrate: () => void;
  open: () => void;
  close: () => void;
  toggle: () => void;
};

const STORAGE_KEY = "kiki.conversationProcessSidebar.isOpen";

function readPersistedOpen() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
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

export const useConversationProcessSidebarStore = create<ConversationProcessSidebarState>((set, get) => ({
  hydrated: false,
  isOpen: false,
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
}));
