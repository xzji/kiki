import { createGeneratedInstance } from "@/mocks/goals";
import { summarizeToolOperation } from "@/lib/execution/summarizeToolOperation";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type {
  Goal,
  InteractionRequirement,
  InteractionSubmission,
  SubGoal,
  Task,
  TaskExecutionPhase,
  TaskExecutionStep,
  TaskInstance,
  TaskInstanceNotificationState,
  TaskInstanceStatus,
  TaskResultNotificationDecision,
  TaskResultViewKind,
  TaskRunArtifact,
  TaskRunErrorCategory,
} from "@/types/kiki";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type { TaskResult } from "@/types/taskResult";

function defaultResultViewKind(task: Task) {
  return task.resultViewKind ?? task.executionKind ?? "generic_result";
}

function nowIso() {
  return new Date().toISOString();
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
          : log.eventType === "result_ready"
            ? "result"
            : log.eventType === "await_user"
              ? "assistant"
              : log.eventType === "retry_scheduled"
                ? "retry"
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
    detail: step.thought ?? summarizeToolOperation(step.toolCall?.name, step.toolCall?.input),
    toolName: step.toolCall?.name,
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
  const rawDecision = progress?.resultPayload?.notificationDecision;
  if (!isNotificationDecision(rawDecision)) return instance.notification;
  const previous = instance.notification;
  const deliveryState =
    previous?.deliveryState === "delivered"
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
  };
}

export function addGeneratedInstanceToGoalsSnapshot(goals: Goal[], taskId: string, createdAt: string) {
  return goals.map((goal) => ({
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      tasks: subGoal.tasks.map((task) => {
        if (task.id !== taskId) return task;
        const date = new Date(createdAt);
        const dateLabel = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        if (task.instances.some((instance) => instance.dateLabel === dateLabel)) return task;
        const nextInstance = createGeneratedInstance(task, createdAt);
        return {
          ...task,
          instances: [nextInstance, ...task.instances],
        };
      }),
    })),
  }));
}

export function upsertGoalTaskInstanceSnapshot(
  goals: Goal[],
  input: {
    goal: Goal;
    subGoal: SubGoal;
    task: Task;
    instance: TaskInstance;
  },
) {
  let foundGoal = false;
  let foundSubGoal = false;
  let foundTask = false;

  const nextGoals = goals.map((goal) => {
    if (goal.id !== input.goal.id) return goal;
    foundGoal = true;
    return {
      ...goal,
      ...input.goal,
      subGoals: goal.subGoals.map((subGoal) => {
        if (subGoal.id !== input.subGoal.id) return subGoal;
        foundSubGoal = true;
        return {
          ...subGoal,
          ...input.subGoal,
          tasks: subGoal.tasks.map((task) => {
            if (task.id !== input.task.id) return task;
            foundTask = true;
            const withoutCurrent = task.instances.filter((instance) => instance.id !== input.instance.id);
            return {
              ...task,
              ...input.task,
              instances: [input.instance, ...withoutCurrent],
            };
          }),
        };
      }),
    };
  });

  if (!foundGoal) {
    return [
      {
        ...input.goal,
        subGoals: [
          {
            ...input.subGoal,
            tasks: [
              {
                ...input.task,
                instances: [input.instance, ...input.task.instances.filter((instance) => instance.id !== input.instance.id)],
              },
            ],
          },
        ],
      },
      ...nextGoals,
    ];
  }

  if (!foundSubGoal) {
    return nextGoals.map((goal) =>
      goal.id === input.goal.id
        ? {
            ...goal,
            subGoals: [
              {
                ...input.subGoal,
                tasks: [
                  {
                    ...input.task,
                    instances: [input.instance, ...input.task.instances.filter((instance) => instance.id !== input.instance.id)],
                  },
                ],
              },
              ...goal.subGoals,
            ],
          }
        : goal,
    );
  }

  if (!foundTask) {
    return nextGoals.map((goal) =>
      goal.id === input.goal.id
        ? {
            ...goal,
            subGoals: goal.subGoals.map((subGoal) =>
              subGoal.id === input.subGoal.id
                ? {
                    ...subGoal,
                    tasks: [
                      {
                        ...input.task,
                        instances: [input.instance, ...input.task.instances.filter((instance) => instance.id !== input.instance.id)],
                      },
                      ...subGoal.tasks,
                    ],
                  }
                : subGoal,
            ),
          }
        : goal,
    );
  }

  return nextGoals;
}

export function markGoalInstanceRunStarted(
  goals: Goal[],
  input: {
    taskId: string;
    instanceId: string;
    requestId: string;
    runtimeEnvId?: string;
    permissionMode?: "readonly" | "confirm" | "execute";
    workingDirectory?: string;
  },
) {
  return goals.map((goal) => ({
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      tasks: subGoal.tasks.map((task) => {
        if (task.id !== input.taskId) return task;
        return {
          ...task,
          instances: task.instances.map((instance) =>
            instance.id === input.instanceId
              ? {
                  ...instance,
                  status: "in_progress" as TaskInstanceStatus,
                  runner: {
                    requestId: input.requestId,
                    runtimeEnvId: input.runtimeEnvId,
                    permissionMode: input.permissionMode,
                    workingDirectory: input.workingDirectory,
                    attemptCount: (instance.runner?.attemptCount ?? 0) + 1,
                    lastAttemptAt: nowIso(),
                  },
                  execution: {
                    phase: "running" as TaskExecutionPhase,
                    status: "in_progress" as TaskInstanceStatus,
                    startedAt: instance.execution?.startedAt ?? nowIso(),
                    lastUpdatedAt: nowIso(),
                  },
                }
              : instance,
          ),
        };
      }),
    })),
  }));
}

export function syncGoalInstanceFromProgress(
  goals: Goal[],
  input: {
    taskId: string;
    instanceId: string;
    progress: GoalServerProgress | null;
    logs?: GoalServerLogEntry[];
    trajectory?: ExecutionTrajectoryStep[];
  },
) {
  return goals.map((goal) => ({
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      tasks: subGoal.tasks.map((task) => {
        if (task.id !== input.taskId) return task;
        const progressTrajectory = Array.isArray(input.progress?.resultPayload?.trajectory)
          ? (input.progress.resultPayload.trajectory as ExecutionTrajectoryStep[])
          : undefined;
        const nextTrajectory = input.trajectory?.length ? input.trajectory : progressTrajectory;
        const timeline = normalizeTimelineFromTrajectory(nextTrajectory) ?? normalizeTimelineFromLogs(input.logs);
        return {
          ...task,
          progress:
            input.progress?.status === "completed" && !input.progress.resultPayload?.awaitingUser
              ? Math.min(
                  100,
                  Math.max(task.progress, task.progress + (defaultResultViewKind(task) === "flashcard" ? 8 : 5)),
                )
              : task.progress,
          instances: task.instances.map((instance) => {
            if (instance.id !== input.instanceId) return instance;
            const nextStatus: TaskInstanceStatus =
              input.progress?.status === "completed"
                ? input.progress.resultPayload?.awaitingUser
                  ? "awaiting_user"
                  : "completed"
                : input.progress?.status === "failed"
                  ? "error"
                  : "in_progress";
            const nextPhase: TaskExecutionPhase =
              nextStatus === "completed"
                ? "completed"
                : nextStatus === "awaiting_user"
                  ? "awaiting_user"
                  : nextStatus === "error"
                    ? "failed"
                    : "running";
            const nextKind =
              (input.progress?.resultPayload?.resultViewKind as TaskResultViewKind | undefined) ??
              defaultResultViewKind(task);
            const artifacts = Array.isArray(input.progress?.resultPayload?.artifacts)
              ? (input.progress.resultPayload.artifacts as TaskRunArtifact[])
              : undefined;
            if (!input.progress) return instance;
            const interactionRequirement = input.progress?.resultPayload?.interactionRequirement as
              | InteractionRequirement
              | undefined;
            const interactionSubmission = input.progress?.resultPayload?.interactionSubmission as
              | InteractionSubmission
              | undefined;
            const taskResult = input.progress?.resultPayload?.taskResult as TaskResult | undefined;
            const blocker = input.progress?.resultPayload?.blocker as ExecutionBlocker | undefined;
            return {
              ...instance,
              status: nextStatus,
              payload:
                nextKind === "generic_result"
                  ? {
                      kind: "generic_result" as const,
                      summary: input.progress?.summary || instance.result?.summary || instance.intro,
                      details:
                        typeof input.progress?.resultPayload?.finalMessage === "string"
                          ? input.progress.resultPayload.finalMessage
                          : undefined,
                      artifacts:
                        artifacts ?? (instance.payload.kind === "generic_result" ? instance.payload.artifacts : undefined),
                    }
                  : instance.payload,
              execution: {
                phase: nextPhase,
                status: nextStatus,
                startedAt: instance.execution?.startedAt ?? input.progress?.startedAt ?? instance.createdAt,
                finishedAt: input.progress?.finishedAt,
                lastUpdatedAt: input.progress?.updatedAt ?? nowIso(),
                errorCategory:
                  nextStatus === "error"
                    ? ((input.progress?.resultPayload?.errorCategory as TaskRunErrorCategory | undefined) ?? "unknown")
                    : undefined,
                errorMessage: nextStatus === "error" ? input.progress?.error : undefined,
              },
              result: {
                summary: input.progress.summary || instance.result?.summary,
                finalMessage:
                  typeof input.progress.resultPayload?.finalMessage === "string"
                    ? input.progress.resultPayload.finalMessage
                    : instance.result?.finalMessage,
                taskResult: taskResult ?? instance.result?.taskResult,
                structuredOutput:
                  (input.progress.resultPayload?.structuredOutput as Record<string, unknown> | null | undefined) ??
                  instance.result?.structuredOutput ??
                  null,
                artifacts: artifacts ?? instance.result?.artifacts,
                interactionRequirement: interactionRequirement ?? instance.result?.interactionRequirement,
                interactionSubmission: interactionSubmission ?? instance.result?.interactionSubmission,
              },
              awaitingUser: input.progress?.resultPayload?.awaitingUser
                ? {
                    reason:
                      (input.progress.resultPayload?.awaitingReason as string | undefined) ||
                      interactionRequirement?.reason ||
                      "任务需要你参与后才能继续。",
                    suggestedActions: Array.isArray(input.progress.resultPayload?.suggestedActions)
                      ? (input.progress.resultPayload.suggestedActions as string[])
                      : interactionRequirement?.suggestedActions,
                    interactionRequirement,
                    blocker,
                  }
                : undefined,
              blocker,
              notification: normalizeNotificationFromProgress(input.progress, instance),
              timeline: mergeTimelineSteps(instance.timeline, timeline),
              trajectory: nextTrajectory ?? instance.trajectory,
            };
          }),
        };
      }),
    })),
  }));
}
