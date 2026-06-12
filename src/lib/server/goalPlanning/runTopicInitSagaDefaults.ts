/**
 * runTopicInitSagaDefaults — Default wiring for Topic Init Saga (PR11).
 *
 * Plan ref: §12.1 PR11.2 in .trae/documents/Topic_Thread_代码实现计划_v1.md
 *
 * Responsibilities:
 *  1. Provide default prompt builders for the 5 Saga roles (Interviewer / Planner /
 *     Critic / Refiner / Presenter). These reference the namespace anchors under
 *     `goalPlanning/agents/*Prompt.ts` so that downstream PRs can swap individual
 *     roles without touching the orchestrator (`topicInitSaga.ts`).
 *  2. Provide a default LlmInvoke factory built on `createClaudeJsonInvoke`, using
 *     pass-through validators for the decision layer. Critic carries a conservative
 *     `degradedFallback` so that token-truncated outputs fall back to "needs_refinement"
 *     instead of throwing.
 *  3. Expose `runTopicInitSagaWithDefaults`, a high-level entry point that:
 *      - reuses an existing saga via `idempotencyKey`,
 *      - creates `saga_instances` row (type=topic_init),
 *      - invokes `runTopicInitSaga` with the wired prompts/invokes,
 *      - returns the structured `TopicInitSagaResult`.
 *
 * Refiner note: default wiring now calls the real runtime JSON invoke. The
 * orchestrator keeps the old safety property by preserving the current plan
 * when Refiner fails or returns an empty payload.
 */

import {
  buildCollectedInfoSummaryPrompt,
  buildGoalClarificationPrompt,
} from "@/lib/server/goalPlanning/agents/interviewerPrompt";
// Planner anchor exposes the high-level decompose prompt (Goal → SubGoals).
// The full SubGoal → Task draft expansion is delegated to a later PR; for PR11
// we only need a single "draft a structured plan" prompt for the Saga.
import { buildDecomposePrompt } from "@/lib/server/goalPlanning/agents/plannerPrompt";
import { applyDraftReview } from "@/lib/server/goalPlanning/agents/criticPrompt";
import { buildPlanPresentationPrompt } from "@/lib/server/goalPlanning/agents/presenterPrompt";
import {
  buildTopicPlanRefinerPrompt,
  validateRefinedTopicPlan,
} from "@/lib/server/goalPlanning/agents/refinerPrompt";
import { DEFAULT_EASTER_EGG_SETTINGS } from "@/lib/goalSystemConfig";

import {
  createSagaInstance,
  findSagaInstanceById,
  incrementSagaRetry,
  type CreateSagaInstanceInput,
} from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";

import { createClaudeJsonInvoke } from "@/lib/server/agentRuntime/claudeJsonInvoke";
import { isTerminalStatus } from "@/lib/server/agentRuntime/sagaCoordinator";
import type { CliProcessEventInput, CliPromptSection, RuntimeEnvironment } from "@/types/runtime";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";

import {
  runTopicInitSaga,
  type CriticDecisionPayload,
  type TopicInitSagaInput,
  type TopicInitSagaResult,
} from "./topicInitSaga";

export type TopicInitSagaSeed = {
  /** Topic id (legacy goal id during Topic↔Goal alias period). */
  topicId: string;
  /** Raw user-supplied topic text. Required. */
  topicText: string;
  /** Optional structured user context aggregated from prior conversation turns. */
  userContext?: Record<string, unknown>;
  /** Optional free-form conversation context excerpt. */
  conversationContext?: string;
};

/**
 * Build the 5 default Saga prompts.
 *
 * Prompt shapes:
 *  - interview: clarification questions prompt (returns `{ questions: string[] }` or
 *    `{ collectedInfo: ... }` once user has answered enough rounds).
 *  - plan: top-level decomposition prompt (returns SubGoal[] / Thread[] structure).
 *  - critic: takes Planner output, returns `{ verdict, notes? }`.
 *  - refine: takes Planner output + Critic decision, returns a refined plan JSON.
 *  - present: takes (potentially refined) Planner output, returns presentation payload.
 */
export function buildDefaultTopicInitSagaPrompts(
  seed: TopicInitSagaSeed,
): TopicInitSagaInput["prompts"] {
  const userContext = seed.userContext ?? {};
  const userContextJson = JSON.stringify(userContext, null, 2);

  // Interviewer: if userContext is empty, kick off clarification; otherwise summarize.
  const interview =
    Object.keys(userContext).length === 0
      ? buildGoalClarificationPrompt(seed.topicText, seed.conversationContext)
      : buildCollectedInfoSummaryPrompt(
          seed.topicText,
          userContextJson,
          seed.conversationContext,
        );

  const plan = buildDecomposePrompt({
    goalTitle: seed.topicText,
    goalDescription: seed.conversationContext ?? seed.topicText,
    userContext,
    config: DEFAULT_EASTER_EGG_SETTINGS,
  });

  const critic = (planParsed: Record<string, unknown>) =>
    [
      "你是 Topic 初始化 Saga 的 Critic 评审角色。",
      "请基于以下 Planner 草稿做对齐度判断，并仅输出极简 JSON 决策。",
      "禁止 Markdown / 代码块 / 解释。",
      "",
      "Topic：",
      seed.topicText,
      "",
      "Planner 草稿：",
      JSON.stringify(planParsed, null, 2),
      "",
      "JSON schema：",
      '{ "verdict": "accept" | "needs_refinement" | "reject", "notes"?: string }',
      "",
      "约束：",
      "1. verdict 必须三选一，不允许其他值。",
      "2. notes 仅在 needs_refinement / reject 时填写，必须 ≤ 200 字符。",
      "3. 整体输出 ≤ 30 行 / ≤ 1000 字符。",
    ].join("\n");

  const refine = (
    planParsed: Record<string, unknown>,
    criticDecision: CriticDecisionPayload,
  ) =>
    buildTopicPlanRefinerPrompt({
      topicText: seed.topicText,
      conversationContext: seed.conversationContext,
      userContext,
      currentPlan: planParsed,
      criticDecision,
    });

  const present = (planParsed: Record<string, unknown>) =>
    buildPlanPresentationPrompt({
      goalText: seed.topicText,
      collectedInfoSummary: userContext as never,
      decomposition: planParsed as never,
      taskPlanningSummary: extractTaskPlanningSummary(planParsed),
    });

  return { interview, plan, critic, refine, present };
}

/**
 * Best-effort extraction of `{ subGoalName, taskCount }[]` from Planner output.
 * Falls back to an empty array if shape doesn't match — Presenter's prompt
 * tolerates an empty summary.
 */
function extractTaskPlanningSummary(
  planParsed: Record<string, unknown>,
): Array<{ subGoalName: string; taskCount: number; uncoveredRisks?: string[] }> {
  const rawSubGoals = (planParsed.subGoals ?? planParsed.threads) as unknown;
  if (!Array.isArray(rawSubGoals)) return [];
  return rawSubGoals
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const name =
        typeof item.name === "string"
          ? item.name
          : typeof item.title === "string"
            ? item.title
            : typeof item.id === "string"
              ? item.id
              : "untitled";
      const taskCount = Array.isArray(item.tasks) ? item.tasks.length : 0;
      return { subGoalName: name, taskCount };
    });
}

export type CreateDefaultTopicInitSagaInvokesInput = {
  cwd: string;
  runtimeEnv: RuntimeEnvironment;
  signal?: AbortSignal;
  onCliEvent?: (event: CliProcessEventInput) => void;
};

type TopicInitSagaRole = "interviewer" | "planner" | "critic" | "refiner" | "spec" | "presenter";

const TOPIC_INIT_SAGA_ROLE_TITLES: Record<TopicInitSagaRole, string> = {
  interviewer: "Interviewer",
  planner: "Planner",
  critic: "Critic",
  refiner: "Refiner",
  spec: "Spec",
  presenter: "Presenter",
};

function stringifyForTrace(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createRolePromptSection(input: {
  role: TopicInitSagaRole;
  agentRunId: string;
  prompt: string;
}): CliPromptSection {
  return {
    id: `topic-saga-${input.agentRunId}-prompt`,
    kind: "user",
    title: `${TOPIC_INIT_SAGA_ROLE_TITLES[input.role]} Prompt`,
    content: input.prompt,
  };
}

function withSagaCliTrace(input: {
  role: TopicInitSagaRole;
  invoke: LlmInvoke;
  onCliEvent?: (event: CliProcessEventInput) => void;
}): LlmInvoke {
  return async (request) => {
    const roleTitle = TOPIC_INIT_SAGA_ROLE_TITLES[input.role];
    input.onCliEvent?.({
      type: "prompt",
      title: `${roleTitle} Prompt`,
      content: request.prompt,
      promptSection: createRolePromptSection({
        role: input.role,
        agentRunId: request.agentRunId,
        prompt: request.prompt,
      }),
    });
    input.onCliEvent?.({
      type: "thinking",
      title: `${roleTitle} 运行中`,
      content: "正在调用本地 Runtime 生成该角色结果。",
    });
    try {
      const result = await input.invoke(request);
      const rawText = result.rawText.trim();
      input.onCliEvent?.({
        type: "output",
        title: `${roleTitle} 输出`,
        content: rawText || "该步骤没有返回文本输出。",
        outputDelta: `\n\n## ${roleTitle} 输出\n${rawText || "（空输出）"}`,
      });
      if (result.parsed) {
        input.onCliEvent?.({
          type: "assistant_trace",
          title: `${roleTitle} 结构化结果`,
          content: stringifyForTrace(result.parsed),
        });
      }
      if (result.meta) {
        input.onCliEvent?.({
          type: "status",
          title: `${roleTitle} 调用完成`,
          content: stringifyForTrace(result.meta),
        });
      }
      return result;
    } catch (error) {
      input.onCliEvent?.({
        type: "error",
        title: `${roleTitle} 执行失败`,
        content: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

/**
 * Build the 5 default LlmInvokes.
 *
 * Validators: pass-through (require object, no shape constraints) so that the
 * Saga orchestrator can do its own role-specific normalization
 * (`asInterviewerDecision` / `asCriticDecision` etc.) without rejecting LLM
 * outputs at the invoke layer.
 *
 * Critic carries a conservative `degradedFallback` that returns
 * `{ verdict: "needs_refinement" }` when the JSON parser fails — this keeps the
 * Critic↔Refiner loop running rather than failing the entire Saga on a single
 * truncated payload (§9.5 决策/展示拆分硬约束).
 *
 * Refiner uses a real JSON invoke. Its failure policy lives in
 * `topicInitSaga.ts`, where Refiner errors preserve the current plan instead of
 * failing the whole Saga.
 */
export function createDefaultTopicInitSagaInvokes(
  input: CreateDefaultTopicInitSagaInvokesInput,
): TopicInitSagaInput["invokes"] {
  const passthroughValidator = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object") {
      throw new Error("topicInitSagaDefaults: expected JSON object");
    }
    return value as Record<string, unknown>;
  };

  const baseConfig = {
    cwd: input.cwd,
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
  };

  const interview = createClaudeJsonInvoke({
    ...baseConfig,
    validator: passthroughValidator,
  });

  const plan = createClaudeJsonInvoke({
    ...baseConfig,
    validator: passthroughValidator,
  });

  const critic = createClaudeJsonInvoke({
    ...baseConfig,
    validator: passthroughValidator,
    degradedFallback: () => ({
      verdict: "needs_refinement",
      notes: "critic JSON parse failed; conservatively triggering refine loop",
    }),
  });

  const refine = createClaudeJsonInvoke({
    ...baseConfig,
    validator: validateRefinedTopicPlan,
  });

  const present = createClaudeJsonInvoke({
    ...baseConfig,
    validator: passthroughValidator,
  });

  const spec = createClaudeJsonInvoke({
    ...baseConfig,
    validator: passthroughValidator,
    degradedFallback: () => ({ specs: [] }),
  });

  return {
    interview: withSagaCliTrace({ role: "interviewer", invoke: interview, onCliEvent: input.onCliEvent }),
    plan: withSagaCliTrace({ role: "planner", invoke: plan, onCliEvent: input.onCliEvent }),
    critic: withSagaCliTrace({ role: "critic", invoke: critic, onCliEvent: input.onCliEvent }),
    refine: withSagaCliTrace({ role: "refiner", invoke: refine, onCliEvent: input.onCliEvent }),
    spec: withSagaCliTrace({ role: "spec", invoke: spec, onCliEvent: input.onCliEvent }),
    present: withSagaCliTrace({ role: "presenter", invoke: present, onCliEvent: input.onCliEvent }),
  };
}

export type RunTopicInitSagaWithDefaultsInput = TopicInitSagaSeed & {
  cwd: string;
  runtimeEnv: RuntimeEnvironment;
  signal?: AbortSignal;
  /** Optional pre-existing saga instance id (resume path). Mutually exclusive with idempotencyKey. */
  sagaInstanceId?: string;
  /** Idempotency key passed to createSagaInstance — repeated calls with same key reuse the saga. */
  idempotencyKey?: string;
  /** Override max Critic↔Refiner cycles (default 2 per orchestrator). */
  maxRefineLoops?: number;
  /** Optional real-time sink used by conversation UI to show each Saga role run. */
  onCliEvent?: (event: CliProcessEventInput) => void;
};

/**
 * High-level entry: create (or look up) a saga_instance, wire default prompts +
 * invokes, then delegate to runTopicInitSaga. Surface the structured result
 * (including `awaiting_user` pause + `awaitingQuestions`) to the caller.
 *
 * Resume / idempotency semantics:
 *  - `sagaInstanceId` and `idempotencyKey` are mutually exclusive. Passing both
 *    throws — caller must choose one path explicitly.
 *  - When `sagaInstanceId` is provided, the saga row must already exist
 *    (otherwise advanceSaga / markCompleted would silently no-op via
 *    updateSagaInstance returning null, leaving the saga in an inconsistent
 *    "running but no row" state). We fail fast on missing rows.
 *  - When `idempotencyKey` is provided, `createSagaInstance` reuses the existing
 *    row if one matches the key. In both resume paths we bump `retry_count` so
 *    saga retries are observable (§9.6).
 *
 * Caller responsibility:
 *  - Persist `result.artifacts.presentation` to Topic storage on `completed`.
 *  - Surface `result.awaitingQuestions` to the user when status === "awaiting_user",
 *    then call this function again with same `idempotencyKey` (or `sagaInstanceId`)
 *    to resume.
 */
export async function runTopicInitSagaWithDefaults(
  input: RunTopicInitSagaWithDefaultsInput,
): Promise<TopicInitSagaResult> {
  if (input.sagaInstanceId && input.idempotencyKey) {
    throw new Error(
      "runTopicInitSagaWithDefaults: sagaInstanceId and idempotencyKey are mutually exclusive",
    );
  }

  const sagaInstance = (() => {
    if (input.sagaInstanceId) {
      // Caller supplied a saga id explicitly — the row must already exist; we
      // do not create rows on the resume path. Fail fast if missing so callers
      // notice misuse instead of seeing an FK error from createAgentRun later.
      const existing = findSagaInstanceById(input.sagaInstanceId);
      if (!existing) {
        throw new Error(
          `runTopicInitSagaWithDefaults: saga ${input.sagaInstanceId} not found`,
        );
      }
      if (isTerminalStatus(existing.status)) {
        throw new Error(
          `runTopicInitSagaWithDefaults: saga ${existing.id} already in terminal status '${existing.status}'`,
        );
      }
      // Mark this as a retry attempt so saga_instances.retry_count is observable.
      incrementSagaRetry(existing.id);
      return existing;
    }
    const createInput: CreateSagaInstanceInput = {
      topicId: input.topicId,
      type: "topic_init",
      idempotencyKey: input.idempotencyKey,
    };
    const created = createSagaInstance(createInput);
    // createSagaInstance returns the existing row when idempotencyKey matches.
    // Reject re-running an idempotent saga that already terminated; bump
    // retry_count only on the non-pending, non-terminal resume branch.
    if (input.idempotencyKey && created.status !== "pending") {
      if (isTerminalStatus(created.status)) {
        throw new Error(
          `runTopicInitSagaWithDefaults: saga ${created.id} (idempotencyKey=${input.idempotencyKey}) already in terminal status '${created.status}'`,
        );
      }
      incrementSagaRetry(created.id);
    }
    return created;
  })();

  const prompts = buildDefaultTopicInitSagaPrompts({
    topicId: input.topicId,
    topicText: input.topicText,
    userContext: input.userContext,
    conversationContext: input.conversationContext,
  });

  const invokes = createDefaultTopicInitSagaInvokes({
    cwd: input.cwd,
    runtimeEnv: input.runtimeEnv,
    signal: input.signal,
    onCliEvent: input.onCliEvent,
  });

  return runTopicInitSaga({
    sagaInstanceId: sagaInstance.id,
    topicId: input.topicId,
    goalContext: { goalTitle: input.topicText, goalSummary: input.conversationContext },
    prompts,
    invokes,
    maxRefineLoops: input.maxRefineLoops,
  });
}

// Re-export for convenience: callers using runTopicInitSagaWithDefaults usually
// also need the orchestrator types for narrowing the result.
export { runTopicInitSaga };
export type { TopicInitSagaInput, TopicInitSagaResult, CriticDecisionPayload };
// Used by Critic fallback consumers if they need to detect deterministic
// review tags downstream (parity with PR9b agents/criticPrompt.ts re-export).
export { applyDraftReview };
