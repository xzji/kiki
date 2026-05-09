"use client";

import { advanceGoalInfoCollection, generateGoalPlan } from "@/lib/api/goals";
import { useEasterEggSettingsStore } from "@/stores/easterEggSettingsStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useGoalStore } from "@/stores/goalStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type {
  CollectedInfoSummary,
  GoalInfoCollection,
  GoalInfoCollectionRound,
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

function assertClaudeRuntime() {
  const runtimeEnv = useRuntimeEnvStore.getState().getActiveEnvironment();
  if (!runtimeEnv || runtimeEnv.type !== "local") {
    throw new Error("当前没有可用的本地 Claude 环境，请先到设置 -> 运行环境完成连接。");
  }
  if ((runtimeEnv.runtimeKind || "claude") !== "claude") {
    throw new Error("当前目标规划暂只支持 Claude CLI。请在运行环境中切换到 Claude CLI。");
  }
  if (runtimeEnv.health?.status !== "online") {
    throw new Error("当前本地 Claude 环境离线，请先在设置里重新检测连接状态。");
  }
  return runtimeEnv;
}

function buildConversationContext(conversationId?: string) {
  if (!conversationId) return undefined;
  const conversation = useConversationStore.getState().conversations.find((item) => item.id === conversationId);
  if (!conversation) return undefined;
  const recent = conversation.messages.slice(-8);
  if (!recent.length) return undefined;
  return recent
    .map((message) => `${message.role === "user" ? "用户" : "KiKi"}：${message.content}`)
    .join("\n");
}

function getOrCreateGoalConversation(goalText: string, conversationId?: string) {
  const conversationStore = useConversationStore.getState();
  if (conversationId != null) {
    return (
      conversationStore.conversations.find((item) => item.id === conversationId) ??
      conversationStore.createConversation(goalText.slice(0, 24) || "新目标")
    );
  }
  return conversationStore.createConversation(goalText.slice(0, 24) || "新目标");
}

function createInfoCollectionRound(
  questions: string[],
  askedAt = new Date().toISOString(),
): GoalInfoCollectionRound {
  return {
    id: `goal-info-round-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    questions,
    askedAt,
  };
}

function serializeCollectionHistory(rounds: GoalInfoCollectionRound[]) {
  return rounds.map((round) => ({
    questions: round.questions,
    answer: round.answer?.trim(),
  }));
}

function buildCollectedInfoTranscript(rounds: GoalInfoCollectionRound[]) {
  return rounds
    .filter((round) => round.answer?.trim())
    .map((round, index) =>
      [
        `第 ${index + 1} 轮澄清问题：`,
        ...round.questions.map((question, questionIndex) => `${questionIndex + 1}. ${question}`),
        "",
        "用户回答：",
        round.answer?.trim() || "",
      ].join("\n"),
    )
    .join("\n\n");
}

function mergeCollectedInfoSummary(
  current: CollectedInfoSummary | undefined,
  incoming: CollectedInfoSummary | undefined,
): CollectedInfoSummary | undefined {
  if (!incoming) return current;
  return {
    goalDetails: incoming.goalDetails || current?.goalDetails,
    timeline: incoming.timeline || current?.timeline,
    resources: incoming.resources || current?.resources,
    constraints: incoming.constraints || current?.constraints,
    challenges: incoming.challenges || current?.challenges,
    preferences: incoming.preferences || current?.preferences,
    summary: incoming.summary || current?.summary,
  };
}

async function runGoalPlanning(input: {
  goalText: string;
  conversationId: string;
  summary?: CollectedInfoSummary;
  signal?: AbortSignal;
  onProgress?: (progress: GoalWorkflowProgress) => void;
}) {
  const runtimeEnv = assertClaudeRuntime();
  const goalConfig = useEasterEggSettingsStore.getState().getSettings();
  const conversationStore = useConversationStore.getState();
  const goalStore = useGoalStore.getState();
  const conversation = conversationStore.conversations.find((item) => item.id === input.conversationId);
  const collection = conversation?.goalInfoCollection;

  input.onProgress?.({ phase: "decomposing", message: "正在拆解子目标..." });
  input.onProgress?.({ phase: "generating_tasks", message: "正在生成任务计划..." });
  const draft = await generateGoalPlan({
    goalText: input.goalText,
    runtimeEnv,
    config: goalConfig,
    conversationId: input.conversationId,
    conversationContext: buildConversationContext(input.conversationId),
    collectedInfo: collection ? buildCollectedInfoTranscript(collection.rounds) : undefined,
    signal: input.signal,
  });

  if (input.summary) {
    draft.collectedInfoSummary = mergeCollectedInfoSummary(draft.collectedInfoSummary, input.summary);
  }

  input.onProgress?.({ phase: "reviewing_tasks", message: "正在检查任务覆盖度..." });
  const goal = goalStore.createGoalFromDraft(draft, { conversationId: input.conversationId });
  conversationStore.setGoalForConversation(input.conversationId, goal.id);
  conversationStore.renameConversation(input.conversationId, draft.goalTitle);
  conversationStore.setGoalInfoCollection(input.conversationId, null);
  input.onProgress?.({ phase: "presenting_plan", message: "目标规划草案已生成，等待你确认启动。" });

  return {
    goalId: goal.id,
    conversationId: input.conversationId,
    goalTitle: draft.goalTitle,
    summary: draft.summary,
    subGoalCount: draft.subGoals.length,
    taskCount: draft.subGoals.reduce((sum, subGoal) => sum + subGoal.tasks.length, 0),
  } satisfies GoalWorkflowResult;
}

export async function startGoalWorkflow(input: {
  goalText: string;
  source: "assistant-sidebar" | "conversation";
  conversationId?: string;
  collectedInfo?: string;
  signal?: AbortSignal;
  onProgress?: (progress: GoalWorkflowProgress) => void;
}): Promise<GoalWorkflowResult> {
  const goalText = input.goalText.trim();
  if (!goalText) {
    throw new Error("请输入目标内容，例如 /goal 三个月内托福达到 110 分");
  }

  const conversation = getOrCreateGoalConversation(goalText, input.conversationId);
  return runGoalPlanning({
    goalText,
    conversationId: conversation.id,
    signal: input.signal,
    onProgress: input.onProgress,
  });
}

export async function startGoalInfoCollection(input: {
  goalText: string;
  source: "assistant-sidebar" | "conversation";
  conversationId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: GoalWorkflowProgress) => void;
}): Promise<GoalInfoCollectionResult> {
  const goalText = input.goalText.trim();
  if (!goalText) {
    throw new Error("请输入目标内容，例如 /goal 三个月内托福达到 110 分");
  }

  const runtimeEnv = assertClaudeRuntime();
  const goalConfig = useEasterEggSettingsStore.getState().getSettings();
  const conversationStore = useConversationStore.getState();

  input.onProgress?.({ phase: "collecting_info", message: "正在准备几个关键澄清问题..." });
  const conversation = getOrCreateGoalConversation(goalText, input.conversationId);

  const result = await advanceGoalInfoCollection({
    goalText,
    runtimeEnv,
    config: goalConfig,
    conversationId: conversation.id,
    conversationContext: buildConversationContext(conversation.id),
    history: [],
    minRounds: goalConfig.minInfoCollectionRounds,
    maxRounds: goalConfig.maxInfoCollectionRounds,
    signal: input.signal,
  });

  if (result.status !== "continue" || !result.questions?.length) {
    throw new Error("首轮信息收集未返回可提问的问题");
  }

  const now = new Date().toISOString();
  const collection: GoalInfoCollection = {
    goalText,
    status: "awaiting_user",
    rounds: [createInfoCollectionRound(result.questions, now)],
    currentRound: 1,
    minRounds: goalConfig.minInfoCollectionRounds,
    maxRounds: goalConfig.maxInfoCollectionRounds,
    startedAt: now,
    updatedAt: now,
    assistantMessage: result.assistantMessage,
  };
  conversationStore.setGoalInfoCollection(conversation.id, collection);

  return {
    conversationId: conversation.id,
    collection,
    assistantMessage: result.assistantMessage,
  };
}

export async function continueGoalWorkflowAfterInfo(input: {
  answer: string;
  source: "assistant-sidebar" | "conversation";
  conversationId: string;
  signal?: AbortSignal;
  onProgress?: (progress: GoalWorkflowProgress) => void;
}): Promise<GoalInfoCollectionStepResult> {
  const answer = input.answer.trim();
  if (!answer) {
    throw new Error("请先回答澄清问题后再继续。");
  }

  const runtimeEnv = assertClaudeRuntime();
  const goalConfig = useEasterEggSettingsStore.getState().getSettings();
  const conversationStore = useConversationStore.getState();
  const conversation = conversationStore.conversations.find((item) => item.id === input.conversationId);
  const collection = conversation?.goalInfoCollection;
  if (!conversation || !collection || collection.rounds.length === 0) {
    throw new Error("当前没有待补充信息的目标，请重新使用 /goal 发起。");
  }

  const pendingRound = collection.rounds[collection.rounds.length - 1];
  const answeredAt = new Date().toISOString();
  const answeredRounds: GoalInfoCollectionRound[] = [
    ...collection.rounds.slice(0, -1),
    {
      ...pendingRound,
      answer,
      answeredAt,
    },
  ];

  conversationStore.setGoalInfoCollection(input.conversationId, {
    ...collection,
    status: "processing",
    updatedAt: answeredAt,
  });
  input.onProgress?.({ phase: "collecting_info", message: "正在整理你刚补充的背景信息..." });

  const decision = await advanceGoalInfoCollection({
    goalText: collection.goalText,
    runtimeEnv,
    config: goalConfig,
    conversationId: input.conversationId,
    conversationContext: buildConversationContext(input.conversationId),
    history: serializeCollectionHistory(answeredRounds),
    minRounds: collection.minRounds,
    maxRounds: collection.maxRounds,
    signal: input.signal,
  });

  const mergedSummary = mergeCollectedInfoSummary(collection.summary, decision.summary);

  if (decision.status === "continue" && decision.questions?.length) {
    const nextCollection: GoalInfoCollection = {
      ...collection,
      status: "awaiting_user",
      rounds: [...answeredRounds, createInfoCollectionRound(decision.questions)],
      currentRound: answeredRounds.length + 1,
      updatedAt: new Date().toISOString(),
      summary: mergedSummary,
      assistantMessage: decision.assistantMessage,
    };
    conversationStore.setGoalInfoCollection(input.conversationId, nextCollection);
    return {
      kind: "collecting_info",
      conversationId: input.conversationId,
      collection: nextCollection,
      assistantMessage: decision.assistantMessage,
    };
  }

  const readyCollection: GoalInfoCollection = {
    ...collection,
    status: "ready_for_planning",
    rounds: answeredRounds,
    currentRound: answeredRounds.length,
    updatedAt: new Date().toISOString(),
    summary: mergedSummary,
    assistantMessage: decision.assistantMessage,
  };
  conversationStore.setGoalInfoCollection(input.conversationId, readyCollection);
  input.onProgress?.({
    phase: "collecting_info",
    message: decision.assistantMessage || "信息已经足够，开始生成目标规划...",
  });

  return {
    kind: "planned",
    ...(await runGoalPlanning({
      goalText: collection.goalText,
      conversationId: input.conversationId,
      summary: mergedSummary,
      signal: input.signal,
      onProgress: input.onProgress,
    })),
  };
}
