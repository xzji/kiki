"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getGoalBreakdownDraft } from "@/mocks/goal-breakdown";
import { buildGoalFromDraft, createGeneratedInstance, initialGoals } from "@/mocks/goals";
import type { ExecutionPayload, Goal, GoalBreakdownDraft, GoalWorkflow, Task, TaskInstance } from "@/types/kiki";

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
  createGoalFromDraft: (draft: GoalBreakdownDraft, options?: { conversationId?: string }) => Goal;
  updateGoalWorkflow: (goalId: string, updates: Partial<GoalWorkflow>) => void;
  confirmGoalPlan: (goalId: string) => void;
  requestGoalPlanRevision: (goalId: string, feedback: string) => void;
  activateGoal: (goalId: string) => void;
  failGoalWorkflow: (goalId: string, error: string) => void;
  addSubGoal: (goalId: string, title: string) => void;
  addTask: (goalId: string, subGoalId: string, input: TaskCreateInput) => void;
};

function buildGoalIdFromTitle(goalTitle: string) {
  const slug = goalTitle
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `goal-${Date.now()}-${slug || "new"}`;
}

function nowIso() {
  return new Date().toISOString();
}

export const useGoalStore = create<GoalStore>()(
  persist(
    (set, get) => ({
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
            instances: values.payload
              ? task.instances.map((instance) => ({ ...instance, payload: values.payload! }))
              : task.instances,
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
            instances: task.instances.map((instance) =>
              instance.id === instanceId ? { ...instance, status } : instance,
            ),
          })),
        }));
      },
      controlTaskExecution: (taskId, action) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => {
            const sortedInstances = [...task.instances].sort(
              (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
            );
            const target = sortedInstances.find((instance) => instance.status !== "completed");

            if (!target) {
              const nextInstance = {
                ...createGeneratedInstance(task, nowIso()),
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
            instances: task.instances.map((instance) =>
              instance.id === instanceId ? { ...instance, status: "completed" } : instance,
            ),
          })),
        }));
      },
      generateInstance: (taskId, createdAt) => {
        const found = findTaskLocation(get().goals, taskId);
        if (!found) return null;
        const date = new Date(createdAt);
        const dateLabel = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(
          date.getDate(),
        ).padStart(2, "0")}`;
        if (found.task.instances.some((instance) => instance.dateLabel === dateLabel)) return null;
        const nextInstance = createGeneratedInstance(found.task, createdAt);
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => ({
            ...task,
            instances: [nextInstance, ...task.instances],
          })),
        }));
        return nextInstance;
      },
      createGoalFromInput: (title) => {
        const draft = getGoalBreakdownDraft(title);
        const nextGoal = buildGoalFromDraft(draft);
        set((state) => ({ goals: [...state.goals, nextGoal] }));
        return nextGoal;
      },
      createGoalFromDraft: (draft, options) => {
        const base = buildGoalFromDraft(draft);
        const goalId = buildGoalIdFromTitle(draft.goalTitle);
        const now = nowIso();
        const workflow: GoalWorkflow = {
          phase: "presenting_plan",
          planDecision: "pending",
          collectedInfo: {
            collectedInfoSummary: draft.collectedInfoSummary,
            goalAnalysis: draft.goalAnalysis,
            executionOrder: draft.executionOrder,
            reviewSummary: draft.reviewSummary,
          },
          assumptions: draft.assumptions,
          risks: draft.risks,
          reasoning: draft.reasoning,
          notificationStrategy: draft.notificationStrategy,
          startedAt: now,
          updatedAt: now,
        };
        const nextGoal: Goal = {
          ...base,
          id: goalId,
          title: draft.goalTitle,
          summary: draft.summary,
          deadline: draft.deadline || base.deadline,
          conversationId: options?.conversationId,
          workflow,
          subGoals: base.subGoals.map((sg) => ({
            ...sg,
            id: `${goalId}-${sg.id}`,
            goalId,
            tasks: sg.tasks.map((t) => ({
              ...t,
              id: `${goalId}-${t.id}`,
              subGoalId: `${goalId}-${t.subGoalId}`,
            })),
          })),
        };

        // Fix subGoalId on tasks after we namespaced ids.
        nextGoal.subGoals = nextGoal.subGoals.map((sg) => ({
          ...sg,
          tasks: sg.tasks.map((t) => ({
            ...t,
            subGoalId: sg.id,
          })),
        }));

        // Map optional meta fields from draft tasks into tasks (by title match within same subgoal index).
        nextGoal.subGoals = nextGoal.subGoals.map((sg, sgIndex) => {
          const draftSubGoal = draft.subGoals[sgIndex];
          return {
            ...sg,
            title: draftSubGoal?.title ?? sg.title,
            tasks: sg.tasks.map((t, tIndex) => {
              const draftTask = draftSubGoal?.tasks?.[tIndex];
              return draftTask
                ? {
                    ...t,
                    priority: draftTask.priority,
                    dependencies: draftTask.dependencies,
                    executionMode: draftTask.executionMode,
                    executionCycle: draftTask.executionCycle,
                    expectedResult: draftTask.expectedResult,
                  }
                : t;
            }),
          };
        });

        set((state) => ({ goals: [...state.goals, nextGoal] }));
        return nextGoal;
      },
      updateGoalWorkflow: (goalId, updates) => {
        set((state) => ({
          goals: state.goals.map((goal) => {
            if (goal.id !== goalId) return goal;
            const prev = goal.workflow;
            const next: GoalWorkflow = {
              phase: prev?.phase ?? "idle",
              planDecision: prev?.planDecision ?? "pending",
              startedAt: prev?.startedAt ?? nowIso(),
              updatedAt: nowIso(),
              ...prev,
              ...updates,
            };
            return { ...goal, workflow: next };
          }),
        }));
      },
      confirmGoalPlan: (goalId) => {
        const now = nowIso();
        set((state) => ({
          goals: state.goals.map((goal) => {
            if (goal.id !== goalId) return goal;
            const prev = goal.workflow;
            const next: GoalWorkflow = {
              ...prev,
              phase: "monitoring",
              planDecision: "confirmed",
              startedAt: prev?.startedAt ?? now,
              updatedAt: now,
              confirmedAt: now,
            };
            return { ...goal, workflow: next };
          }),
        }));
      },
      requestGoalPlanRevision: (goalId, feedback) => {
        set((state) => ({
          goals: state.goals.map((goal) => {
            if (goal.id !== goalId) return goal;
            const prev = goal.workflow;
            const next: GoalWorkflow = {
              ...prev,
              phase: "decomposing",
              planDecision: "revision_requested",
              startedAt: prev?.startedAt ?? nowIso(),
              updatedAt: nowIso(),
              collectedInfo: {
                ...(prev?.collectedInfo ?? {}),
                revisionFeedback: feedback,
              },
            };
            return { ...goal, workflow: next };
          }),
        }));
      },
      activateGoal: (goalId) => {
        set((state) => ({
          goals: state.goals.map((goal) => {
            if (goal.id !== goalId) return goal;
            const prev = goal.workflow;
            return {
              ...goal,
              workflow: {
                ...prev,
                phase: "monitoring",
                planDecision: prev?.planDecision ?? "confirmed",
                startedAt: prev?.startedAt ?? nowIso(),
                updatedAt: nowIso(),
              },
            };
          }),
        }));
      },
      failGoalWorkflow: (goalId, error) => {
        set((state) => ({
          goals: state.goals.map((goal) => {
            if (goal.id !== goalId) return goal;
            const prev = goal.workflow;
            return {
              ...goal,
              workflow: {
                ...prev,
                phase: "error",
                planDecision: prev?.planDecision ?? "pending",
                startedAt: prev?.startedAt ?? nowIso(),
                updatedAt: nowIso(),
                error,
              },
            };
          }),
        }));
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
    }),
    {
      name: "kiki.goals",
      partialize: (state) => ({ goals: state.goals }),
    },
  ),
);

export function getGoalById(goalId: string) {
  return useGoalStore.getState().goals.find((goal) => goal.id === goalId);
}

export function getTaskById(taskId: string) {
  return findTaskLocation(useGoalStore.getState().goals, taskId);
}
