"use client";

import { create } from "zustand";

type TaskDrawerStore = {
  activeGoalId: string | null;
  activeTaskId: string | null;
  open: (goalId: string, taskId: string) => void;
  close: () => void;
};

export const useTaskDrawerStore = create<TaskDrawerStore>((set) => ({
  activeGoalId: null,
  activeTaskId: null,
  open: (goalId, taskId) => set({ activeGoalId: goalId, activeTaskId: taskId }),
  close: () => set({ activeGoalId: null, activeTaskId: null }),
}));
