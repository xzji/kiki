import { selectDueTopics } from "@/lib/server/governance/topicScheduler";
import { runTopicTick, type TopicTickResult } from "@/lib/server/governance/topicRunner";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { Topic } from "@/types/topic";

export type CollectActiveTopicsCallback = () => Promise<Topic[]>;

export type PrepareTopicAgentRunCallback = (input: {
  topic: Topic;
}) => Promise<{ agentRunId: string }>;

export type PersistTopicPatchCallback = (input: {
  topic: Topic;
  result: TopicTickResult;
}) => Promise<{ ok: boolean; conflict?: boolean }>;

export type RecordTopicTickOutcomeCallback = (input: {
  topic: Topic;
  agentRunId: string;
  result: TopicTickResult;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}) => Promise<void>;

export type TopicLoopFrameInput = {
  now: Date;
  invoke: LlmInvoke;
  callbacks: {
    collectActiveTopics: CollectActiveTopicsCallback;
    prepareAgentRun: PrepareTopicAgentRunCallback;
    persistTopicPatch: PersistTopicPatchCallback;
    recordTickOutcome: RecordTopicTickOutcomeCallback;
  };
};

export type TopicLoopFrameOutcome = {
  ticked: Array<{
    topicId: string;
    agentRunId: string;
    ok: boolean;
    failureReason?: string;
    silentCount?: number;
    persistConflict?: boolean;
  }>;
  frameErrors: unknown[];
};

export async function runTopicLoopFrame(input: TopicLoopFrameInput): Promise<TopicLoopFrameOutcome> {
  const outcome: TopicLoopFrameOutcome = { ticked: [], frameErrors: [] };
  let candidates: Topic[];
  try {
    candidates = await input.callbacks.collectActiveTopics();
  } catch (error) {
    outcome.frameErrors.push(error);
    return outcome;
  }

  for (const due of selectDueTopics(candidates, input.now)) {
    await tickOneTopic(due.topic, input, outcome);
  }
  return outcome;
}

async function tickOneTopic(
  topic: Topic,
  input: TopicLoopFrameInput,
  outcome: TopicLoopFrameOutcome,
) {
  const ticked: TopicLoopFrameOutcome["ticked"][number] = {
    topicId: topic.id,
    agentRunId: "",
    ok: false,
  };
  outcome.ticked.push(ticked);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  let agentRunId: string;
  try {
    const prepared = await input.callbacks.prepareAgentRun({ topic });
    agentRunId = prepared.agentRunId;
    ticked.agentRunId = agentRunId;
  } catch (error) {
    ticked.failureReason = `prepareAgentRun_failed: ${stringifyErr(error)}`;
    return;
  }

  const result = await runTopicTick({
    ctx: { topic, threads: topic.threads, now: input.now },
    invoke: input.invoke,
    agentRunId,
  });

  try {
    const persist = await input.callbacks.persistTopicPatch({ topic, result });
    if (!persist.ok && persist.conflict) {
      ticked.persistConflict = true;
      ticked.failureReason = "persist_conflict";
    } else if (!persist.ok) {
      ticked.failureReason = "persist_failed";
    }
  } catch (error) {
    ticked.failureReason = `persist_threw: ${stringifyErr(error)}`;
  }

  try {
    const finishedAtMs = Date.now();
    await input.callbacks.recordTickOutcome({
      topic,
      agentRunId,
      result,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
    });
  } catch (error) {
    ticked.failureReason = ticked.failureReason
      ? `${ticked.failureReason}; record_event_failed: ${stringifyErr(error)}`
      : `record_event_failed: ${stringifyErr(error)}`;
  }

  ticked.ok = result.ok && ticked.failureReason === undefined;
  ticked.silentCount = result.patch.silentCount;
  if (!result.ok && !ticked.failureReason) ticked.failureReason = `tick_failed: ${result.error.kind}`;
}

function stringifyErr(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
