/**
 * topicInitSaga — Topic 初始化 5 角色 Saga 编排器。
 *
 * Plan ref: §3.1.4 + §9.5（决策/展示拆分 + Critic↔Refiner 循环）。
 *
 * 角色顺序：
 *   1. Interviewer  → 决定是否还需要继续问用户（awaiting_user 暂停）
 *   2. Planner      → 生成 SubGoal/Task 草稿
 *   3. Critic       → 评审草稿，决定 accept / needs_refinement / reject
 *   4. Refiner      → 仅当 Critic 标记 needs_refinement 时调用，修正后回到 Critic 重审
 *                     （最多 maxRefineLoops 次，超限走 forced_accept）
 *   5. Presenter    → 生成最终展示摘要（goalTitle / summary / notificationStrategy / deadline?）
 *
 * 设计取舍：
 * - 5 个 invoke 通过参数注入（claudeJsonInvoke / 测试 mock 自由切换），本编排器不直接 import transport
 * - 每个角色一个 agent_run + 一组 events，由 agentExecutor 统一管理生命周期
 * - 每完成一步即 advanceSaga 到下一 currentStep，保证可中断 + resumable
 * - Refiner 缺失 LLM 实现（PR9b 占位）时由调用方传 noopRefinerInvoke 走确定性 fallback
 */

import { createAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { findSagaInstanceById } from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";
import type { SagaInstance } from "@/types/agentRuntime";

import { executeAgentRun, type LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import { runSpecWriter } from "@/lib/server/taskExecution/runSpecWriter";
import type { SpecWriterTaskInput } from "@/lib/server/taskExecution/taskSpecPrompt";
import {
  advanceSaga,
  markAwaitingUser,
  markCompleted,
  markFailed,
} from "@/lib/server/agentRuntime/sagaCoordinator";

export type TopicInitSagaStep =
  | "interview"
  | "plan"
  | "critic"
  | "refine"
  | "spec"
  | "present"
  | "completed";

export type CriticDecisionPayload = {
  /** Decision verdict; "accept" advances to Presenter, others trigger Refiner loop. */
  verdict: "accept" | "needs_refinement" | "reject";
  notes?: string;
};

export type InterviewerDecisionPayload = {
  /** When set, saga pauses and surfaces these to the user via awaiting_user event. */
  needsUserInput?: string[];
  /** Otherwise, structured info collected so far. */
  collectedInfo?: Record<string, unknown>;
};

export type TopicInitSagaInput = {
  sagaInstanceId: string;
  topicId: string;
  goalContext?: { goalTitle: string; goalSummary?: string };
  /** Initial prompt builders, one per role. Saga is agnostic to their content. */
  prompts: {
    interview: string;
    plan: string;
    critic: (planParsed: Record<string, unknown>) => string;
    refine: (
      planParsed: Record<string, unknown>,
      criticParsed: CriticDecisionPayload,
    ) => string;
    present: (planParsed: Record<string, unknown>) => string;
  };
  /** LlmInvoke per role. Mockable in tests. */
  invokes: {
    interview: LlmInvoke;
    plan: LlmInvoke;
    critic: LlmInvoke;
    refine: LlmInvoke;
    spec: LlmInvoke;
    present: LlmInvoke;
  };
  /** Cap Critic↔Refiner loops to avoid runaway saga. Default 2. */
  maxRefineLoops?: number;
};

export type TopicInitSagaResult = {
  saga: SagaInstance;
  status: "completed" | "awaiting_user" | "failed";
  awaitingQuestions?: string[];
  errorMessage?: string;
  failedAgentRunId?: string;
  failedStep?: TopicInitSagaStep;
  /** Final parsed payloads keyed by role. Only populated on success / partial. */
  artifacts: {
    interview?: Record<string, unknown>;
    plan?: Record<string, unknown>;
    critic?: CriticDecisionPayload;
    refinedPlan?: Record<string, unknown>;
    specs?: Record<string, string>;
    presentation?: Record<string, unknown>;
  };
  /** Number of Critic↔Refiner loops actually executed (0 means accept on first review). */
  refineLoops: number;
  /** Set when maxRefineLoops was hit and we forced acceptance. */
  forcedAccept?: boolean;
};

export const DEFAULT_MAX_REFINE_LOOPS = 2;

class SagaRoleError extends Error {
  agentRunId: string;
  role: "interviewer" | "planner" | "critic" | "refiner" | "presenter";

  constructor(input: {
    role: SagaRoleError["role"];
    agentRunId: string;
    cause: unknown;
  }) {
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(message);
    this.name = "SagaRoleError";
    this.agentRunId = input.agentRunId;
    this.role = input.role;
    this.cause = input.cause;
  }
}

function asInterviewerDecision(value: unknown): InterviewerDecisionPayload {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const out: InterviewerDecisionPayload = {};
  if (Array.isArray(v.needsUserInput)) {
    out.needsUserInput = v.needsUserInput.filter((q): q is string => typeof q === "string" && q.trim().length > 0);
  }
  if (v.collectedInfo && typeof v.collectedInfo === "object") {
    out.collectedInfo = v.collectedInfo as Record<string, unknown>;
  }
  return out;
}

function asCriticDecision(value: unknown): CriticDecisionPayload {
  if (!value || typeof value !== "object") {
    return { verdict: "needs_refinement", notes: "critic returned non-object payload" };
  }
  const v = value as Record<string, unknown>;
  const verdict =
    v.verdict === "accept" || v.verdict === "needs_refinement" || v.verdict === "reject"
      ? v.verdict
      : "needs_refinement";
  return {
    verdict,
    notes: typeof v.notes === "string" ? v.notes : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractSpecTasksFromPlan(planParsed: Record<string, unknown>): SpecWriterTaskInput[] {
  const subGoals = planParsed.subGoals ?? planParsed.threads;
  if (!Array.isArray(subGoals)) return [];
  return subGoals.flatMap((subGoal, subGoalIndex) => {
    const subGoalRecord = asRecord(subGoal) ?? {};
    const subGoalId = String(subGoalRecord.id ?? subGoalIndex + 1);
    const tasks = Array.isArray(subGoalRecord.tasks) ? subGoalRecord.tasks : [];
    return tasks.flatMap((task, taskIndex) => {
      const record = asRecord(task) ?? {};
      const rawTaskId = String(record.id ?? record.index ?? taskIndex + 1);
      const title = readString(record.title) ?? `任务 ${taskIndex + 1}`;
      const description = readString(record.description) ?? readString(record.objective) ?? title;
      const expectedOutcome = readString(record.expectedOutcome) ?? readString(record.deliverable) ?? description;
      const triggerRule =
        readString(record.triggerRule) ??
        readString(record.cadence) ??
        (readString(record.triggerCondition) ? `满足条件：${readString(record.triggerCondition)}` : undefined) ??
        "手动触发";
      return [{
        taskId: `${subGoalId}#${rawTaskId}`,
        title,
        description,
        expectedOutcome,
        taskType:
          record.taskType === "repeat" || readString(record.cadence) || readString(record.triggerCondition)
            ? "repeat"
            : "one_shot",
        triggerRule,
        expectedResult: (asRecord(record.expectedResult) as SpecWriterTaskInput["expectedResult"]) ?? undefined,
        collaboration: (asRecord(record.collaboration) as SpecWriterTaskInput["collaboration"]) ?? undefined,
      }];
    });
  });
}

function mergeRefinedPlan(
  currentPlan: Record<string, unknown>,
  refined: Record<string, unknown>,
): Record<string, unknown> {
  return { ...currentPlan, ...refined };
}

async function runRole(input: {
  topicId: string;
  sagaInstanceId: string;
  role: "interviewer" | "planner" | "critic" | "refiner" | "presenter";
  prompt: string;
  invoke: LlmInvoke;
}): Promise<Record<string, unknown> | undefined> {
  const run = createAgentRun({
    topicId: input.topicId,
    sagaInstanceId: input.sagaInstanceId,
    role: input.role,
  });
  try {
    const result = await executeAgentRun({
      agentRunId: run.id,
      prompt: input.prompt,
      context: { role: input.role, sagaInstanceId: input.sagaInstanceId },
      invoke: input.invoke,
    });
    return result.parsed;
  } catch (error) {
    throw new SagaRoleError({ role: input.role, agentRunId: run.id, cause: error });
  }
}

/**
 * Run the full Topic Init Saga end-to-end.
 *
 * Caller is responsible for:
 *  - createSagaInstance({ topicId, type: "topic_init" }) before calling
 *  - Persisting `result.artifacts.presentation` to Topic / Goal storage layer
 *
 * On `awaiting_user`, caller should surface awaitingQuestions to the user and
 * later resume by calling runTopicInitSaga again with updated prompts.
 */
export async function runTopicInitSaga(
  input: TopicInitSagaInput,
): Promise<TopicInitSagaResult> {
  const maxRefineLoops = input.maxRefineLoops ?? DEFAULT_MAX_REFINE_LOOPS;
  const artifacts: TopicInitSagaResult["artifacts"] = {};

  // --- 1. Interviewer ---
  let interviewerRunId: string | undefined;
  try {
    advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "interview" });
    const run = createAgentRun({
      topicId: input.topicId,
      sagaInstanceId: input.sagaInstanceId,
      role: "interviewer",
    });
    interviewerRunId = run.id;
    const result = await executeAgentRun({
      agentRunId: run.id,
      prompt: input.prompts.interview,
      context: { role: "interviewer", sagaInstanceId: input.sagaInstanceId },
      invoke: input.invokes.interview,
    });
    const interviewerDecision = asInterviewerDecision(result.parsed);
    artifacts.interview = result.parsed ?? {};

    if (interviewerDecision.needsUserInput && interviewerDecision.needsUserInput.length > 0) {
      const saga = markAwaitingUser(input.sagaInstanceId, {
        agentRunId: run.id,
        questions: interviewerDecision.needsUserInput,
      });
      return {
        saga: saga ?? mustFindSaga(input.sagaInstanceId),
        status: "awaiting_user",
        awaitingQuestions: interviewerDecision.needsUserInput,
        artifacts,
        refineLoops: 0,
      };
    }
  } catch (error) {
    return failSaga(input.sagaInstanceId, interviewerRunId, "interview", error, artifacts, 0);
  }

  // --- 2. Planner ---
  try {
    advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "plan" });
    artifacts.plan = await runRole({
      topicId: input.topicId,
      sagaInstanceId: input.sagaInstanceId,
      role: "planner",
      prompt: input.prompts.plan,
      invoke: input.invokes.plan,
    });
  } catch (error) {
    return failSaga(input.sagaInstanceId, getFailedAgentRunId(error), "plan", error, artifacts, 0);
  }

  // --- 3-4. Critic↔Refiner loop ---
  let refineLoops = 0;
  let forcedAccept = false;
  let currentPlan = artifacts.plan ?? {};
  let criticDecision: CriticDecisionPayload = { verdict: "needs_refinement" };

  while (refineLoops <= maxRefineLoops) {
    try {
      advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "critic" });
      const criticParsed = await runRole({
        topicId: input.topicId,
        sagaInstanceId: input.sagaInstanceId,
        role: "critic",
        prompt: input.prompts.critic(currentPlan),
        invoke: input.invokes.critic,
      });
      criticDecision = asCriticDecision(criticParsed);
      artifacts.critic = criticDecision;
    } catch (error) {
      return failSaga(input.sagaInstanceId, getFailedAgentRunId(error), "critic", error, artifacts, refineLoops);
    }

    if (criticDecision.verdict === "accept") break;

    if (refineLoops >= maxRefineLoops) {
      // Force-accept after exhausting Refiner budget — log forced_accept and break.
      forcedAccept = true;
      break;
    }

    try {
      advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "refine" });
      const refined = await runRole({
        topicId: input.topicId,
        sagaInstanceId: input.sagaInstanceId,
        role: "refiner",
        prompt: input.prompts.refine(currentPlan, criticDecision),
        invoke: input.invokes.refine,
      });
      // Refiner may return a full plan or a partial top-level patch.
      // Treat empty / undefined as "keep current plan".
      if (refined && Object.keys(refined).length > 0) {
        currentPlan = mergeRefinedPlan(currentPlan, refined);
        artifacts.refinedPlan = currentPlan;
      }
    } catch {
      // Refiner is an enhancement role. Its agent_run already records the
      // failure through agentExecutor; keep the current plan and let Critic
      // decide again, preserving the old no-op safety behavior.
    }

    refineLoops += 1;
  }

  // --- 5. Spec Writer ---
  try {
    advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "spec" });
    const specTasks = extractSpecTasksFromPlan(currentPlan);
    if (specTasks.length > 0) {
      const specResult = await runSpecWriter({
        tasks: specTasks,
        goalContext: input.goalContext ?? { goalTitle: input.topicId },
        attribution: { topicId: input.topicId, sagaInstanceId: input.sagaInstanceId },
        invoke: input.invokes.spec,
      });
      if (specResult.specs.length > 0) {
        artifacts.specs = Object.fromEntries(specResult.specs.map((spec) => [spec.taskId, spec.content]));
      }
    }
  } catch {
    // Task specs are an enhancement; planning should continue when generation fails.
  }

  // --- 6. Presenter ---
  try {
    advanceSaga({ sagaInstanceId: input.sagaInstanceId, toStep: "present" });
    artifacts.presentation = await runRole({
      topicId: input.topicId,
      sagaInstanceId: input.sagaInstanceId,
      role: "presenter",
      prompt: input.prompts.present(currentPlan),
      invoke: input.invokes.present,
    });
  } catch (error) {
    return failSaga(input.sagaInstanceId, getFailedAgentRunId(error), "present", error, artifacts, refineLoops);
  }

  const completed = markCompleted(input.sagaInstanceId);
  return {
    saga: completed ?? mustFindSaga(input.sagaInstanceId),
    status: "completed",
    artifacts,
    refineLoops,
    forcedAccept,
  };
}

function failSaga(
  sagaInstanceId: string,
  agentRunId: string | undefined,
  failedStep: TopicInitSagaStep,
  error: unknown,
  artifacts: TopicInitSagaResult["artifacts"],
  refineLoops: number,
): TopicInitSagaResult {
  const message = error instanceof Error ? error.message : String(error);
  const saga = markFailed(sagaInstanceId, { agentRunId, message });
  return {
    saga: saga ?? mustFindSaga(sagaInstanceId),
    status: "failed",
    errorMessage: message,
    failedAgentRunId: agentRunId,
    failedStep,
    artifacts,
    refineLoops,
  };
}

function getFailedAgentRunId(error: unknown) {
  return error instanceof SagaRoleError ? error.agentRunId : undefined;
}

function mustFindSaga(id: string): SagaInstance {
  const saga = findSagaInstanceById(id);
  if (!saga) throw new Error(`topicInitSaga: saga ${id} not found`);
  return saga;
}
