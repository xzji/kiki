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

type TaskCreateInput = Omit<TaskEditInput, "payload">;

type GoalStore = {
  goals: Goal[];
  updateTask: (taskId: string, values: TaskEditInput) => void;
  deleteTask: (taskId: string) => void;
  markInstanceStatus: (taskId: string, instanceId: string, status: TaskInstance["status"]) => void;
  controlTaskExecution: (taskId: string, action: "start" | "pause" | "resume") => void;
  completeTaskInstance: (taskId: string, instanceId: string) => void;
  generateInstance: (taskId: string, createdAt: string) => TaskInstance | null;
  createGoalFromInput: (title: string) => Goal;
  addSubGoal: (goalId: string, title: string) => void;
  addTask: (goalId: string, subGoalId: string, input: TaskCreateInput) => void;
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
  deleteTask: (taskId) => {
    set((state) => ({
      goals: state.goals.map((goal) => ({
        ...goal,
        subGoals: goal.subGoals.map((subGoal) => ({
          ...subGoal,
          tasks: subGoal.tasks.filter((task) => task.id !== taskId),
        })),
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
  controlTaskExecution: (taskId, action) => {
    set((state) => ({
      goals: updateTaskInGoals(state.goals, taskId, (task) => {
        const sortedInstances = [...task.instances].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
        const target = sortedInstances.find((instance) => instance.status !== "completed");

        if (!target) {
          const nextInstance = {
            ...createGeneratedInstance(task, new Date().toISOString()),
            status: action === "pause" ? ("paused" as const) : ("in_progress" as const),
          };
          return { ...task, instances: [nextInstance, ...task.instances] };
        }

        const nextStatus =
          action === "start" || action === "resume"
            ? "in_progress"
            : action === "pause"
              ? "paused"
              : target.status;

        return {
          ...task,
          instances: task.instances.map((instance) =>
            instance.id === target.id ? { ...instance, status: nextStatus } : instance,
          ),
        };
      }),
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
  addSubGoal: (goalId, title) => {
    set((state) => ({
      goals: state.goals.map((goal) => {
        if (goal.id !== goalId) return goal;
        const nextIndex = goal.subGoals.length + 1;
        const newSubGoal = {
          id: `${goalId}-sg-custom-${Date.now()}`,
          goalId,
          title: title.startsWith("子目标") ? title : `子目标${nextIndex}：${title}`,
          tasks: [],
        };
        return { ...goal, subGoals: [...goal.subGoals, newSubGoal] };
      }),
    }));
  },
  addTask: (goalId, subGoalId, input) => {
    set((state) => ({
      goals: state.goals.map((goal) => {
        if (goal.id !== goalId) return goal;
        return {
          ...goal,
          subGoals: goal.subGoals.map((subGoal) => {
            if (subGoal.id !== subGoalId) return subGoal;
            const nextIndex = subGoal.tasks.length + 1;
            const newTask: Task = {
              id: `${subGoalId}-task-custom-${Date.now()}`,
              subGoalId,
              title: input.title.startsWith("任务") ? input.title : `任务${nextIndex}：${input.title}`,
              description: input.description,
              expectedOutcome: input.expectedOutcome,
              taskType: input.taskType,
              triggerRule: input.triggerRule,
              deadline: input.deadline,
              progress: 0,
              instances: [],
              executionKind: input.executionKind,
            };
            return { ...subGoal, tasks: [...subGoal.tasks, newTask] };
          }),
        };
      }),
    }));
  },
}));

export function getGoalById(goalId: string) {
  return useGoalStore.getState().goals.find((goal) => goal.id === goalId);
}

export function getTaskById(taskId: string) {
  return findTaskLocation(useGoalStore.getState().goals, taskId);
}
