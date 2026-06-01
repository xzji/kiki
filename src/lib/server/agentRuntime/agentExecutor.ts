/**
 * agentExecutor — generic single-role LLM executor.
 *
 * Plan ref: §3.1.4. The executor is the *only* component that:
 * 1. Calls the LLM (via a pluggable invoke fn — actual Claude transport is wired
 *    in later PRs that depend on the saga shape).
 * 2. Persists `agent_runs` lifecycle (running → completed/failed).
 * 3. Persists `agent_events` for every llm.request / llm.response / decision /
 *    error / snapshot, with payloads guarded by `payloadGuard`.
 *
 * It is intentionally agnostic about saga semantics — TopicInitSaga and
 * ThreadRunner each call into this layer with their own prompt builders and
 * decision parsers.
 */

import { findAgentRunById, updateAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { appendAgentEvent } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import { upsertAgentSnapshot } from "@/lib/server/repositories/agentRuntime/agentSnapshotsRepository";
import type { AgentRun, AgentEventType } from "@/types/agentRuntime";

import { guardPayload } from "./payloadGuard";

/**
 * Pluggable LLM call. Concrete implementation is wired in PR9+ once we know the
 * exact transport contract for each role.
 */
export type LlmInvoke = (request: {
  agentRunId: string;
  prompt: string;
  context: Record<string, unknown>;
}) => Promise<{
  /** Raw text returned by the LLM (caller responsible for JSON parsing). */
  rawText: string;
  /** Optional structured response when caller already parsed (rare). */
  parsed?: Record<string, unknown>;
  /** Free-form usage / debug metadata mirrored as decision payload. */
  meta?: Record<string, unknown>;
}>;

export type ExecuteAgentRunInput = {
  agentRunId: string;
  prompt: string;
  context?: Record<string, unknown>;
  invoke: LlmInvoke;
};

export type ExecuteAgentRunResult = {
  run: AgentRun;
  rawText: string;
  parsed?: Record<string, unknown>;
};

/** Append an event with the standard payload-guard pipeline. */
export function appendGuardedEvent(input: {
  agentRunId: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
}) {
  const run = findAgentRunById(input.agentRunId);
  const nextSeq = (run?.lastEventSeq ?? 0) + 1;
  const guarded = guardPayload({
    agentRunId: input.agentRunId,
    seq: nextSeq,
    payload: input.payload,
  });
  return appendAgentEvent({
    agentRunId: input.agentRunId,
    type: input.type,
    payloadJson: guarded.inlineJson,
    payloadRef: guarded.payloadRef,
  });
}

/**
 * Run a single agent role end-to-end.
 *
 * Lifecycle:
 *   pending → running → llm.request event → invoke() → llm.response event → completed
 *   On error: error event → failed (rethrows for caller to decide saga policy).
 */
export async function executeAgentRun(input: ExecuteAgentRunInput): Promise<ExecuteAgentRunResult> {
  const { agentRunId, prompt, context = {}, invoke } = input;

  const startedRun = updateAgentRun({ id: agentRunId, status: "running" });
  if (!startedRun) {
    throw new Error(`agentExecutor: cannot start unknown run ${agentRunId}`);
  }

  appendGuardedEvent({
    agentRunId,
    type: "llm.request",
    payload: { prompt, context },
  });

  try {
    const result = await invoke({ agentRunId, prompt, context });

    appendGuardedEvent({
      agentRunId,
      type: "llm.response",
      payload: {
        rawText: result.rawText,
        meta: result.meta ?? {},
      },
    });

    if (result.parsed) {
      appendGuardedEvent({
        agentRunId,
        type: "decision",
        payload: result.parsed,
      });
    }

    const completed = updateAgentRun({
      id: agentRunId,
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    if (!completed) {
      throw new Error(`agentExecutor: failed to mark run ${agentRunId} as completed`);
    }

    upsertAgentSnapshot({
      agentRunId,
      lastEventSeq: completed.lastEventSeq,
      state: { lastRawText: result.rawText, parsed: result.parsed ?? null },
    });

    return { run: completed, rawText: result.rawText, parsed: result.parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendGuardedEvent({
      agentRunId,
      type: "error",
      payload: { message },
    });
    updateAgentRun({
      id: agentRunId,
      status: "failed",
      finishedAt: new Date().toISOString(),
    });
    throw error;
  }
}
