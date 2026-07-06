"use client";

import { replaceTopicPlanCommand } from "@/lib/api/topics";
import { writeConversationContextApi } from "@/lib/api/conversationWorkspace";
import { createGoalCommand } from "@/lib/api/goal-commands";
import { buildGoalFromDraft } from "@/lib/goalFactory";
import { useConversationStore } from "@/stores/conversationStore";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import type {
  Goal,
  GoalBreakdownDraft,
  GoalInfoCollection,
  GoalWorkflow,
  GoalWorkflowPhase,
} from "@/types/kiki";

export type GoalWorkflowProgress = {
  phase: GoalWorkflowPhase;
  message: string;
};

export type GoalWorkflowResult = {
  goalId: string;
  conversationId: string;
  goalTitle: string;
  summary?: string;
  subGoalCount: number;
  taskCount: number;
};

export type GoalInfoCollectionResult = {
  conversationId: string;
  collection: GoalInfoCollection;
  assistantMessage: string;
};

export type GoalInfoCollectionStepResult =
  | {
      kind: "collecting_info";
      conversationId: string;
      collection: GoalInfoCollection;
      assistantMessage: string;
    }
  | ({
      kind: "planned";
    } & GoalWorkflowResult);


async function writeCurrentConversationContext(conversationId: string, goalId?: string) {
  const conversation = useConversationStore.getState().conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  const goal = goalId
    ? selectVisibleGoals(useGoalStore.getState()).find((item) => item.id === goalId) ?? null
    : null;
  await writeConversationContextApi({ conversation, goal }).catch(() => undefined);
}



function clearPlanningFailure(conversationId: string) {
  useConversationStore.getState().setPlanningRunState(conversationId, null);
  void writeCurrentConversationContext(conversationId);
}

export async function commitGoalDraftToStores(input: {
  conversationId: string;
  draft: GoalBreakdownDraft;
}): Promise<GoalWorkflowResult> {
  const conversationStore = useConversationStore.getState();
  const goalStore = useGoalStore.getState();
  const base = buildGoalFromDraft(input.draft);
  const now = new Date().toISOString();
  const deliveryContract = input.draft.deliveryContract ?? input.draft.goalAnalysis?.deliveryContract;
  const workflow: GoalWorkflow = {
    phase: "presenting_plan",
    planDecision: "pending",
    collectedInfo: {
      collectedInfoSummary: input.draft.collectedInfoSummary,
      goalAnalysis: input.draft.goalAnalysis,
      deliveryContract,
      executionOrder: input.draft.executionOrder,
      reviewSummary: input.draft.reviewSummary,
    },
    assumptions: input.draft.assumptions,
    risks: input.draft.risks,
    reasoning: input.draft.reasoning,
    notificationStrategy: input.draft.notificationStrategy,
    startedAt: now,
    updatedAt: now,
  };
  const goal = {
    ...base,
    title: input.draft.goalTitle,
    summary: input.draft.summary,
    deadline: input.draft.deadline || base.deadline,
    deliveryContract,
    conversationId: input.conversationId,
    workflow,
  };
  const result = await createGoalCommand({ goal, baseRevision: goalStore.goalProjectionRevision });
  goalStore.applyGoalsProjection(result.goals, result.revision);
  conversationStore.setGoalForConversation(input.conversationId, goal.id);
  conversationStore.renameConversation(input.conversationId, input.draft.goalTitle);
  conversationStore.setGoalInfoCollection(input.conversationId, null);
  clearPlanningFailure(input.conversationId);
  await writeCurrentConversationContext(input.conversationId, goal.id);
  return {
    goalId: goal.id,
    conversationId: input.conversationId,
    goalTitle: input.draft.goalTitle,
    summary: input.draft.summary,
    subGoalCount: input.draft.subGoals.length,
    taskCount: input.draft.subGoals.reduce((sum, subGoal) => sum + subGoal.tasks.length, 0),
  };
}

function hasTaskInstances(goal: Goal) {
  return goal.subGoals.some((subGoal) => subGoal.tasks.some((task) => task.instances.length > 0));
}

function revisionHistoryFrom(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

export async function replaceGoalDraftInStores(input: {
  goal: Goal;
  draft: GoalBreakdownDraft;
  revisionFeedback: string;
  baseRevision?: number;
  idempotencyKey?: string;
}): Promise<GoalWorkflowResult> {
  if (input.goal.workflow?.planDecision === "confirmed") {
    throw new Error("已确认规划请通过任务治理修改");
  }
  if (hasTaskInstances(input.goal)) {
    throw new Error("已有执行记录的主题规划不能整体替换，请通过任务治理修改");
  }

  const conversationStore = useConversationStore.getState();
  const goalStore = useGoalStore.getState();
  const base = buildGoalFromDraft(input.draft);
  const now = new Date().toISOString();
  const deliveryContract = input.draft.deliveryContract ?? input.draft.goalAnalysis?.deliveryContract;
  const previousCollectedInfo = input.goal.workflow?.collectedInfo ?? {};
  const revisionHistory = [
    {
      feedback: input.revisionFeedback,
      requestedAt: now,
      previousWorkflowUpdatedAt: input.goal.workflow?.updatedAt,
    },
    ...revisionHistoryFrom(previousCollectedInfo.revisionHistory),
  ].slice(0, 5);
  const workflow: GoalWorkflow = {
    phase: "presenting_plan",
    planDecision: "pending",
    collectedInfo: {
      collectedInfoSummary: input.draft.collectedInfoSummary,
      goalAnalysis: input.draft.goalAnalysis,
      deliveryContract,
      executionOrder: input.draft.executionOrder,
      reviewSummary: input.draft.reviewSummary,
      revisionFeedback: input.revisionFeedback,
      previousWorkflowUpdatedAt: input.goal.workflow?.updatedAt,
      revisionHistory,
    },
    assumptions: input.draft.assumptions,
    risks: input.draft.risks,
    reasoning: input.draft.reasoning,
    notificationStrategy: input.draft.notificationStrategy,
    startedAt: input.goal.workflow?.startedAt ?? now,
    updatedAt: now,
  };
  const goal: Goal = {
    ...base,
    id: input.goal.id,
    title: input.draft.goalTitle,
    summary: input.draft.summary,
    deadline: input.draft.deadline || base.deadline,
    deliveryContract,
    createdAt: input.goal.createdAt,
    conversationId: input.goal.conversationId,
    kind: input.goal.kind,
    progress: 0,
    workflow,
    subGoals: base.subGoals.map((subGoal) => ({
      ...subGoal,
      goalId: input.goal.id,
      tasks: subGoal.tasks.map((task) => ({
        ...task,
        progress: 0,
        instances: [],
      })),
    })),
  };
  const result = await replaceTopicPlanCommand({
    topic: goal,
    baseRevision: input.baseRevision ?? goalStore.goalProjectionRevision,
    idempotencyKey:
      input.idempotencyKey ??
      `topic.replace_plan:${input.goal.id}:${now}:${Math.random().toString(36).slice(2, 8)}`,
  });
  goalStore.applyGoalsProjection(result.goals, result.revision);
  if (input.goal.conversationId) {
    conversationStore.setGoalForConversation(input.goal.conversationId, input.goal.id);
    conversationStore.renameConversation(input.goal.conversationId, input.draft.goalTitle);
    await writeCurrentConversationContext(input.goal.conversationId, input.goal.id);
  }
  return {
    goalId: input.goal.id,
    conversationId: input.goal.conversationId ?? "",
    goalTitle: input.draft.goalTitle,
    summary: input.draft.summary,
    subGoalCount: input.draft.subGoals.length,
    taskCount: input.draft.subGoals.reduce((sum, subGoal) => sum + subGoal.tasks.length, 0),
  };
}
