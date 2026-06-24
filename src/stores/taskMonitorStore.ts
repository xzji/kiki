"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 300;
const MAX_WIDTH = 420;

export type TaskMonitorSectionKey = "queued" | "running" | "paused" | "done";

type TaskMonitorStore = {
  open: boolean;
  width: number;
  collapsedSections: Partial<Record<TaskMonitorSectionKey, boolean>>;
  openMonitor: () => void;
  closeMonitor: () => void;
  setWidth: (value: number) => void;
  toggleSection: (key: TaskMonitorSectionKey) => void;
};

function clampWidth(value: number) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(value)));
}

export const TASK_MONITOR_MIN_WIDTH = MIN_WIDTH;
export const TASK_MONITOR_MAX_WIDTH = MAX_WIDTH;

export const useTaskMonitorStore = create<TaskMonitorStore>()(
  persist(
    (set) => ({
      open: false,
      width: DEFAULT_WIDTH,
      collapsedSections: {},
      openMonitor: () => set({ open: true }),
      closeMonitor: () => set({ open: false }),
      setWidth: (value) => set({ width: clampWidth(value) }),
      toggleSection: (key) =>
        set((state) => ({
          collapsedSections: {
            ...state.collapsedSections,
            [key]: !state.collapsedSections[key],
          },
        })),
    }),
    {
      name: "kiki.task-monitor",
      partialize: (state) => ({
        width: clampWidth(state.width),
        collapsedSections: state.collapsedSections,
      }),
    },
  ),
);
