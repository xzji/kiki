"use client";

import { create } from "zustand";

type TaskDrawerStore = {
  activeGoalId: string | null;
  activeTaskId: string | null;
  activeInstanceId: string | null;
  open: (goalId: string, taskId: string, instanceId?: string | null) => void;
  close: () => void;
};

export const useTaskDrawerStore = create<TaskDrawerStore>((set) => ({
  activeGoalId: null,
  activeTaskId: null,
  activeInstanceId: null,
  open: (goalId, taskId, instanceId) =>
    set({ activeGoalId: goalId, activeTaskId: taskId, activeInstanceId: instanceId ?? null }),
  close: () => set({ activeGoalId: null, activeTaskId: null, activeInstanceId: null }),
}));
