"use client";

import { create } from "zustand";

import { initialScheduleEvents } from "@/mocks/schedule";
import type { AgentEvent, ScheduleViewMode } from "@/types/schedule";

const STORAGE_KEY = "kiki.schedule.events";

function loadEvents(): AgentEvent[] {
  if (typeof window === "undefined") return initialScheduleEvents;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialScheduleEvents;
    const parsed = JSON.parse(raw) as AgentEvent[];
    if (!Array.isArray(parsed)) return initialScheduleEvents;
    return parsed;
  } catch {
    return initialScheduleEvents;
  }
}

function persistEvents(events: AgentEvent[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // ignore
  }
}

type ScheduleStore = {
  hydrated: boolean;
  events: AgentEvent[];
  viewMode: ScheduleViewMode;
  focusDate: string;
  allDayCollapsed: boolean;
  hydrate: () => void;
  setViewMode: (mode: ScheduleViewMode) => void;
  setFocusDate: (date: string) => void;
  goToToday: (today: string) => void;
  prev: () => void;
  next: () => void;
  addEvent: (event: AgentEvent) => void;
  updateEvent: (event: AgentEvent) => void;
  deleteEvent: (id: string) => void;
  toggleAllDay: () => void;
};

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
  events: initialScheduleEvents,
  viewMode: "week",
  focusDate: new Date("2026-04-26T10:00:00+08:00").toISOString(),
  allDayCollapsed: false,
  hydrate: () =>
    set(() => {
      const events = loadEvents();
      return { events, hydrated: true };
    }),
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
  addEvent: (event) =>
    set((state) => {
      const events = [...state.events, event];
      persistEvents(events);
      return { events };
    }),
  updateEvent: (event) =>
    set((state) => {
      const events = state.events.map((item) => (item.id === event.id ? event : item));
      persistEvents(events);
      return { events };
    }),
  deleteEvent: (id) =>
    set((state) => {
      const events = state.events.filter((item) => item.id !== id);
      persistEvents(events);
      return { events };
    }),
  toggleAllDay: () => set((state) => ({ allDayCollapsed: !state.allDayCollapsed }))
}));
