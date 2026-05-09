import { sleep } from "@/lib/utils";
import { getGoalById, useGoalStore } from "@/stores/goalStore";
import type { CollectedInfoSummary, GoalBreakdownDraft } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

export async function getGoals() {
  await sleep();
  return useGoalStore.getState().goals;
}

export async function getGoal(goalId: string) {
  await sleep();
  return getGoalById(goalId) ?? null;
}

export async function generateGoalPlan(input: {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  conversationContext?: string;
  collectedInfo?: string;
  signal?: AbortSignal;
}): Promise<GoalBreakdownDraft> {
  const { signal, ...body } = input;
  const response = await fetch("/api/goals/plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json()) as { draft?: GoalBreakdownDraft; reason?: string };

  if (!response.ok || !data.draft) {
    throw new Error(data.reason || "目标规划生成失败");
  }

  return data.draft;
}

export async function generateGoalClarificationQuestions(input: {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  conversationContext?: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const { signal, ...body } = input;
  const response = await fetch("/api/goals/clarify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json()) as { questions?: string[]; reason?: string };

  if (!response.ok || !data.questions?.length) {
    throw new Error(data.reason || "目标澄清问题生成失败");
  }

  return data.questions;
}

export type GoalInfoCollectionTurnInput = {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  conversationContext?: string;
  history: Array<{
    questions: string[];
    answer?: string;
  }>;
  minRounds?: number;
  maxRounds?: number;
  signal?: AbortSignal;
};

export type GoalInfoCollectionTurnResult = {
  status: "continue" | "complete";
  assistantMessage: string;
  questions?: string[];
  summary?: CollectedInfoSummary;
};

export async function advanceGoalInfoCollection(input: GoalInfoCollectionTurnInput) {
  const { signal, ...body } = input;
  const response = await fetch("/api/goals/collect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json()) as GoalInfoCollectionTurnResult & { reason?: string };

  if (!response.ok || !data.status || !data.assistantMessage) {
    throw new Error(data.reason || "目标信息收集失败");
  }

  if (data.status === "continue" && !data.questions?.length) {
    throw new Error("目标信息收集缺少后续问题");
  }

  return data;
}
