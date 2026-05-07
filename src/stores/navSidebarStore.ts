"use client";

import { create } from "zustand";

type NavSidebarStore = {
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
  toggle: () => void;
};

export const useNavSidebarStore = create<NavSidebarStore>((set) => ({
  collapsed: false,
  setCollapsed: (value) => set({ collapsed: value }),
  toggle: () => set((state) => ({ collapsed: !state.collapsed })),
}));
