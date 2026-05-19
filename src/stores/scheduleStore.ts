"use client";

import { create } from "zustand";

import type { AgentEvent, ScheduleViewMode } from "@/types/schedule";

const STORAGE_KEY = "kiki.schedule.events";
const RESET_VERSION_KEY = "kiki.schedule.events.reset-version";
const MOCK_BASELINE_RESET_VERSION = "3";
const MOCK_EVENT_TITLES = new Set([
  "托福考试 110 分 · 学习冲刺日",
  "大阪 6 日游 · 行前准备",
  "专注学习时段",
  "听力练习反馈会",
  "教练 1v1",
  "单词背诵复盘",
  "AI 产品经理面试准备",
  "KiKi 建议的深度思考时段",
]);

function removeMockEvents(events: AgentEvent[]) {
  return events.filter((event) => !MOCK_EVENT_TITLES.has(event.title));
}

function loadEvents(): AgentEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const resetVersion = window.localStorage.getItem(RESET_VERSION_KEY);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      window.localStorage.setItem(RESET_VERSION_KEY, MOCK_BASELINE_RESET_VERSION);
      return [];
    }
    const parsed = JSON.parse(raw) as AgentEvent[];
    if (!Array.isArray(parsed)) return [];
    const events = resetVersion === MOCK_BASELINE_RESET_VERSION ? parsed : removeMockEvents(parsed);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    window.localStorage.setItem(RESET_VERSION_KEY, MOCK_BASELINE_RESET_VERSION);
    return events;
  } catch {
    return [];
  }
}

function persistEvents(events: AgentEvent[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    window.localStorage.setItem(RESET_VERSION_KEY, MOCK_BASELINE_RESET_VERSION);
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
  replaceEvents: (events: AgentEvent[]) => void;
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
  events: [],
  viewMode: "week",
  focusDate: new Date().toISOString(),
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
  toggleAllDay: () => set((state) => ({ allDayCollapsed: !state.allDayCollapsed })),
  replaceEvents: (events) => {
    persistEvents(events);
    set({ events });
  },
}));
