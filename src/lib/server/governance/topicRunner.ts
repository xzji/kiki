import { tuneTopicTickPatch } from "@/lib/server/governance/cadenceTuner";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { TopicPatch } from "@/lib/server/repositories/topicsRepository";
import { normalizeTriggerSpec, type TriggerSpec, type TriggerSpecInput } from "@/types/trigger";
import type { Thread, Topic, TopicPhase } from "@/types/topic";

export type TopicTickConfidence = "high" | "medium" | "low";

export type TopicTickAction =
  | { kind: "silent"; reason: string }
  | { kind: "mark_running"; reason: string }
  | { kind: "mark_completed"; reason: string }
  | { kind: "mark_failed"; reason: string }
  | { kind: "adjust_loop"; loop: TriggerSpec; reason: string };

export type TopicTickOutput = {
  assessment: string;
  confidence: TopicTickConfidence;
  actions: TopicTickAction[];
};

export type TopicTickContext = {
  topic: Topic;
  threads?: Thread[];
  now: Date;
};

export type TopicTickPatch = TopicPatch;

export type TopicTickResult =
  | {
      ok: true;
      patch: TopicTickPatch;
      output: TopicTickOutput;
    }
  | {
      ok: false;
      patch: TopicTickPatch;
      error: TopicTickFailure;
    };

export type TopicTickFailure =
  | { kind: "invoke_error"; error: unknown }
  | { kind: "validation_error"; error: TopicTickOutputValidationError };

export type RunTopicTickInput = {
  ctx: TopicTickContext;
  invoke: LlmInvoke;
  agentRunId: string;
};

export class TopicTickOutputValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "TopicTickOutputValidationError";
  }
}

export async function runTopicTick(input: RunTopicTickInput): Promise<TopicTickResult> {
  const { ctx, invoke, agentRunId } = input;
  const lastTickAt = ctx.now.toISOString();
  const prompt = buildTopicRunnerDecisionPrompt(ctx);

  let raw: { rawText: string; parsed?: Record<string, unknown> };
  try {
    raw = await invoke({
      agentRunId,
      prompt,
      context: { topicId: ctx.topic.id },
    });
  } catch (error) {
    return buildFailureResult(ctx, lastTickAt, { kind: "invoke_error", error });
  }

  let output: TopicTickOutput;
  try {
    output = parseTopicTickOutput(raw.parsed ?? JSON.parse(raw.rawText));
  } catch (error) {
    if (error instanceof TopicTickOutputValidationError) {
      return buildFailureResult(ctx, lastTickAt, { kind: "validation_error", error });
    }
    return buildFailureResult(ctx, lastTickAt, {
      kind: "validation_error",
      error: new TopicTickOutputValidationError(`TopicRunner output is not valid JSON: ${String(error)}`, "invalid_json"),
    });
  }

  const isAllSilent =
    output.actions.length > 0 && output.actions.every((action) => action.kind === "silent");
  const requestedLoop = output.actions.find(
    (action): action is Extract<TopicTickAction, { kind: "adjust_loop" }> => action.kind === "adjust_loop",
  )?.loop;
  const phase = phaseFromActions(output.actions) ?? ctx.topic.phase;
  const tuned = tuneTopicTickPatch({
    topic: ctx.topic,
    patch: {
      loop: requestedLoop ?? ctx.topic.loop,
      lastTickAt,
      silentCount: isAllSilent ? ctx.topic.silentCount + 1 : 0,
      failureCount: 0,
    },
    now: ctx.now,
  });

  return {
    ok: true,
    patch: { ...tuned.patch, phase },
    output,
  };
}

export function buildTopicRunnerDecisionPrompt(ctx: TopicTickContext) {
  const threadSummaries = (ctx.threads ?? ctx.topic.threads).map((thread) => ({
    id: thread.id,
    title: thread.title,
    intent: thread.intent,
    status: thread.status,
    lastTickAt: thread.lastTickAt,
    nextTickAt: thread.nextTickAt,
    silentCount: thread.silentCount,
    failureCount: thread.failureCount,
  }));
  return [
    "You are the Topic governance runner.",
    "Review the topic-level loop state and return strict JSON only.",
    "",
    "Output schema:",
    JSON.stringify({
      assessment: "short topic-level assessment",
      confidence: "high|medium|low",
      actions: [
        { kind: "silent", reason: "no topic-level change" },
        { kind: "mark_running", reason: "topic still needs active governance" },
        { kind: "mark_completed", reason: "topic completion criteria satisfied" },
        { kind: "mark_failed", reason: "topic cannot progress" },
        { kind: "adjust_loop", loop: { kind: "daily" }, reason: "cadence adjustment" },
      ],
    }),
    "",
    "Topic:",
    JSON.stringify({
      id: ctx.topic.id,
      title: ctx.topic.title,
      summary: ctx.topic.summary,
      status: ctx.topic.status,
      phase: ctx.topic.phase,
      deadline: ctx.topic.deadline,
      completionCriteria: ctx.topic.completionCriteria,
      loop: ctx.topic.loop,
      lastTickAt: ctx.topic.lastTickAt,
      nextTickAt: ctx.topic.nextTickAt,
      silentCount: ctx.topic.silentCount,
      failureCount: ctx.topic.failureCount,
    }),
    "",
    "Threads:",
    JSON.stringify(threadSummaries),
    "",
    `Now: ${ctx.now.toISOString()}`,
  ].join("\n");
}

export function parseTopicTickOutput(value: unknown): TopicTickOutput {
  if (!isRecord(value)) throw new TopicTickOutputValidationError("TopicRunner output must be an object", "not_object");
  const assessment = requireString(value.assessment, "assessment");
  const confidence = parseConfidence(value.confidence);
  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    throw new TopicTickOutputValidationError("actions must be a non-empty array", "actions_missing");
  }
  return {
    assessment,
    confidence,
    actions: value.actions.map(parseTopicTickAction),
  };
}

function parseTopicTickAction(value: unknown): TopicTickAction {
  if (!isRecord(value)) throw new TopicTickOutputValidationError("action must be an object", "action_not_object");
  const kind = requireString(value.kind, "action.kind");
  const reason = requireString(value.reason, "action.reason");
  switch (kind) {
    case "silent":
    case "mark_running":
    case "mark_completed":
    case "mark_failed":
      return { kind, reason };
    case "adjust_loop": {
      const loop = normalizeTriggerSpec(value.loop as TriggerSpecInput);
      if (!loop) throw new TopicTickOutputValidationError("adjust_loop.loop must be a valid TriggerSpec", "invalid_loop");
      return { kind, loop, reason };
    }
    default:
      throw new TopicTickOutputValidationError(`unsupported action kind: ${kind}`, "unsupported_action");
  }
}

function buildFailureResult(
  ctx: TopicTickContext,
  lastTickAt: string,
  error: TopicTickFailure,
): Extract<TopicTickResult, { ok: false }> {
  const tuned = tuneTopicTickPatch({
    topic: ctx.topic,
    patch: {
      lastTickAt,
      silentCount: ctx.topic.silentCount,
      failureCount: ctx.topic.failureCount + 1,
    },
    now: ctx.now,
  });
  return { ok: false, patch: { ...tuned.patch, phase: "failed" }, error };
}

function phaseFromActions(actions: TopicTickAction[]): TopicPhase | undefined {
  if (actions.some((action) => action.kind === "mark_failed")) return "failed";
  if (actions.some((action) => action.kind === "mark_completed")) return "completed";
  if (actions.some((action) => action.kind === "mark_running")) return "running";
  return undefined;
}

function parseConfidence(value: unknown): TopicTickConfidence {
  if (value === "high" || value === "medium" || value === "low") return value;
  throw new TopicTickOutputValidationError("confidence must be high, medium, or low", "invalid_confidence");
}

function requireString(value: unknown, field: string) {
  if (typeof value === "string" && value.trim()) return value;
  throw new TopicTickOutputValidationError(`${field} must be a non-empty string`, "invalid_string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
