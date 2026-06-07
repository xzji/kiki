import { createOpaqueId } from "@/lib/opaqueIds";
import { buildExpectedResult as expectedResultFor } from "@/lib/goalPlanning/taskCompiler";
import { normalizeExecutionKind, normalizeTaskResultViewKind } from "@/types/kiki";
import type {
  ExecutionKind,
  ExecutionPayload,
  Goal,
  GoalBreakdownDraft,
  InteractionRequirement,
  Task,
  TaskCollaborationRequirements,
  TaskExecutionStep,
  TaskInstance,
} from "@/types/kiki";

function nowIso() {
  return new Date().toISOString();
}

function payloadFor(): ExecutionPayload {
  return { kind: "generic_result", summary: "" };
}

function collaborationFor(_kind: ExecutionKind, description: string, expectedOutcome: string): TaskCollaborationRequirements {
  return {
    mode: "agent_autonomous",
    agentResponsibilities: [description, "自主完成并沉淀结果"],
    userResponsibilities: [],
    userInteractionType: "none",
    userInteractionTiming: "not_required",
    userFacingActionLabel: "查看结果",
    shouldNotifyUser: false,
    completionOwner: "agent",
    completionDefinition: expectedOutcome,
  };
}

function buildInitialTimeline(
  taskId: string,
  createdAt: string,
  status: TaskInstance["status"],
  intro: string,
): TaskExecutionStep[] {
  const phaseStatus =
    status === "pending"
      ? "pending"
      : status === "awaiting_user"
        ? "awaiting_user"
        : status === "completed"
          ? "completed"
          : status === "in_progress"
            ? "running"
            : "failed";
  return [
    {
      id: `${taskId}-phase-queued`,
      title: "任务进入队列",
      type: "phase",
      status: status === "pending" ? "running" : "completed",
      detail: "调度器已生成任务实例，等待 Agent 接手。",
      startedAt: createdAt,
      finishedAt: status === "pending" ? undefined : createdAt,
    },
    {
      id: `${taskId}-phase-main`,
      title:
        status === "completed"
          ? "Agent 已完成执行"
          : status === "awaiting_user"
            ? "Agent 等待用户参与"
            : status === "in_progress"
              ? "Agent 正在执行"
              : "Agent 执行暂停",
      type: "phase",
      status: phaseStatus,
      detail: intro,
      startedAt: createdAt,
      finishedAt: status === "completed" ? createdAt : undefined,
    },
  ];
}

export function interactionRequirementFor(kind: ExecutionKind, reason: string): InteractionRequirement {
  const collaboration = collaborationFor(kind, reason, reason);
  const type =
    collaboration.userInteractionType === "perform_offline_action"
      ? "perform_offline_action"
      : collaboration.userInteractionType;
  return {
    type,
    timing: collaboration.userInteractionTiming,
    reason,
    suggestedActions:
      type === "answer"
        ? ["开始作答", "查看练习内容"]
        : type === "confirm"
          ? ["确认结果", "提出修改建议"]
          : type === "provide_context"
            ? ["补充信息"]
            : undefined,
    shouldNotifyUser: collaboration.shouldNotifyUser,
  };
}

function scopedDraftTaskKey(subGoalId: string, taskId: string) {
  return `${subGoalId}:${taskId}`;
}

function buildTaskIdResolver(draft: GoalBreakdownDraft) {
  const idCounts = new Map<string, number>();
  for (const subGoal of draft.subGoals) {
    for (const taskItem of subGoal.tasks) {
      idCounts.set(taskItem.id, (idCounts.get(taskItem.id) ?? 0) + 1);
    }
  }

  const taskIdMap = new Map<string, string>();
  for (const subGoal of draft.subGoals) {
    for (const taskItem of subGoal.tasks) {
      const hasDuplicateDraftId = (idCounts.get(taskItem.id) ?? 0) > 1;
      const mapKey = hasDuplicateDraftId ? scopedDraftTaskKey(subGoal.id, taskItem.id) : taskItem.id;
      taskIdMap.set(mapKey, createOpaqueId("task"));
    }
  }

  const resolveTaskId = (subGoalId: string, taskId: string) =>
    taskIdMap.get(scopedDraftTaskKey(subGoalId, taskId)) ?? taskIdMap.get(taskId);

  return { resolveTaskId };
}

function warnUnresolvedTaskDependency(input: {
  draft: GoalBreakdownDraft;
  subGoalId: string;
  taskId: string;
  dependencyId: string;
}) {
  if (process.env.NODE_ENV !== "development") return;
  console.warn("[goalFactory] Dropped unresolved task dependency", {
    goalTitle: input.draft.goalTitle,
    subGoalId: input.subGoalId,
    taskId: input.taskId,
    dependencyId: input.dependencyId,
  });
}

export function buildGoalFromDraft(draft: GoalBreakdownDraft): Goal {
  const goalId = createOpaqueId("goal");
  const createdAt = nowIso();
  const subGoalIdMap = new Map(draft.subGoals.map((subGoal) => [subGoal.id, createOpaqueId("sg")]));
  const { resolveTaskId } = buildTaskIdResolver(draft);

  return {
    id: goalId,
    title: draft.goalTitle,
    deadline: draft.deadline || "",
    progress: 0,
    createdAt,
    kind: "collab",
    summary: draft.summary,
    subGoals: draft.subGoals.map((subGoal) => ({
      id: subGoalIdMap.get(subGoal.id) ?? createOpaqueId("sg"),
      goalId,
      title: subGoal.title,
      description: subGoal.description,
      reviewInterval: subGoal.reviewInterval,
      terminationCondition: subGoal.terminationCondition,
      why: subGoal.why,
      priority: subGoal.priority,
      dependencies: subGoal.dependencies?.map((dependencyId) => subGoalIdMap.get(dependencyId) ?? dependencyId),
      estimatedDurationMinutes: subGoal.estimatedDurationMinutes,
      successCriteria: subGoal.successCriteria,
      tasks: subGoal.tasks.map((taskItem) => {
        const executionKind = normalizeExecutionKind(taskItem.executionKind);
        return {
          id: resolveTaskId(subGoal.id, taskItem.id) ?? createOpaqueId("task"),
          subGoalId: subGoalIdMap.get(subGoal.id) ?? createOpaqueId("sg"),
          title: taskItem.title,
          description: taskItem.description,
          expectedOutcome: taskItem.expectedOutcome,
          taskType: taskItem.taskType,
          triggerRule: taskItem.triggerRule,
          deadline: draft.deadline || "",
          progress: 0,
          instances: [],
          executionKind,
          resultViewKind: normalizeTaskResultViewKind(taskItem.resultViewKind ?? executionKind),
          executionStrategy: taskItem.executionStrategy ?? "agent_autonomous",
          priority: taskItem.priority,
          dependencies: taskItem.dependencies
            ?.map((dependencyId) => {
              const resolvedDependencyId = resolveTaskId(subGoal.id, dependencyId);
              if (!resolvedDependencyId) {
                warnUnresolvedTaskDependency({
                  draft,
                  subGoalId: subGoal.id,
                  taskId: taskItem.id,
                  dependencyId,
                });
              }
              return resolvedDependencyId;
            })
            .filter((dependencyId): dependencyId is string => Boolean(dependencyId)),
          executionMode: taskItem.executionMode,
          expectedResult: taskItem.expectedResult ?? expectedResultFor(executionKind, taskItem.expectedOutcome, taskItem.description),
          executionObjective: taskItem.executionObjective ?? taskItem.description,
          recommendedWorkingDirectory: taskItem.recommendedWorkingDirectory,
          autoRunDisabled: taskItem.autoRunDisabled,
          requiresConfirmation: taskItem.requiresConfirmation,
          collaboration:
            taskItem.collaboration ??
            collaborationFor(executionKind, taskItem.description, taskItem.expectedOutcome),
          taskSpec: taskItem.taskSpec,
        } satisfies Task;
      }),
    })),
  };
}

export function createGeneratedInstance(task: Task, createdAt: string): TaskInstance {
  const date = new Date(createdAt);
  const dateLabel = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return {
    id: createOpaqueId("inst"),
    taskId: task.id,
    dateLabel,
    status: "pending",
    intro: `到了 ${task.triggerRule} 的触发时间，KiKi 已自动排队执行“${task.title.replace(/^任务\d+：/, "")}”。`,
    payload: payloadFor(),
    createdAt,
    runner: {
      attemptCount: 0,
    },
    execution: {
      phase: "queued",
      status: "pending",
      lastUpdatedAt: createdAt,
    },
    timeline: buildInitialTimeline(task.id, createdAt, "pending", "等待 Agent 开始执行。"),
  };
}
