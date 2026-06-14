import { runTopicTick } from "@/lib/server/governance/topicRunner";
import type {
  GovernanceTickMachineCommand,
  GovernanceTickMachineResult,
  GovernanceTickOutcome,
} from "@/lib/server/governance/governanceTickProtocol";
import { runThreadTick } from "@/lib/server/thread/threadRunner";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { Task, TaskInstance } from "@/types/kiki";
import type { Thread, Topic } from "@/types/topic";

export async function runGovernanceTickLocally(input: {
  command: GovernanceTickMachineCommand;
  invoke: LlmInvoke;
  now?: Date;
}): Promise<GovernanceTickMachineResult> {
  try {
    const outcome =
      input.command.targetKind === "thread"
        ? await runThreadGovernanceTickLocally(input)
        : await runTopicGovernanceTickLocally(input);
    return {
      type: input.command.type,
      governanceJobId: input.command.governanceJobId,
      leaseOwner: input.command.leaseOwner,
      leaseToken: input.command.leaseToken,
      ok: true,
      outcome,
    };
  } catch (error) {
    return {
      type: input.command.type,
      governanceJobId: input.command.governanceJobId,
      leaseOwner: input.command.leaseOwner,
      leaseToken: input.command.leaseToken,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runThreadGovernanceTickLocally(input: {
  command: GovernanceTickMachineCommand;
  invoke: LlmInvoke;
  now?: Date;
}): Promise<Extract<GovernanceTickOutcome, { targetKind: "thread" }>> {
  const { command } = input;
  if (command.targetKind !== "thread") throw new Error("thread governance executor received non-thread command");
  const snapshot = command.payload.snapshot;
  const topic = readRecordField<Topic>(snapshot, "topic");
  const thread = readRecordField<Thread>(snapshot, "thread");
  if (!command.payload.threadId) throw new Error("thread governance payload missing threadId");
  const currentTasks = readArrayField<Task>(snapshot, "currentTasks") ?? [];
  const recentTaskInstances = readArrayField<TaskInstance>(snapshot, "recentTaskInstances") ?? [];
  const result = await runThreadTick({
    ctx: {
      topic,
      thread,
      currentTasks,
      recentTaskInstances,
      now: input.now ?? new Date(),
    },
    invoke: input.invoke,
    agentRunId: command.governanceJobId,
  });
  return {
    governanceJobId: command.governanceJobId,
    targetKind: "thread",
    topicId: command.payload.topicId,
    threadId: command.payload.threadId,
    baseRevision: command.payload.baseRevision,
    result,
    currentTasks,
  };
}

export async function runTopicGovernanceTickLocally(input: {
  command: GovernanceTickMachineCommand;
  invoke: LlmInvoke;
  now?: Date;
}): Promise<Extract<GovernanceTickOutcome, { targetKind: "topic" }>> {
  const { command } = input;
  if (command.targetKind !== "topic") throw new Error("topic governance executor received non-topic command");
  const snapshot = command.payload.snapshot;
  const topic = readRecordField<Topic>(snapshot, "topic");
  const result = await runTopicTick({
    ctx: {
      topic,
      threads: readArrayField<Thread>(snapshot, "threads") ?? topic.threads,
      now: input.now ?? new Date(),
    },
    invoke: input.invoke,
    agentRunId: command.governanceJobId,
  });
  return {
    governanceJobId: command.governanceJobId,
    targetKind: "topic",
    topicId: command.payload.topicId,
    baseRevision: command.payload.baseRevision,
    patch: result.patch,
    ok: result.ok,
    error: result.ok ? undefined : result.error.kind,
  };
}

function readRecordField<T>(record: Record<string, unknown>, field: string): T {
  const value = record[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`governance snapshot missing ${field}`);
  }
  return value as T;
}

function readArrayField<T>(record: Record<string, unknown>, field: string): T[] | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`governance snapshot field ${field} must be an array`);
  return value as T[];
}
