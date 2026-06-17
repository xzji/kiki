"use client";

import { create } from "zustand";

import { summarizeToolOperation } from "@/lib/execution/summarizeToolOperation";
import { migrateGoalIds } from "@/lib/opaqueIds";
import { normalizeConcreteTriggerRule, normalizeGoalTriggerRules } from "@/lib/taskTriggerTime";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import { normalizeExecutionKind, normalizeTaskResultViewKind } from "@/types/kiki";
import type {
  ExecutionPayload,
  Goal,
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
} from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";

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
  return normalizeTaskResultViewKind(task.resultViewKind ?? task.executionKind);
}

function normalizeTaskType(taskType: unknown): Task["taskType"] {
  return taskType === "one_shot" ? "one_shot" : "repeat";
}

function normalizeTask(task: Task): Task {
  const normalizedTaskType = normalizeTaskType((task as { taskType?: unknown }).taskType);
  const taskFields = { ...task } as Task & Record<string, unknown>;
  delete taskFields["execution" + "Cycle"];
  return {
    ...taskFields,
    executionKind: normalizeExecutionKind(task.executionKind),
    taskType: normalizedTaskType,
    triggerRule: normalizeConcreteTriggerRule(task.triggerRule, normalizedTaskType),
    resultViewKind: normalizeTaskResultViewKind(task.resultViewKind ?? task.executionKind),
    executionStrategy: task.executionStrategy ?? "agent_autonomous",
    executionObjective: task.executionObjective ?? task.description,
    instances: task.instances.map((instance) =>
      normalizeInstance(instance, { ...taskFields, taskType: normalizedTaskType }),
    ),
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
    const taskTypeMinutes = task.taskType === "one_shot" ? 90 : 60;
    const executionBonus =
      task.executionMode === "interactive" ? 30 : task.executionMode === "monitoring" ? 15 : 0;
    return total + taskTypeMinutes + executionBonus;
  }, 0);
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
    toolInput: step.toolCall?.input,
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

function notificationContentHash(decision: TaskResultNotificationDecision) {
  return JSON.stringify({
    snippet: decision.snippet ?? "",
    userMessage: decision.userMessage ?? "",
    notificationType: decision.notificationType ?? "",
  });
}

function normalizeNotificationFromProgress(
  progress: GoalServerProgress | null,
  instance: TaskInstance,
): TaskInstanceNotificationState | undefined {
  const interactionSubmission = progress?.resultPayload?.interactionSubmission;
  if (interactionSubmission && progress.resultPayload?.awaitingUser !== true) return undefined;
  const rawDecision = progress?.resultPayload?.notificationDecision;
  if (!isNotificationDecision(rawDecision)) return instance.notification;
  const previous = instance.notification;
  const nextHash = notificationContentHash(rawDecision);
  // 与服务端 normalizeNotificationFromProgress 保持一致：
  // 当上一次 delivered 的 hash 与本轮决策不同时，把 deliveryState 退回 pending，
  // 触发新一次 append-only 派发。
  const shouldRedeliver = Boolean(
    previous?.deliveryState === "delivered" &&
      previous.lastDeliveredHash &&
      previous.lastDeliveredHash !== nextHash &&
      rawDecision.shouldNotify,
  );
  const deliveryState = shouldRedeliver
    ? "pending"
    : previous?.deliveryState === "delivered"
      ? "delivered"
      : rawDecision.shouldNotify
        ? "pending"
        : "silent";
  return {
    ...rawDecision,
    deliveryState,
    deliveredAt: previous?.deliveredAt,
    inboxItemId: previous?.inboxItemId,
    conversationMessageId: previous?.conversationMessageId,
    notificationSequence: previous?.notificationSequence,
    pushedConversationMessageIds: previous?.pushedConversationMessageIds,
    lastDeliveredHash: previous?.lastDeliveredHash,
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
              ? "paused"
              : status === "terminated"
                ? "cancelled"
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
  const migrated = normalizeGoalTriggerRules(migrateGoalIds(goal));
  return finalizeGoal(enrichSubGoalMetadata({
    ...migrated,
    subGoals: migrated.subGoals.map((subGoal) => ({
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

export type PendingTaskCreateOverlay = {
  id: string;
  goalId: string;
  subGoalId: string;
  idempotencyKey: string;
  task: Task;
  createdAt: string;
};

export type PendingSubGoalCreateOverlay = {
  id: string;
  goalId: string;
  idempotencyKey: string;
  subGoal: Goal["subGoals"][number];
  createdAt: string;
};

export type PendingTaskUpdateOverlay = {
  id: string;
  goalId: string;
  taskId: string;
  idempotencyKey: string;
  task: Task;
  createdAt: string;
};

export type PendingTaskDeleteOverlay = {
  id: string;
  goalId: string;
  taskId: string;
  idempotencyKey: string;
  createdAt: string;
};

export type PendingGoalWorkflowOverlay = {
  id: string;
  goalId: string;
  idempotencyKey: string;
  workflow: GoalWorkflow;
  createdAt: string;
};

export type PendingConversationGoalDeleteOverlay = {
  id: string;
  conversationId: string;
  idempotencyKey: string;
  createdAt: string;
};

export type OptimisticTaskRunOverlay = {
  id: string;
  taskId: string;
  instance: TaskInstance;
  requestId: string;
  createdAt: string;
};

function taskMatchesPendingUpdate(task: Task | undefined, pendingTask: Task) {
  if (!task) return false;
  return (
    task.title === pendingTask.title &&
    task.description === pendingTask.description &&
    task.expectedOutcome === pendingTask.expectedOutcome &&
    task.taskType === pendingTask.taskType &&
    task.triggerRule === pendingTask.triggerRule &&
    task.deadline === pendingTask.deadline &&
    task.executionKind === pendingTask.executionKind
  );
}

function workflowMatchesPendingOverlay(workflow: GoalWorkflow | undefined, pendingWorkflow: GoalWorkflow) {
  return Boolean(
    workflow &&
      workflow.phase === pendingWorkflow.phase &&
      workflow.planDecision === pendingWorkflow.planDecision,
  );
}

function isOpenInstanceStatus(status: TaskInstance["status"]) {
  return status === "pending" || status === "in_progress" || status === "awaiting_user";
}

function shouldKeepOptimisticTaskRun(projectedTask: Task | undefined, overlay: OptimisticTaskRunOverlay) {
  if (!projectedTask) return false;
  const projectedInstance = projectedTask.instances.find((instance) => instance.id === overlay.instance.id);
  if (projectedInstance) return projectedInstance.status === "pending";
  return !projectedTask.instances.some((instance) => isOpenInstanceStatus(instance.status));
}

function applyOptimisticTaskRuns(goals: Goal[], overlays: OptimisticTaskRunOverlay[]) {
  if (overlays.length === 0) return goals;
  const overlaysByTaskId = new Map<string, OptimisticTaskRunOverlay[]>();
  for (const overlay of overlays) {
    const items = overlaysByTaskId.get(overlay.taskId) ?? [];
    items.push(overlay);
    overlaysByTaskId.set(overlay.taskId, items);
  }

  let changed = false;
  const nextGoals = goals.map((goal) => {
    let goalChanged = false;
    const subGoals = goal.subGoals.map((subGoal) => {
      let subGoalChanged = false;
      const tasks = subGoal.tasks.map((task) => {
        const taskOverlays = overlaysByTaskId.get(task.id);
        if (!taskOverlays?.length) return task;
        subGoalChanged = true;
        goalChanged = true;
        changed = true;
        const overlayInstances = taskOverlays.map((overlay) => normalizeInstance(overlay.instance, task));
        const overlayInstanceIds = new Set(overlayInstances.map((instance) => instance.id));
        return {
          ...task,
          instances: [
            ...overlayInstances,
            ...task.instances.filter((instance) => !overlayInstanceIds.has(instance.id)),
          ],
        };
      });
      return subGoalChanged ? { ...subGoal, tasks } : subGoal;
    });
    return goalChanged ? { ...goal, subGoals } : goal;
  });
  return changed ? nextGoals : goals;
}

type GoalStore = {
  goals: Goal[];
  goalProjectionRevision: number;
  pendingTaskCreates: PendingTaskCreateOverlay[];
  pendingSubGoalCreates: PendingSubGoalCreateOverlay[];
  pendingTaskUpdates: PendingTaskUpdateOverlay[];
  pendingTaskDeletes: PendingTaskDeleteOverlay[];
  pendingGoalWorkflows: PendingGoalWorkflowOverlay[];
  pendingConversationGoalDeletes: PendingConversationGoalDeleteOverlay[];
  optimisticTaskRuns: OptimisticTaskRunOverlay[];
  applyGoalsProjection: (goals: Goal[], revision?: number) => void;
  addPendingTaskCreate: (overlay: PendingTaskCreateOverlay) => void;
  removePendingTaskCreate: (id: string) => void;
  addPendingSubGoalCreate: (overlay: PendingSubGoalCreateOverlay) => void;
  removePendingSubGoalCreate: (id: string) => void;
  addPendingTaskUpdate: (overlay: PendingTaskUpdateOverlay) => void;
  removePendingTaskUpdate: (id: string) => void;
  addPendingTaskDelete: (overlay: PendingTaskDeleteOverlay) => void;
  removePendingTaskDelete: (id: string) => void;
  addPendingGoalWorkflow: (overlay: PendingGoalWorkflowOverlay) => void;
  removePendingGoalWorkflow: (id: string) => void;
  addPendingConversationGoalDelete: (overlay: PendingConversationGoalDeleteOverlay) => void;
  removePendingConversationGoalDelete: (id: string) => void;
  addOptimisticTaskRun: (overlay: OptimisticTaskRunOverlay) => void;
  removeOptimisticTaskRun: (id: string) => void;
  removeOptimisticTaskRunByInstance: (instanceId: string) => void;
  applyInstanceStatusProjection: (taskId: string, instanceId: string, status: TaskInstance["status"]) => void;
  upsertTaskInstanceProjection: (taskId: string, instance: TaskInstance) => void;
  applyInstanceProgressProjection: (input: {
    taskId: string;
    instanceId: string;
    progress: GoalServerProgress | null;
    logs?: GoalServerLogEntry[];
    trajectory?: ExecutionTrajectoryStep[];
    waitingReason?: string;
  }) => void;
  applyNotificationProjection: (input: {
    taskId: string;
    instanceId: string;
    inboxItemId?: string;
    conversationMessageId?: string;
    notificationSequence?: number;
  }) => void;
};

function nowIso() {
  return new Date().toISOString();
}

let visibleGoalsCache:
  | {
      goals: Goal[];
      pending: PendingConversationGoalDeleteOverlay[];
      optimisticTaskRuns: OptimisticTaskRunOverlay[];
      result: Goal[];
    }
  | null = null;

export function selectVisibleGoals(state: Pick<GoalStore, "goals" | "pendingConversationGoalDeletes" | "optimisticTaskRuns">) {
  const { goals, pendingConversationGoalDeletes: pending, optimisticTaskRuns } = state;
  if (
    visibleGoalsCache &&
    visibleGoalsCache.goals === goals &&
    visibleGoalsCache.pending === pending &&
    visibleGoalsCache.optimisticTaskRuns === optimisticTaskRuns
  ) {
    return visibleGoalsCache.result;
  }
  let result: Goal[];
  if (pending.length === 0) {
    result = goals;
  } else {
    const hiddenConversationIds = new Set(pending.map((item) => item.conversationId));
    const filtered = goals.filter(
      (goal) => !goal.conversationId || !hiddenConversationIds.has(goal.conversationId),
    );
    result = filtered.length === goals.length ? goals : filtered;
  }
  result = applyOptimisticTaskRuns(result, optimisticTaskRuns);
  visibleGoalsCache = { goals, pending, optimisticTaskRuns, result };
  return result;
}

export const useGoalStore = create<GoalStore>()((set) => ({
      goals: [],
      goalProjectionRevision: 0,
      pendingTaskCreates: [],
      pendingSubGoalCreates: [],
      pendingTaskUpdates: [],
      pendingTaskDeletes: [],
      pendingGoalWorkflows: [],
      pendingConversationGoalDeletes: [],
      optimisticTaskRuns: [],
      applyGoalsProjection: (goals, revision) => {
        const normalizedGoals = goals.map((goal) => normalizeGoal(goal));
        const projectedSubGoalIds = new Set(normalizedGoals.flatMap((goal) => goal.subGoals.map((subGoal) => subGoal.id)));
        const projectedConversationIds = new Set(
          normalizedGoals.map((goal) => goal.conversationId).filter((id): id is string => Boolean(id)),
        );
        const projectedTasks = new Map(
          normalizedGoals.flatMap((goal) =>
            goal.subGoals.flatMap((subGoal) => subGoal.tasks.map((task) => [task.id, task] as const)),
          ),
        );
        const projectedWorkflows = new Map(normalizedGoals.map((goal) => [goal.id, goal.workflow] as const));
        set((state) => ({
          goals: normalizedGoals,
          ...(typeof revision === "number" ? { goalProjectionRevision: revision } : {}),
          pendingTaskCreates: state.pendingTaskCreates.filter((item) => !projectedTasks.has(item.task.id)),
          pendingSubGoalCreates: state.pendingSubGoalCreates.filter((item) => !projectedSubGoalIds.has(item.subGoal.id)),
          pendingTaskUpdates: state.pendingTaskUpdates.filter(
            (item) => !taskMatchesPendingUpdate(projectedTasks.get(item.taskId), item.task),
          ),
          pendingTaskDeletes: state.pendingTaskDeletes.filter((item) => projectedTasks.has(item.taskId)),
          pendingGoalWorkflows: state.pendingGoalWorkflows.filter(
            (item) => !workflowMatchesPendingOverlay(projectedWorkflows.get(item.goalId), item.workflow),
          ),
          pendingConversationGoalDeletes: state.pendingConversationGoalDeletes.filter((item) =>
            projectedConversationIds.has(item.conversationId),
          ),
          optimisticTaskRuns: state.optimisticTaskRuns.filter((overlay) =>
            shouldKeepOptimisticTaskRun(projectedTasks.get(overlay.taskId), overlay),
          ),
        }));
      },
      addPendingTaskCreate: (overlay) => {
        set((state) => ({
          pendingTaskCreates: [
            ...state.pendingTaskCreates.filter((item) => item.id !== overlay.id),
            overlay,
          ],
        }));
      },
      removePendingTaskCreate: (id) => {
        set((state) => ({
          pendingTaskCreates: state.pendingTaskCreates.filter((item) => item.id !== id),
        }));
      },
      addPendingSubGoalCreate: (overlay) => {
        set((state) => ({
          pendingSubGoalCreates: [
            ...state.pendingSubGoalCreates.filter((item) => item.id !== overlay.id),
            overlay,
          ],
        }));
      },
      removePendingSubGoalCreate: (id) => {
        set((state) => ({
          pendingSubGoalCreates: state.pendingSubGoalCreates.filter((item) => item.id !== id),
        }));
      },
      addPendingTaskUpdate: (overlay) => {
        set((state) => ({
          pendingTaskUpdates: [
            ...state.pendingTaskUpdates.filter((item) => item.taskId !== overlay.taskId),
            overlay,
          ],
        }));
      },
      removePendingTaskUpdate: (id) => {
        set((state) => ({
          pendingTaskUpdates: state.pendingTaskUpdates.filter((item) => item.id !== id),
        }));
      },
      addPendingTaskDelete: (overlay) => {
        set((state) => ({
          pendingTaskDeletes: [
            ...state.pendingTaskDeletes.filter((item) => item.taskId !== overlay.taskId),
            overlay,
          ],
        }));
      },
      removePendingTaskDelete: (id) => {
        set((state) => ({
          pendingTaskDeletes: state.pendingTaskDeletes.filter((item) => item.id !== id),
        }));
      },
      addPendingGoalWorkflow: (overlay) => {
        set((state) => ({
          pendingGoalWorkflows: [
            ...state.pendingGoalWorkflows.filter((item) => item.goalId !== overlay.goalId),
            overlay,
          ],
        }));
      },
      removePendingGoalWorkflow: (id) => {
        set((state) => ({
          pendingGoalWorkflows: state.pendingGoalWorkflows.filter((item) => item.id !== id),
        }));
      },
      addPendingConversationGoalDelete: (overlay) => {
        set((state) => ({
          pendingConversationGoalDeletes: [
            ...state.pendingConversationGoalDeletes.filter((item) => item.conversationId !== overlay.conversationId),
            overlay,
          ],
        }));
      },
      removePendingConversationGoalDelete: (id) => {
        set((state) => ({
          pendingConversationGoalDeletes: state.pendingConversationGoalDeletes.filter((item) => item.id !== id),
        }));
      },
      addOptimisticTaskRun: (overlay) => {
        set((state) => ({
          optimisticTaskRuns: [
            ...state.optimisticTaskRuns.filter((item) => item.id !== overlay.id && item.instance.id !== overlay.instance.id),
            overlay,
          ],
        }));
      },
      removeOptimisticTaskRun: (id) => {
        set((state) => ({
          optimisticTaskRuns: state.optimisticTaskRuns.filter((item) => item.id !== id),
        }));
      },
      removeOptimisticTaskRunByInstance: (instanceId) => {
        set((state) => ({
          optimisticTaskRuns: state.optimisticTaskRuns.filter((item) => item.instance.id !== instanceId),
        }));
      },
      applyInstanceStatusProjection: (taskId, instanceId, status) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => ({
            ...task,
            instances: task.instances.map((instance) =>
              instance.id === instanceId
                ? normalizeInstance(
                    {
                      ...instance,
                      status,
                      awaitingUser: status === "awaiting_user" ? instance.awaitingUser : undefined,
                      blocker: status === "awaiting_user" ? instance.blocker : undefined,
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
                                    ? "paused"
                                    : status === "terminated"
                                      ? "cancelled"
                                    : "queued",
                        status,
                        startedAt: instance.execution?.startedAt ?? instance.createdAt,
                        finishedAt:
                          status === "completed" || status === "terminated" ? nowIso() : undefined,
                        lastUpdatedAt: nowIso(),
                        waitingReason:
                          status === "awaiting_user" ? instance.execution?.waitingReason : undefined,
                        errorCategory: status === "error" ? "unknown" : instance.execution?.errorCategory,
                        errorMessage: status === "error" ? "任务执行失败" : instance.execution?.errorMessage,
                      },
                    },
                    task,
                  )
                : instance,
            ),
          })),
          optimisticTaskRuns:
            status === "pending"
              ? state.optimisticTaskRuns
              : state.optimisticTaskRuns.filter((item) => item.instance.id !== instanceId),
        }));
      },
      upsertTaskInstanceProjection: (taskId, instance) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => {
            const withoutCurrent = task.instances.filter((candidate) => candidate.id !== instance.id);
            return {
              ...task,
              instances: [normalizeInstance(instance, task), ...withoutCurrent],
            };
          }),
        }));
      },
      applyInstanceProgressProjection: ({ taskId, instanceId, progress, logs, trajectory }) => {
        set((state) => ({
          optimisticTaskRuns: progress
            ? state.optimisticTaskRuns.filter((item) => item.instance.id !== instanceId)
            : state.optimisticTaskRuns,
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
                  ? Math.min(100, Math.max(task.progress, task.progress + 5))
                  : task.progress,
              instances: task.instances.map((instance) => {
                if (instance.id !== instanceId) return instance;
                const nextStatus =
                  progress?.status === "completed"
                    ? progress.resultPayload?.awaitingUser
                      ? "awaiting_user"
                      : "completed"
                    : progress?.status === "cancelled"
                      ? progress.error && /终止|terminate/i.test(progress.error)
                        ? "terminated"
                        : "paused"
                      : progress?.status === "failed"
                        ? "error"
                        : "in_progress";
                const nextKind = normalizeTaskResultViewKind(progress?.resultPayload?.resultViewKind ?? defaultResultViewKind(task));
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
                                : nextStatus === "terminated"
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
      applyNotificationProjection: ({
        taskId,
        instanceId,
        inboxItemId,
        conversationMessageId,
        notificationSequence,
      }) => {
        set((state) => ({
          goals: updateTaskInGoals(state.goals, taskId, (task) => ({
            ...task,
            instances: task.instances.map((instance) => {
              if (instance.id !== instanceId || !instance.notification) return instance;
              const previousIds = instance.notification.pushedConversationMessageIds ?? [];
              // 会话通道每次派发都生成新 messageId；前端投影时直接覆写、并把
              // 历史 id 追加到 pushedConversationMessageIds 中，作为 append 历史轨迹。
              const nextPushedIds = conversationMessageId
                ? Array.from(new Set([...previousIds, conversationMessageId]))
                : previousIds;
              return normalizeInstance(
                {
                  ...instance,
                  notification: {
                    ...instance.notification,
                    deliveryState: "delivered",
                    deliveredAt: nowIso(),
                    inboxItemId: inboxItemId ?? instance.notification.inboxItemId,
                    conversationMessageId:
                      conversationMessageId ?? instance.notification.conversationMessageId,
                    notificationSequence:
                      notificationSequence ?? instance.notification.notificationSequence,
                    pushedConversationMessageIds: nextPushedIds,
                  },
                },
                task,
              );
            }),
          })),
        }));
      },
    }));

export function getGoalById(goalId: string) {
  return selectVisibleGoals(useGoalStore.getState()).find((goal) => goal.id === goalId);
}

export function getTaskById(taskId: string) {
  return findTaskLocation(selectVisibleGoals(useGoalStore.getState()), taskId);
}
