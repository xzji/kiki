"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getGoalBreakdownDraft } from "@/mocks/goal-breakdown";
import { buildGoalFromDraft, createGeneratedInstance, initialGoals } from "@/mocks/goals";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type {
  ExecutionPayload,
  Goal,
  GoalBreakdownDraft,
  GoalWorkflow,
  Task,
  TaskExecutionStep,
  TaskInstance,
  TaskInstanceNotificationState,
  TaskResultNotificationDecision,
  TaskRunArtifact,
  TaskRunErrorCategory,
  TaskResultViewKind,
} from "@/types/kiki";

const MOCK_BASELINE_RESET_VERSION = 1;

function finalizeGoal(goal: Goal): Goal {
  const tasks = goal.subGoals.flatMap((subGoal) => subGoal.tasks);
  const progress =
    tasks.length === 0
      ? goal.progress
      : Math.round(tasks.reduce((total, task) => total + task.progress, 0) / tasks.length);

  const onlyOneShotTasks = tasks.length > 0 && tasks.every((task) => task.taskType === "one_shot");
  const allTasksCompleted = tasks.length > 0 && tasks.every((task) => task.progress >= 100);
  const workflow =
    goal.workflow && onlyOneShotTasks && allTasksCompleted && goal.workflow.phase !== "completed"
      ? {
          ...goal.workflow,
          phase: "completed" as const,
          updatedAt: nowIso(),
        }
      : goal.workflow;

  return {
    ...goal,
    progress,
    workflow,
  };
}

function updateTaskInGoals(goals: Goal[], taskId: string, updater: (task: Task, goal: Goal) => Task): Goal[] {
  return goals.map((goal) =>
    finalizeGoal({
      ...goal,
      subGoals: goal.subGoals.map((subGoal) => ({
        ...subGoal,
        tasks: subGoal.tasks.map((task) => (task.id === taskId ? updater(task, goal) : task)),
      })),
    }),
  );
}

function defaultResultViewKind(task: Task) {
  return task.resultViewKind ?? task.executionKind ?? "generic_result";
}

function normalizeTask(task: Task): Task {
  return {
    ...task,
    resultViewKind: task.resultViewKind ?? task.executionKind ?? "generic_result",
    executionStrategy: task.executionStrategy ?? "agent_autonomous",
    executionObjective: task.executionObjective ?? task.description,
    instances: task.instances.map((instance) => normalizeInstance(instance, task)),
  };
}

function normalizeTimelineFromLogs(logs: GoalServerLogEntry[] | undefined): TaskExecutionStep[] | undefined {
  if (!logs?.length) return undefined;
  return logs
    .slice()
    .reverse()
    .map((log, index) => ({
      id: log.id || `timeline-${index + 1}`,
      title: log.toolName ? `${log.message} (${log.toolName})` : log.message,
      type:
        log.eventType === "tool_call_started" || log.eventType === "tool_call_finished"
          ? "tool"
          : log.eventType === "assistant_output"
            ? "assistant"
            : log.eventType === "retry_scheduled"
              ? "retry"
              : log.eventType === "result_ready"
                ? "result"
                : "phase",
      status: log.status ?? (log.level === "error" ? "failed" : "completed"),
      detail: log.details,
      toolName: log.toolName,
      startedAt: log.timestamp,
      finishedAt: log.status === "running" ? undefined : log.timestamp,
    }));
}

function mergeTimelineSteps(
  current: TaskExecutionStep[] | undefined,
  incoming: TaskExecutionStep[] | undefined,
): TaskExecutionStep[] | undefined {
  if (!incoming?.length) return current;
  const byId = new Map<string, TaskExecutionStep>();
  for (const step of current ?? []) {
    byId.set(step.id, step);
  }
  for (const step of incoming) {
    byId.set(step.id, {
      ...byId.get(step.id),
      ...step,
    });
  }
  return Array.from(byId.values()).sort((left, right) => +new Date(left.startedAt) - +new Date(right.startedAt));
}

function isNotificationDecision(value: unknown): value is TaskResultNotificationDecision {
  return Boolean(
    value &&
      typeof value === "object" &&
      "shouldNotify" in value &&
      "channel" in value &&
      "notificationType" in value &&
      "resultSummary" in value,
  );
}

function normalizeNotificationFromProgress(
  progress: GoalServerProgress | null,
  instance: TaskInstance,
): TaskInstanceNotificationState | undefined {
  const rawDecision = progress?.resultPayload?.notificationDecision;
  if (!isNotificationDecision(rawDecision)) return instance.notification;
  const deliveryState =
    instance.notification?.deliveryState === "delivered"
      ? "delivered"
      : rawDecision.shouldNotify
        ? "pending"
        : "silent";
  return {
    ...rawDecision,
    deliveryState,
    deliveredAt: instance.notification?.deliveredAt,
    inboxItemId: instance.notification?.inboxItemId,
    conversationMessageId: instance.notification?.conversationMessageId,
  };
}

function normalizeInstance(instance: TaskInstance, task: Task): TaskInstance {
  const status = instance.execution?.status ?? instance.status;
  const phase =
    instance.execution?.phase ??
    (status === "completed"
      ? "completed"
      : status === "awaiting_user"
        ? "awaiting_user"
        : status === "in_progress"
          ? "running"
          : status === "error"
            ? "failed"
            : status === "paused"
              ? "failed"
              : "queued");
  return {
    ...instance,
    payload:
      instance.payload ??
      ({
        kind: defaultResultViewKind(task),
        summary: instance.intro,
      } as ExecutionPayload),
    runner: {
      attemptCount: instance.runner?.attemptCount ?? 0,
      ...instance.runner,
    },
    execution: {
      phase,
      status,
      lastUpdatedAt: instance.execution?.lastUpdatedAt ?? instance.createdAt,
      ...instance.execution,
    },
    timeline:
      instance.timeline ??
      [
        {
          id: `${instance.id}-queued`,
          title: "任务已创建",
          type: "phase",
          status: status === "pending" ? "running" : "completed",
          detail: instance.intro,
          startedAt: instance.createdAt,
          finishedAt: status === "pending" ? undefined : instance.createdAt,
        },
      ],
  };
}

function normalizeGoal(goal: Goal): Goal {
  return finalizeGoal({
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      tasks: subGoal.tasks.map((task) => normalizeTask(task)),
    })),
  });
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
  replaceGoals: (goals: Goal[]) => void;
  deleteTask: (taskId: string) => void;
  markInstanceStatus: (taskId: string, instanceId: string, status: TaskInstance["status"]) => void;
  controlTaskExecution: (taskId: string, action: "start" | "pause" | "resume") => void;
  completeTaskInstance: (taskId: string, instanceId: string) => void;
  generateInstance: (taskId: string, createdAt: string) => TaskInstance | null;
  createGoalFromInput: (title: string) => Goal;
  createGoalFromDraft: (draft: GoalBreakdownDraft, options?: { conversationId?: string }) => Goal;
  deleteGoalsByConversationId: (conversationId: string) => void;
  updateGoalWorkflow: (goalId: string, updates: Partial<GoalWorkflow>) => void;
  confirmGoalPlan: (goalId: string) => void;
  requestGoalPlanRevision: (goalId: string, feedback: string) => void;
  activateGoal: (goalId: string) => void;
  failGoalWorkflow: (goalId: string, error: string) => void;
  startTaskInstanceRun: (input: {
    taskId: string;
    instanceId: string;
    requestId: string;
    runtimeEnvId?: string;
    permissionMode?: "readonly" | "confirm" | "execute";
    workingDirectory?: string;
  }) => void;
  syncTaskInstanceRun: (input: {
    taskId: string;
    instanceId: string;
    progress: GoalServerProgress | null;
    logs?: GoalServerLogEntry[];
  }) => void;
  retryTaskInstanceRun: (taskId: string, instanceId: string) => void;
  stopTaskInstanceRun: (taskId: string, instanceId: string) => void;
  markTaskNotificationDelivered: (input: {
    taskId: string;
    instanceId: string;
    inboxItemId?: string;
    conversationMessageId?: string;
  }) => void;
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

function namespaceDependencyIds(
  dependencies: string[] | undefined,
  taskIdMap: Map<string, string>,
  goalId: string,
) {
  if (!dependencies?.length) return dependencies;
  return dependencies.map((dependencyId) => {
    const trimmed = dependencyId.trim();
    if (!trimmed) return trimmed;
    if (taskIdMap.has(trimmed)) return taskIdMap.get(trimmed)!;
    if (trimmed.startsWith(`${goalId}-`)) return trimmed;
    return taskIdMap.get(trimmed.replace(/^.*?task-/, "task-")) ?? trimmed;
  });
}

export const useGoalStore = create<GoalStore>()(
  persist(
    (set, get) => ({
      goals: initialGoals.map((goal) => normalizeGoal(goal)),
      replaceGoals: (goals) => {
        set({
          goals: goals.map((goal) => normalizeGoal(goal)),
        });
      },
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
            resultViewKind: task.resultViewKind ?? values.executionKind,
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
              instance.id === instanceId
                ? normalizeInstance(
                    {
                      ...instance,
                      status,
                      execution: {
                        phase:
                          status === "completed"
                            ? "completed"
                            : status === "awaiting_user"
                              ? "awaiting_user"
                              : status === "in_progress"
                                ? "running"
                                : status === "error"
                                  ? "failed"
                                  : status === "paused"
                                    ? "failed"
                                    : "queued",
                        status,
                        startedAt: instance.execution?.startedAt ?? instance.createdAt,
                        finishedAt: status === "completed" ? nowIso() : undefined,
                        lastUpdatedAt: nowIso(),
                        errorCategory: status === "error" ? "unknown" : instance.execution?.errorCategory,
                        errorMessage: status === "error" ? "任务执行失败" : instance.execution?.errorMessage,
                      },
                    },
                    task,
                  )
                : instance,
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
              return { ...task, instances: [normalizeInstance(nextInstance, task), ...task.instances] };
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
                instance.id === target.id
                  ? normalizeInstance(
                      {
                        ...instance,
                        status: nextStatus,
                        execution: {
                          phase: nextStatus === "paused" ? "failed" : "running",
                          status: nextStatus,
                          startedAt: instance.execution?.startedAt ?? nowIso(),
                          lastUpdatedAt: nowIso(),
                        },
                      },
                      task,
                    )
                  : instance,
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
              instance.id === instanceId
                ? normalizeInstance(
                    {
                      ...instance,
                      status: "completed",
                      execution: {
                        phase: "completed",
                        status: "completed",
                        startedAt: instance.execution?.startedAt ?? instance.createdAt,
                        finishedAt: nowIso(),
                        lastUpdatedAt: nowIso(),
                      },
                    },
                    task,
                  )
                : instance,
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
            instances: [normalizeInstance(nextInstance, task), ...task.instances],
          })),
        }));
        return nextInstance;
      },
      createGoalFromInput: (title) => {
        const draft = getGoalBreakdownDraft(title);
        const nextGoal = buildGoalFromDraft(draft);
        const normalized = normalizeGoal(nextGoal);
        set((state) => ({ goals: [...state.goals, normalized] }));
        return normalized;
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

        const taskIdMap = new Map<string, string>();
        draft.subGoals.forEach((draftSubGoal, sgIndex) => {
          const nextSubGoal = nextGoal.subGoals[sgIndex];
          draftSubGoal.tasks.forEach((draftTask, taskIndex) => {
            const nextTask = nextSubGoal?.tasks[taskIndex];
            if (nextTask) {
              taskIdMap.set(draftTask.id, nextTask.id);
            }
          });
        });

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
                    dependencies: namespaceDependencyIds(draftTask.dependencies, taskIdMap, goalId),
                    executionMode: draftTask.executionMode,
                    executionCycle: draftTask.executionCycle,
                    expectedResult: draftTask.expectedResult,
                    resultViewKind: draftTask.resultViewKind ?? draftTask.executionKind,
                    executionStrategy: draftTask.executionStrategy ?? "agent_autonomous",
                    executionObjective: draftTask.executionObjective ?? draftTask.description,
                    recommendedWorkingDirectory: draftTask.recommendedWorkingDirectory,
                    autoRunDisabled: draftTask.autoRunDisabled,
                    requiresConfirmation: draftTask.requiresConfirmation,
                  }
                : t;
            }),
          };
        });

        const finalizedGoal = finalizeGoal(nextGoal);
        set((state) => ({ goals: [...state.goals, finalizedGoal] }));
        return finalizedGoal;
      },
      deleteGoalsByConversationId: (conversationId) => {
        set((state) => ({
          goals: state.goals.filter((goal) => goal.conversationId !== conversationId),
        }));
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
              phase: "executing",
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
      startTaskInstanceRun: ({ taskId, instanceId, requestId, runtimeEnvId, permissionMode, workingDirectory }) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => ({
            ...task,
            instances: task.instances.map((instance) =>
              instance.id === instanceId
                ? normalizeInstance(
                    {
                      ...instance,
                      status: "in_progress",
                      runner: {
                        requestId,
                        runtimeEnvId,
                        permissionMode,
                        workingDirectory,
                        attemptCount: (instance.runner?.attemptCount ?? 0) + 1,
                        lastAttemptAt: nowIso(),
                      },
                      execution: {
                        phase: "running",
                        status: "in_progress",
                        startedAt: instance.execution?.startedAt ?? nowIso(),
                        lastUpdatedAt: nowIso(),
                      },
                    },
                    task,
                  )
                : instance,
            ),
          })),
        }));
      },
      syncTaskInstanceRun: ({ taskId, instanceId, progress, logs }) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => {
            const timeline = normalizeTimelineFromLogs(logs);
            return {
              ...task,
              progress:
                progress?.status === "completed"
                  ? Math.min(100, Math.max(task.progress, task.progress + (defaultResultViewKind(task) === "flashcard" ? 8 : 5)))
                  : task.progress,
              instances: task.instances.map((instance) => {
                if (instance.id !== instanceId) return instance;
                const nextStatus =
                  progress?.status === "completed"
                    ? progress.resultPayload?.awaitingUser
                      ? "awaiting_user"
                      : "completed"
                    : progress?.status === "failed"
                      ? "error"
                      : "in_progress";
                const nextKind = (progress?.resultPayload?.resultViewKind as TaskResultViewKind | undefined) ?? defaultResultViewKind(task);
                const artifacts = Array.isArray(progress?.resultPayload?.artifacts)
                  ? (progress.resultPayload.artifacts as TaskRunArtifact[])
                  : undefined;
                return normalizeInstance(
                  {
                    ...instance,
                    status: nextStatus,
                    payload:
                      nextKind === "generic_result"
                        ? {
                            kind: "generic_result",
                            summary: progress?.summary || instance.result?.summary || instance.intro,
                            details: typeof progress?.resultPayload?.finalMessage === "string" ? progress.resultPayload.finalMessage : undefined,
                            artifacts:
                              artifacts ??
                              (instance.payload.kind === "generic_result" ? instance.payload.artifacts : undefined),
                          }
                        : instance.payload,
                    execution: {
                      phase:
                        nextStatus === "completed"
                          ? "completed"
                          : nextStatus === "awaiting_user"
                            ? "awaiting_user"
                            : nextStatus === "error"
                              ? "failed"
                              : "running",
                      status: nextStatus,
                      startedAt: instance.execution?.startedAt ?? progress?.startedAt ?? instance.createdAt,
                      finishedAt: progress?.finishedAt,
                      lastUpdatedAt: progress?.updatedAt ?? nowIso(),
                      errorCategory:
                        nextStatus === "error"
                          ? ((progress?.resultPayload?.errorCategory as TaskRunErrorCategory | undefined) ?? "unknown")
                          : undefined,
                      errorMessage: nextStatus === "error" ? progress?.error : undefined,
                    },
                    result: progress
                      ? {
                          summary: progress.summary || instance.result?.summary,
                          finalMessage:
                            typeof progress.resultPayload?.finalMessage === "string"
                              ? progress.resultPayload.finalMessage
                              : instance.result?.finalMessage,
                          structuredOutput:
                            (progress.resultPayload?.structuredOutput as Record<string, unknown> | null | undefined) ??
                            instance.result?.structuredOutput ??
                            null,
                          artifacts: artifacts ?? instance.result?.artifacts,
                        }
                      : instance.result,
                    awaitingUser:
                      progress?.resultPayload?.awaitingUser
                        ? {
                            reason:
                              (progress.resultPayload?.awaitingReason as string | undefined) || "任务需要你确认下一步。",
                            suggestedActions: Array.isArray(progress.resultPayload?.suggestedActions)
                              ? (progress.resultPayload.suggestedActions as string[])
                              : undefined,
                          }
                        : undefined,
                    notification: normalizeNotificationFromProgress(progress, instance),
                    timeline: mergeTimelineSteps(instance.timeline, timeline),
                  },
                  { ...task, resultViewKind: nextKind },
                );
              }),
            };
          }),
        }));
      },
      retryTaskInstanceRun: (taskId, instanceId) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => ({
            ...task,
            instances: task.instances.map((instance) =>
              instance.id === instanceId
                ? normalizeInstance(
                    {
                      ...instance,
                      status: "pending",
                      execution: {
                        phase: "retrying",
                        status: "pending",
                        startedAt: instance.execution?.startedAt,
                        lastUpdatedAt: nowIso(),
                      },
                    },
                    task,
                  )
                : instance,
            ),
          })),
        }));
      },
      stopTaskInstanceRun: (taskId, instanceId) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => ({
            ...task,
            instances: task.instances.map((instance) =>
              instance.id === instanceId
                ? normalizeInstance(
                    {
                      ...instance,
                      status: "paused",
                      execution: {
                        phase: "cancelled",
                        status: "paused",
                        startedAt: instance.execution?.startedAt,
                        finishedAt: nowIso(),
                        lastUpdatedAt: nowIso(),
                      },
                    },
                    task,
                  )
                : instance,
            ),
          })),
        }));
      },
      markTaskNotificationDelivered: ({ taskId, instanceId, inboxItemId, conversationMessageId }) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => ({
            ...task,
            instances: task.instances.map((instance) =>
              instance.id === instanceId && instance.notification
                ? normalizeInstance(
                    {
                      ...instance,
                      notification: {
                        ...instance.notification,
                        deliveryState: "delivered",
                        deliveredAt: nowIso(),
                        inboxItemId: inboxItemId ?? instance.notification.inboxItemId,
                        conversationMessageId:
                          conversationMessageId ?? instance.notification.conversationMessageId,
                      },
                    },
                    task,
                  )
                : instance,
            ),
          })),
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
            return finalizeGoal({
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
                  resultViewKind: input.executionKind,
                  executionStrategy: "agent_autonomous",
                  executionObjective: input.description,
                };
                return { ...subGoal, tasks: [...subGoal.tasks, newTask] };
              }),
            });
          }),
        }));
      },
    }),
    {
      name: "kiki.goals",
      version: MOCK_BASELINE_RESET_VERSION,
      migrate: () => ({
        goals: initialGoals.map((goal) => normalizeGoal(goal)),
      }),
      partialize: (state) => ({ goals: state.goals }),
      merge: (persisted, current) => {
        const next = persisted as Partial<GoalStore>;
        return {
          ...current,
          ...next,
          goals: (next.goals ?? current.goals).map((goal) => normalizeGoal(goal)),
        };
      },
    },
  ),
);

export function getGoalById(goalId: string) {
  return useGoalStore.getState().goals.find((goal) => goal.id === goalId);
}

export function getTaskById(taskId: string) {
  return findTaskLocation(useGoalStore.getState().goals, taskId);
}
