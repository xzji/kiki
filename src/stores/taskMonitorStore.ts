"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  TASK_MONITOR_DEFAULT_WIDTH,
  TASK_MONITOR_MAX_WIDTH,
  TASK_MONITOR_MIN_WIDTH,
} from "@/lib/taskPanelLayout";

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
  return Math.max(TASK_MONITOR_MIN_WIDTH, Math.min(TASK_MONITOR_MAX_WIDTH, Math.round(value)));
}

function normalizePersistedWidth(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return TASK_MONITOR_DEFAULT_WIDTH;
  if (value < TASK_MONITOR_MIN_WIDTH) return TASK_MONITOR_DEFAULT_WIDTH;
  return clampWidth(value);
}

export { TASK_MONITOR_MIN_WIDTH, TASK_MONITOR_MAX_WIDTH };

export const useTaskMonitorStore = create<TaskMonitorStore>()(
  persist(
    (set) => ({
      open: false,
      width: TASK_MONITOR_DEFAULT_WIDTH,
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
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<Pick<TaskMonitorStore, "width" | "collapsedSections">> | null;
        return {
          ...currentState,
          collapsedSections: persisted?.collapsedSections ?? currentState.collapsedSections,
          width: normalizePersistedWidth(persisted?.width),
        };
      },
    },
  ),
);
