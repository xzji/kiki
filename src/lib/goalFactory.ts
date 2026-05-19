import { createOpaqueId, deriveOpaqueId } from "@/lib/opaqueIds";
import type {
  ExecutionKind,
  ExecutionPayload,
  Goal,
  GoalBreakdownDraft,
  InteractionRequirement,
  Task,
  TaskCollaborationRequirements,
  TaskExpectedResult,
  TaskExecutionStep,
  TaskInstance,
} from "@/types/kiki";

function nowIso() {
  return new Date().toISOString();
}

function payloadFor(kind: ExecutionKind): ExecutionPayload {
  switch (kind) {
    case "flashcard":
      return { kind, cards: [] };
    case "listening_qa":
      return { kind, audioUrl: "", questions: [] };
    case "reading_digest":
      return { kind, articles: [] };
    case "confirm_action":
      return { kind, summary: "", options: [] };
    case "draft_review":
      return { kind, drafts: [] };
    case "freeform_chat":
      return { kind, seed: "" };
    case "generic_result":
      return { kind, summary: "" };
  }
}

function collaborationFor(kind: ExecutionKind, description: string, expectedOutcome: string): TaskCollaborationRequirements {
  if (kind === "flashcard" || kind === "listening_qa" || kind === "freeform_chat") {
    return {
      mode: "agent_user_collaborative",
      agentResponsibilities: [description, "准备练习内容并给出反馈"],
      userResponsibilities: ["完成作答或互动"],
      userInteractionType: "answer",
      userInteractionTiming: "core_task_step",
      userFacingActionLabel: "开始作答",
      shouldNotifyUser: true,
      completionOwner: "shared",
      completionDefinition: expectedOutcome,
    };
  }
  if (kind === "confirm_action" || kind === "draft_review") {
    return {
      mode: "agent_with_user_confirmation",
      agentResponsibilities: [description, "生成可供用户确认或修改的方案"],
      userResponsibilities: ["确认结果或提出修改建议"],
      userInteractionType: "confirm",
      userInteractionTiming: "after_agent_output",
      userFacingActionLabel: "确认或提出修改建议",
      shouldNotifyUser: true,
      completionOwner: "agent",
      completionDefinition: expectedOutcome,
    };
  }
  return {
    mode: "agent_autonomous",
    agentResponsibilities: [description, "自主完成并沉淀结果"],
    userResponsibilities: [],
    userInteractionType: "none",
    userInteractionTiming: "not_required",
    userFacingActionLabel: "查看结果",
    shouldNotifyUser: kind === "reading_digest",
    completionOwner: "agent",
    completionDefinition: expectedOutcome,
  };
}

function expectedResultFor(kind: ExecutionKind, expectedOutcome: string, description: string): TaskExpectedResult {
  const text = `${expectedOutcome}\n${description}`;
  const requiredBlocks: NonNullable<TaskExpectedResult["requiredBlocks"]> = ["heading"];
  if (/对比|比较|表|矩阵|维度/.test(text)) requiredBlocks.push("comparison_table");
  if (/清单|步骤|计划|训练|复盘|词汇|摘要|精读|复述|结构图/.test(text)) requiredBlocks.push("list");
  if (!requiredBlocks.includes("comparison_table")) requiredBlocks.push("paragraph");
  requiredBlocks.push("callout");
  return {
    type: kind === "confirm_action" ? "confirmation" : "deliverable",
    description: expectedOutcome,
    format: "markdown",
    presentation: kind === "confirm_action" ? "summary_card" : "summary_card",
    primaryFormat: "structured_blocks",
    exportableFormats: ["markdown"],
    requiredBlocks: Array.from(new Set(requiredBlocks)),
    completionCriteria: expectedOutcome,
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

export function buildGoalFromDraft(draft: GoalBreakdownDraft): Goal {
  const goalId = createOpaqueId("goal");
  const createdAt = nowIso();
  const subGoalIdMap = new Map(draft.subGoals.map((subGoal) => [subGoal.id, createOpaqueId("sg")]));
  const taskIdMap = new Map(
    draft.subGoals.flatMap((subGoal) => subGoal.tasks.map((taskItem) => [taskItem.id, createOpaqueId("task")] as const)),
  );

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
      why: subGoal.why,
      priority: subGoal.priority,
      weight: subGoal.weight,
      dependencies: subGoal.dependencies?.map((dependencyId) => subGoalIdMap.get(dependencyId) ?? dependencyId),
      estimatedDurationMinutes: subGoal.estimatedDurationMinutes,
      successCriteria: subGoal.successCriteria,
      tasks: subGoal.tasks.map((taskItem) => {
        const executionKind = taskItem.executionKind;
        return {
          id: taskIdMap.get(taskItem.id) ?? createOpaqueId("task"),
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
          resultViewKind: taskItem.resultViewKind ?? executionKind,
          executionStrategy: taskItem.executionStrategy ?? "agent_autonomous",
          priority: taskItem.priority,
          dependencies: taskItem.dependencies?.map(
            (dependencyId) => taskIdMap.get(dependencyId) ?? deriveOpaqueId("task", dependencyId),
          ),
          executionMode: taskItem.executionMode,
          expectedResult: taskItem.expectedResult ?? expectedResultFor(executionKind, taskItem.expectedOutcome, taskItem.description),
          executionObjective: taskItem.executionObjective ?? taskItem.description,
          recommendedWorkingDirectory: taskItem.recommendedWorkingDirectory,
          autoRunDisabled: taskItem.autoRunDisabled,
          requiresConfirmation: taskItem.requiresConfirmation,
          collaboration:
            taskItem.collaboration ??
            collaborationFor(taskItem.resultViewKind ?? executionKind, taskItem.description, taskItem.expectedOutcome),
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
    payload: payloadFor(task.resultViewKind ?? task.executionKind),
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
