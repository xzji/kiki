"use client";

import { create } from "zustand";

import type { InboxItem } from "@/types/kiki";

type InboxStore = {
  items: InboxItem[];
  historyItems: InboxItem[];
  markRead: (id: string) => void;
  markTaskRead: (taskId: string) => void;
  removeItem: (id: string) => void;
  archiveItem: (id: string) => void;
  addItem: (item: InboxItem) => void;
  upsertItem: (item: InboxItem) => void;
};

export const useInboxStore = create<InboxStore>((set) => ({
  items: [],
  historyItems: [],
  markRead: (id) => set((state) => ({ items: state.items.map((item) => (item.id === id ? { ...item, unreadCount: 0 } : item)) })),
  markTaskRead: (taskId) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.linkTo.match(/tasks\/([^?]+)/)?.[1] === taskId ? { ...item, unreadCount: 0 } : item,
      ),
    })),
  removeItem: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
  archiveItem: (id) =>
    set((state) => {
      const target = state.items.find((item) => item.id === id);
      return target ? { items: state.items.filter((item) => item.id !== id), historyItems: [{ ...target, unreadCount: 0 }, ...state.historyItems] } : state;
    }),
  addItem: (item) => set((state) => (state.items.some((current) => current.id === item.id) ? state : { items: [item, ...state.items] })),
  upsertItem: (item) =>
    set((state) => ({
      items: [item, ...state.items.filter((current) => current.id !== item.id)],
    })),
}));
