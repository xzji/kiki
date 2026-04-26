"use client";

import { create } from "zustand";

import { getGoalBreakdownDraft } from "@/mocks/goal-breakdown";
import { buildGoalFromDraft, createGeneratedInstance, initialGoals } from "@/mocks/goals";
import type { ExecutionPayload, Goal, Task, TaskInstance } from "@/types/dora";

function updateTaskInGoals(goals: Goal[], taskId: string, updater: (task: Task, goal: Goal) => Task): Goal[] {
  return goals.map((goal) => ({
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      tasks: subGoal.tasks.map((task) => (task.id === taskId ? updater(task, goal) : task)),
    })),
  }));
}

function findTaskLocation(goals: Goal[], taskId: string) {
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        if (task.id === taskId) return { goal, subGoal, task };
      }
    }
  }
  return null;
}

type TaskEditInput = {
  title: string;
  description: string;
  expectedOutcome: string;
  taskType: Task["taskType"];
  triggerRule: string;
  deadline?: string;
  executionKind: Task["executionKind"];
  payload?: ExecutionPayload;
};

type GoalStore = {
  goals: Goal[];
  updateTask: (taskId: string, values: TaskEditInput) => void;
  markInstanceStatus: (taskId: string, instanceId: string, status: TaskInstance["status"]) => void;
  completeTaskInstance: (taskId: string, instanceId: string) => void;
  generateInstance: (taskId: string, createdAt: string) => TaskInstance | null;
  createGoalFromInput: (title: string) => Goal;
};

export const useGoalStore = create<GoalStore>((set, get) => ({
  goals: initialGoals,
  updateTask: (taskId, values) => {
    set((state) => ({
      goals: updateTaskInGoals(state.goals, taskId, (task) => ({
        ...task,
        title: values.title,
        description: values.description,
        expectedOutcome: values.expectedOutcome,
        taskType: values.taskType,
        triggerRule: values.triggerRule,
        deadline: values.deadline,
        executionKind: values.executionKind,
        instances: values.payload ? task.instances.map((instance) => ({ ...instance, payload: values.payload! })) : task.instances,
      })),
    }));
  },
  markInstanceStatus: (taskId, instanceId, status) => {
    set((state) => ({
      goals: updateTaskInGoals(state.goals, taskId, (task) => ({
        ...task,
        instances: task.instances.map((instance) => (instance.id === instanceId ? { ...instance, status } : instance)),
      })),
    }));
  },
  completeTaskInstance: (taskId, instanceId) => {
    set((state) => ({
      goals: updateTaskInGoals(state.goals, taskId, (task) => ({
        ...task,
        progress: Math.min(100, task.progress + (task.executionKind === "flashcard" ? 8 : 5)),
        instances: task.instances.map((instance) => (instance.id === instanceId ? { ...instance, status: "completed" } : instance)),
      })),
    }));
  },
  generateInstance: (taskId, createdAt) => {
    const found = findTaskLocation(get().goals, taskId);
    if (!found) return null;
    const date = new Date(createdAt);
    const dateLabel = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (found.task.instances.some((instance) => instance.dateLabel === dateLabel)) return null;
    const nextInstance = createGeneratedInstance(found.task, createdAt);
    set((state) => ({
      goals: updateTaskInGoals(state.goals, taskId, (task) => ({ ...task, instances: [nextInstance, ...task.instances] })),
    }));
    return nextInstance;
  },
  createGoalFromInput: (title) => {
    const draft = getGoalBreakdownDraft(title);
    const nextGoal = buildGoalFromDraft(draft);
    set((state) => ({ goals: [...state.goals, nextGoal] }));
    return nextGoal;
  },
}));

export function getGoalById(goalId: string) {
  return useGoalStore.getState().goals.find((goal) => goal.id === goalId);
}

export function getTaskById(taskId: string) {
  return findTaskLocation(useGoalStore.getState().goals, taskId);
}
