"use client";

import { create } from "zustand";

import { fetchRuntimeStateSnapshot, isRuntimeStateUnchangedPayload } from "@/lib/api/runtime-daemon";
import type { AgentEvent, ScheduleViewMode } from "@/types/schedule";

type ScheduleStore = {
  hydrated: boolean;
  events: AgentEvent[];
  projectionRevision: number;
  viewMode: ScheduleViewMode;
  focusDate: string;
  allDayCollapsed: boolean;
  hydrate: () => Promise<void>;
  setViewMode: (mode: ScheduleViewMode) => void;
  setFocusDate: (date: string) => void;
  goToToday: (today: string) => void;
  prev: () => void;
  next: () => void;
  addEvent: (event: AgentEvent) => void;
  updateEvent: (event: AgentEvent) => void;
  deleteEvent: (id: string) => void;
  toggleAllDay: () => void;
  replaceEvents: (events: AgentEvent[], revision?: number) => void;
};

let hydrateRetryTimer: number | null = null;

function stepDate(iso: string, direction: -1 | 1, mode: ScheduleViewMode): string {
  const date = new Date(iso);
  if (mode === "day") {
    date.setDate(date.getDate() + direction);
  } else if (mode === "week") {
    date.setDate(date.getDate() + direction * 7);
  } else {
    date.setMonth(date.getMonth() + direction);
  }
  return date.toISOString();
}

export const useScheduleStore = create<ScheduleStore>((set, get) => ({
  hydrated: false,
  events: [],
  projectionRevision: 0,
  viewMode: "week",
  focusDate: new Date().toISOString(),
  allDayCollapsed: false,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const snapshot = await fetchRuntimeStateSnapshot();
      if (isRuntimeStateUnchangedPayload(snapshot)) return;
      const revision = snapshot.meta?.revisions?.scheduleEvents;
      get().replaceEvents(snapshot.scheduleEvents, revision);
      set({ hydrated: true });
    } catch {
      if (!hydrateRetryTimer && typeof window !== "undefined") {
        hydrateRetryTimer = window.setTimeout(() => {
          hydrateRetryTimer = null;
          if (!get().hydrated) void get().hydrate();
        }, 5000);
      }
    }
  },
  setViewMode: (mode) => set({ viewMode: mode }),
  setFocusDate: (date) => set({ focusDate: date }),
  goToToday: (today) => set({ focusDate: today }),
  prev: () => {
    const { focusDate, viewMode } = get();
    set({ focusDate: stepDate(focusDate, -1, viewMode) });
  },
  next: () => {
    const { focusDate, viewMode } = get();
    set({ focusDate: stepDate(focusDate, 1, viewMode) });
  },
  // PROJECTION-ONLY: 服务端命令式 API 是权威，本 mutator 只用于乐观本地反馈。
  addEvent: (event) =>
    set((state) => {
      const events = [...state.events, event];
      return { events };
    }),
  // PROJECTION-ONLY: 服务端命令式 API 是权威，本 mutator 只用于乐观本地反馈。
  updateEvent: (event) =>
    set((state) => {
      const events = state.events.map((item) => (item.id === event.id ? event : item));
      return { events };
    }),
  // PROJECTION-ONLY: 服务端命令式 API 是权威，本 mutator 只用于乐观本地反馈。
  deleteEvent: (id) =>
    set((state) => {
      const events = state.events.filter((item) => item.id !== id);
      return { events };
    }),
  toggleAllDay: () => set((state) => ({ allDayCollapsed: !state.allDayCollapsed })),
  replaceEvents: (events, revision) => {
    set((state) => {
      if (typeof revision === "number" && revision < state.projectionRevision) return state;
      return {
        events,
        ...(typeof revision === "number" ? { projectionRevision: revision } : {}),
      };
    });
  },
}));
