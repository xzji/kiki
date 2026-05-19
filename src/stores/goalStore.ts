"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { summarizeToolOperation } from "@/lib/execution/summarizeToolOperation";
import { getGoalBreakdownDraft } from "@/mocks/goal-breakdown";
import { buildGoalFromDraft, createGeneratedInstance, initialGoals } from "@/mocks/goals";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type {
  ExecutionPayload,
  Goal,
  GoalBreakdownDraft,
  GoalWorkflow,
  InteractionRequirement,
  InteractionSubmission,
  Task,
  TaskExecutionStep,
  TaskInstance,
  TaskInstanceNotificationState,
  TaskResultNotificationDecision,
  TaskRunArtifact,
  TaskRunErrorCategory,
  TaskResultViewKind,
} from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";

const MOCK_BASELINE_RESET_VERSION = 9;

function mergeGoalsById(...groups: Goal[][]) {
  const merged = new Map<string, Goal>();
  for (const group of groups) {
    for (const goal of group) {
      if (!merged.has(goal.id)) merged.set(goal.id, goal);
    }
  }
  return Array.from(merged.values());
}

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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getTrimmedString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getTrimmedStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => Boolean(item));
}

function dedupeStrings(values: Array<string | undefined>, limit = 6) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function stripSubGoalPrefix(value: string) {
  return value.replace(/^子目标\d+：/, "").trim();
}

function joinNaturalList(items: string[], conjunction = "、") {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} 和 ${items[1]}`;
  return `${items.slice(0, -1).join(conjunction)} 和 ${items[items.length - 1]}`;
}

function normalizeSentence(value: string) {
  return value.trim().replace(/[。；;，,\s]+$/g, "");
}

function extractGoalPlanningContext(goal: Goal) {
  const collectedInfo = isObject(goal.workflow?.collectedInfo) ? goal.workflow?.collectedInfo : undefined;
  const goalAnalysis = isObject(collectedInfo?.goalAnalysis) ? collectedInfo.goalAnalysis : undefined;
  const collectedInfoSummary = isObject(collectedInfo?.collectedInfoSummary)
    ? collectedInfo.collectedInfoSummary
    : undefined;

  return {
    coreIntent: getTrimmedString(goalAnalysis?.coreIntent),
    successState: getTrimmedString(goalAnalysis?.successState),
    goalDetails: getTrimmedString(collectedInfoSummary?.goalDetails),
    summary: getTrimmedString(collectedInfoSummary?.summary) ?? goal.summary,
    executionOrder: getTrimmedString(collectedInfo?.executionOrder),
    reviewSummary: getTrimmedStringArray(collectedInfo?.reviewSummary),
  };
}

function extractSubGoalReviewSummary(reviewSummary: string[], subGoalTitle: string) {
  const plainTitle = stripSubGoalPrefix(subGoalTitle);
  const match = reviewSummary.find((item) => {
    const [prefix] = item.split("：");
    return prefix?.trim() === subGoalTitle.trim() || prefix?.trim() === plainTitle;
  });
  if (!match) return undefined;
  const [, detail = ""] = match.split(/：(.+)/);
  const trimmed = detail.trim();
  return trimmed && !/^已根据 review 调整/.test(trimmed) ? trimmed : undefined;
}

function inferSubGoalPriority(subGoal: Goal["subGoals"][number]): Goal["subGoals"][number]["priority"] {
  const priorityRank: Record<NonNullable<Task["priority"]>, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  let bestPriority: NonNullable<Task["priority"]> | undefined;

  for (const task of subGoal.tasks) {
    if (!task.priority) continue;
    if (!bestPriority || priorityRank[task.priority] > priorityRank[bestPriority]) {
      bestPriority = task.priority;
    }
  }

  return bestPriority;
}

function inferSubGoalDependencies(goal: Goal, subGoal: Goal["subGoals"][number]) {
  const dependencyIds = new Set<string>();
  const taskToSubGoalId = new Map<string, string>();

  goal.subGoals.forEach((item) => {
    item.tasks.forEach((task) => {
      taskToSubGoalId.set(task.id, item.id);
    });
  });

  subGoal.tasks.forEach((task) => {
    task.dependencies?.forEach((dependencyId) => {
      const ownerSubGoalId = taskToSubGoalId.get(dependencyId);
      if (ownerSubGoalId && ownerSubGoalId !== subGoal.id) {
        dependencyIds.add(ownerSubGoalId);
      }
    });
  });

  return Array.from(dependencyIds);
}

function inferSubGoalSuccessCriteria(subGoal: Goal["subGoals"][number]) {
  return dedupeStrings(
    subGoal.tasks.flatMap((task) => [
      task.expectedResult?.completionCriteria,
      task.expectedResult?.description,
      task.collaboration?.completionDefinition,
      task.expectedOutcome,
    ]),
    5,
  );
}

function inferSubGoalEstimatedDuration(subGoal: Goal["subGoals"][number]) {
  if (subGoal.tasks.length === 0) return undefined;
  return subGoal.tasks.reduce((total, task) => {
    const taskTypeMinutes =
      task.taskType === "one_shot" ? 90 : task.taskType === "monitoring" ? 45 : 60;
    const executionBonus =
      task.executionMode === "interactive" ? 30 : task.executionMode === "monitoring" ? 15 : 0;
    return total + taskTypeMinutes + executionBonus;
  }, 0);
}

function inferSubGoalWeight(goal: Goal, subGoal: Goal["subGoals"][number]) {
  const totalTaskCount = goal.subGoals.reduce((count, item) => count + item.tasks.length, 0);
  if (totalTaskCount === 0 || subGoal.tasks.length === 0) return undefined;
  return Number((subGoal.tasks.length / totalTaskCount).toFixed(2));
}

function inferSubGoalWhy(
  goal: Goal,
  subGoal: Goal["subGoals"][number],
  successCriteria: string[],
  reviewDetail?: string,
) {
  const context = extractGoalPlanningContext(goal);
  const anchor = context.coreIntent ?? context.successState ?? goal.title;
  if (reviewDetail) {
    return `该子目标直接支撑「${anchor}」，${normalizeSentence(reviewDetail)}。`;
  }
  const primaryOutcome = successCriteria[0] ?? subGoal.tasks[0]?.expectedOutcome;
  return primaryOutcome
    ? `该子目标直接支撑「${anchor}」，并以「${normalizeSentence(primaryOutcome)}」作为阶段性成果。`
    : undefined;
}

function inferSubGoalDescription(
  goal: Goal,
  subGoal: Goal["subGoals"][number],
  successCriteria: string[],
  reviewDetail?: string,
) {
  const taskFocus = dedupeStrings(
    subGoal.tasks.map((task) => normalizeSentence(task.executionObjective ?? task.description)),
    2,
  );
  const deliverables = dedupeStrings(
    subGoal.tasks.map((task) => normalizeSentence(task.expectedResult?.description ?? task.expectedOutcome)),
    2,
  );
  const context = extractGoalPlanningContext(goal);
  const plainTitle = stripSubGoalPrefix(subGoal.title);

  const focusSegment = taskFocus.length > 0 ? `围绕 ${joinNaturalList(taskFocus)} 展开` : "围绕当前关键任务推进";
  const deliverableSegment =
    deliverables.length > 0
      ? `并沉淀 ${joinNaturalList(deliverables)} 等阶段结果`
      : successCriteria[0]
        ? `并以 ${normalizeSentence(successCriteria[0])} 作为核心完成标志`
        : "";
  const reviewSegment = reviewDetail ? `，重点关注 ${normalizeSentence(reviewDetail)}` : "";
  const contextSegment = context.goalDetails || context.summary ? `，服务于「${plainTitle}」这一阶段目标` : "";

  return `${plainTitle}${contextSegment}，${focusSegment}${deliverableSegment}${reviewSegment}。`;
}

function enrichSubGoalMetadata(goal: Goal): Goal {
  const context = extractGoalPlanningContext(goal);

  return {
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => {
      const reviewDetail = extractSubGoalReviewSummary(context.reviewSummary, subGoal.title);
      const successCriteria =
        subGoal.successCriteria && subGoal.successCriteria.length > 0
          ? subGoal.successCriteria
          : inferSubGoalSuccessCriteria(subGoal);

      return {
        ...subGoal,
        description:
          getTrimmedString(subGoal.description) ??
          inferSubGoalDescription(goal, subGoal, successCriteria, reviewDetail),
        why: getTrimmedString(subGoal.why) ?? inferSubGoalWhy(goal, subGoal, successCriteria, reviewDetail),
        priority: subGoal.priority ?? inferSubGoalPriority(subGoal),
        weight: typeof subGoal.weight === "number" ? subGoal.weight : inferSubGoalWeight(goal, subGoal),
        dependencies:
          subGoal.dependencies && subGoal.dependencies.length > 0
            ? subGoal.dependencies
            : inferSubGoalDependencies(goal, subGoal),
        estimatedDurationMinutes:
          typeof subGoal.estimatedDurationMinutes === "number"
            ? subGoal.estimatedDurationMinutes
            : inferSubGoalEstimatedDuration(subGoal),
        successCriteria,
      };
    }),
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

function normalizeTimelineFromTrajectory(trajectory: ExecutionTrajectoryStep[] | undefined): TaskExecutionStep[] | undefined {
  if (!trajectory?.length) return undefined;
  return trajectory.map((step) => ({
    id: step.id,
    title: step.title,
    type:
      step.type === "tool_call" || step.type === "tool_result"
        ? "tool"
        : step.type === "assistant"
          ? "assistant"
          : step.type === "result"
            ? "result"
            : "phase",
    status: step.status,
    agentRole: step.agentRole,
    detail: step.thought ?? summarizeToolOperation(step.toolCall?.name, step.toolCall?.input),
    toolName: step.toolCall?.name,
    handoff: step.handoff,
    startedAt: step.startedAt,
    finishedAt: step.endedAt,
  }));
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
  const interactionSubmission = progress?.resultPayload?.interactionSubmission;
  if (interactionSubmission && progress.resultPayload?.awaitingUser !== true) return undefined;
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
  return finalizeGoal(enrichSubGoalMetadata({
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      tasks: subGoal.tasks.map((task) => normalizeTask(task)),
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
  replaceGoals: (goals: Goal[]) => void;
  deleteTask: (taskId: string) => void;
  markInstanceStatus: (taskId: string, instanceId: string, status: TaskInstance["status"]) => void;
  controlTaskExecution: (taskId: string, action: "start" | "pause" | "resume") => void;
  completeTaskInstance: (taskId: string, instanceId: string, submission?: InteractionSubmission) => void;
  generateInstance: (taskId: string, createdAt: string) => TaskInstance | null;
  generateRerunInstance: (taskId: string, createdAt: string) => TaskInstance | null;
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
    trajectory?: ExecutionTrajectoryStep[];
    waitingReason?: string;
  }) => void;
  failTaskInstanceRun: (input: {
    taskId: string;
    instanceId: string;
    requestId?: string;
    errorMessage: string;
  }) => void;
  retryTaskInstanceRun: (taskId: string, instanceId: string) => void;
  stopTaskInstanceRun: (taskId: string, instanceId: string) => void;
  resolveTaskInstanceAwaitingUser: (taskId: string, instanceId: string, submission: InteractionSubmission) => void;
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
      completeTaskInstance: (taskId, instanceId, submission) => {
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
                      result: submission
                        ? {
                            ...instance.result,
                            summary: `${submission.action}已提交`,
                            interactionSubmission: submission,
                            structuredOutput: {
                              ...(instance.result?.structuredOutput ?? {}),
                              interactionSubmission: submission,
                            },
                          }
                        : instance.result,
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
        const timeLabel = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
        const baseInstance = createGeneratedInstance(found.task, createdAt);
        const nextInstance = {
          ...baseInstance,
          id: `${baseInstance.id}-run-${date.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
          dateLabel: `${dateLabel} ${timeLabel}`,
          intro: `用户手动发起执行“${found.task.title.replace(/^任务\d+：/, "")}”。`,
        };
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => ({
            ...task,
            instances: [normalizeInstance(nextInstance, task), ...task.instances],
          })),
        }));
        return nextInstance;
      },
      generateRerunInstance: (taskId, createdAt) => {
        const found = findTaskLocation(get().goals, taskId);
        if (!found) return null;
        const baseInstance = createGeneratedInstance(found.task, createdAt);
        const date = new Date(createdAt);
        const timeLabel = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
        const nextInstance = normalizeInstance(
          {
            ...baseInstance,
            id: `${baseInstance.id}-rerun-${date.getTime()}`,
            dateLabel: `${baseInstance.dateLabel} 重跑 ${timeLabel}`,
            intro: `重新执行“${found.task.title.replace(/^任务\d+：/, "")}”，KiKi 将基于当前任务要求重新产出结果。`,
          },
          found.task,
        );
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

        const subGoalIdMap = new Map<string, string>();
        base.subGoals.forEach((baseSubGoal, sgIndex) => {
          const nextSubGoal = nextGoal.subGoals[sgIndex];
          if (nextSubGoal) {
            subGoalIdMap.set(baseSubGoal.id, nextSubGoal.id);
          }
        });

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
            description: draftSubGoal?.description ?? sg.description,
            why: draftSubGoal?.why ?? sg.why,
            priority: draftSubGoal?.priority ?? sg.priority,
            weight: draftSubGoal?.weight ?? sg.weight,
            dependencies:
              sg.dependencies?.map((dependencyId) => subGoalIdMap.get(dependencyId) ?? dependencyId) ??
              draftSubGoal?.dependencies,
            estimatedDurationMinutes:
              draftSubGoal?.estimatedDurationMinutes ?? sg.estimatedDurationMinutes,
            successCriteria: draftSubGoal?.successCriteria ?? sg.successCriteria,
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
      syncTaskInstanceRun: ({ taskId, instanceId, progress, logs, trajectory }) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => {
            const progressTrajectory = Array.isArray(progress?.resultPayload?.trajectory)
              ? (progress.resultPayload.trajectory as ExecutionTrajectoryStep[])
              : undefined;
            const nextTrajectory = trajectory?.length ? trajectory : progressTrajectory;
            const timeline = normalizeTimelineFromTrajectory(nextTrajectory) ?? normalizeTimelineFromLogs(logs);
            return {
              ...task,
              progress:
                progress?.status === "completed" && !progress.resultPayload?.awaitingUser
                  ? Math.min(100, Math.max(task.progress, task.progress + (defaultResultViewKind(task) === "flashcard" ? 8 : 5)))
                  : task.progress,
              instances: task.instances.map((instance) => {
                if (instance.id !== instanceId) return instance;
                const nextStatus =
                  progress?.status === "completed"
                    ? progress.resultPayload?.awaitingUser
                      ? "awaiting_user"
                      : "completed"
                    : progress?.status === "cancelled"
                      ? "paused"
                    : progress?.status === "failed"
                      ? "error"
                      : "in_progress";
                const nextKind = (progress?.resultPayload?.resultViewKind as TaskResultViewKind | undefined) ?? defaultResultViewKind(task);
                const artifacts = Array.isArray(progress?.resultPayload?.artifacts)
                  ? (progress.resultPayload.artifacts as TaskRunArtifact[])
                  : undefined;
                if (!progress) return instance;
                const taskResult = progress.resultPayload?.taskResult as TaskResult | undefined;
                const interactionRequirement = progress.resultPayload?.interactionRequirement as InteractionRequirement | undefined;
                const interactionSubmission = progress.resultPayload?.interactionSubmission as InteractionSubmission | undefined;
                const blocker = progress.resultPayload?.blocker as ExecutionBlocker | undefined;
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
                              : nextStatus === "paused"
                                ? "cancelled"
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
                    result: {
                      summary: progress.summary || instance.result?.summary,
                      finalMessage:
                        typeof progress.resultPayload?.finalMessage === "string"
                          ? progress.resultPayload.finalMessage
                          : instance.result?.finalMessage,
                      taskResult: taskResult ?? instance.result?.taskResult,
                      structuredOutput:
                        (progress.resultPayload?.structuredOutput as Record<string, unknown> | null | undefined) ??
                        instance.result?.structuredOutput ??
                        null,
                      artifacts: artifacts ?? instance.result?.artifacts,
                      interactionRequirement: interactionRequirement ?? instance.result?.interactionRequirement,
                      interactionSubmission: interactionSubmission ?? instance.result?.interactionSubmission,
                    },
                    awaitingUser:
                      progress?.resultPayload?.awaitingUser
                        ? {
                            reason:
                              (progress.resultPayload?.awaitingReason as string | undefined) || "任务需要你确认下一步。",
                            suggestedActions: Array.isArray(progress.resultPayload?.suggestedActions)
                              ? (progress.resultPayload.suggestedActions as string[])
                              : interactionRequirement?.suggestedActions,
                            interactionRequirement,
                            blocker,
                          }
                        : undefined,
                    blocker,
                    notification: normalizeNotificationFromProgress(progress, instance),
                    timeline: mergeTimelineSteps(instance.timeline, timeline),
                    trajectory: nextTrajectory ?? instance.trajectory,
                  },
                  { ...task, resultViewKind: nextKind },
                );
              }),
            };
          }),
        }));
      },
      failTaskInstanceRun: ({ taskId, instanceId, requestId, errorMessage }) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => ({
            ...task,
            instances: task.instances.map((instance) =>
              instance.id === instanceId
                ? normalizeInstance(
                    {
                      ...instance,
                      status: "error",
                      execution: {
                        phase: "failed",
                        status: "error",
                        startedAt: instance.execution?.startedAt,
                        finishedAt: nowIso(),
                        lastUpdatedAt: nowIso(),
                        errorCategory: "unknown",
                        errorMessage,
                      },
                      result: {
                        ...instance.result,
                        summary: errorMessage,
                        structuredOutput: {
                          ...(instance.result?.structuredOutput ?? {}),
                          requestId,
                        },
                      },
                    },
                    task,
                  )
                : instance,
            ),
          })),
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
      resolveTaskInstanceAwaitingUser: (taskId, instanceId, submission) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => ({
            ...task,
            instances: task.instances.map((instance) =>
              instance.id === instanceId
                ? normalizeInstance(
                    {
                      ...instance,
                      status: "in_progress",
                      awaitingUser: undefined,
                      blocker: undefined,
                      result: {
                        ...instance.result,
                        interactionSubmission: submission,
                        structuredOutput: {
                          ...(instance.result?.structuredOutput ?? {}),
                          interactionSubmission: submission,
                        },
                      },
                      execution: {
                        ...instance.execution,
                        phase: "running",
                        status: "in_progress",
                        startedAt: instance.execution?.startedAt ?? instance.createdAt,
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
      migrate: (persisted) => {
        const next = persisted as Partial<GoalStore> | undefined;
        const persistedGoals = Array.isArray(next?.goals) ? next.goals : [];
        return {
          goals: mergeGoalsById(persistedGoals, initialGoals).map((goal) => normalizeGoal(goal)),
        };
      },
      partialize: (state) => ({ goals: state.goals }),
      merge: (persisted, current) => {
        const next = persisted as Partial<GoalStore>;
        return {
          ...current,
          ...next,
          goals: mergeGoalsById(next.goals ?? current.goals, initialGoals).map((goal) => normalizeGoal(goal)),
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
