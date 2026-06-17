import { createIdempotencyKey } from "@/lib/opaqueIds";
import { getCurrentUserId, runWithUserContext } from "@/lib/server/context/userContext";
import { pushGovernanceChangeNotification } from "@/lib/server/governance/governanceChangeNotifications";
import { dispatchThreadActions, type DispatchThreadActionsResult } from "@/lib/server/governance/dispatchActions";
import {
  commandTypeForGovernanceTarget,
  type GovernanceTickLlmPayload,
  type GovernanceTickMachineCommand,
  type GovernanceTickMachineResult,
  type GovernanceTickOutcome,
  type GovernanceTickThreadOutcome,
  type GovernanceTickTopicOutcome,
} from "@/lib/server/governance/governanceTickProtocol";
import { isTopicDue } from "@/lib/server/governance/topicScheduler";
import { isThreadDue, selectDueThreads } from "@/lib/server/governance/threadScheduler";
import { recordEntity as recordLoopEntity, type LoopTickPhase } from "@/lib/server/observability/loopTickLog";
import { createAgentRun, updateAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { appendThreadMessage } from "@/lib/server/repositories/conversationMessagesRepository";
import {
  acquireGovernanceTickJobLease,
  completeGovernanceTickJob,
  countPendingGovernanceTickJobs,
  createGovernanceTickJob,
  failGovernanceTickJob,
  getGovernanceTickJob,
  renewGovernanceTickJobLeaseFromHello,
  type GovernanceTickJobPayload,
  type GovernanceTickJobRecord,
  type GovernanceTickTargetKind,
} from "@/lib/server/repositories/governanceTickJobsRepository";
import { appendInboxMessage } from "@/lib/server/repositories/inboxRepository";
import { findThreadById, ThreadRevisionMismatchError, updateThread } from "@/lib/server/repositories/threadsRepository";
import { findTopicById, TopicRevisionMismatchError, updateTopic } from "@/lib/server/repositories/topicsRepository";
import { readTopicsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import {
  getTunnelHub,
  setTunnelGovernanceTickResultListener,
} from "@/lib/server/tunnel/tunnelHub";
import {
  cancelTaskFromThread,
  dispatchTaskFromThread,
  updateTaskFromThread,
} from "@/lib/server/services/dispatchTaskFromThread";
import { goalsSnapshotThreadTaskView } from "@/lib/server/services/threadTaskView";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { Thread, Topic } from "@/types/topic";

const DEFAULT_GOVERNANCE_TICK_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_GOVERNANCE_TICK_EXPIRED_LEASE_GRACE_MS = 5 * 60 * 1000;

export type GovernanceTickOutcomeProcessResult =
  | { ok: true; job: GovernanceTickJobRecord; duplicate?: boolean; dispatch?: DispatchThreadActionsResult }
  | { ok: false; job: GovernanceTickJobRecord | null; reason: string; staleRevision?: boolean; dispatch?: DispatchThreadActionsResult };

export type GovernanceTickDispatchSender = (command: GovernanceTickMachineCommand) => boolean;

export type {
  GovernanceTickMachineCommand,
  GovernanceTickMachineResult,
  GovernanceTickOutcome,
  GovernanceTickThreadOutcome,
  GovernanceTickTopicOutcome,
};

export type GovernanceTickActionCallbacks = {
  dispatchTask?: typeof dispatchTaskFromThread;
  updateTask?: typeof updateTaskFromThread;
  cancelTask?: typeof cancelTaskFromThread;
  sendThreadMessage?: (input: {
    topicId: string;
    threadId: string;
    text: string;
    severity: "info" | "warning" | "important";
    traceId: string;
  }) => Promise<{ conversationMessageId: string; inboxItemId?: string }>;
};

function nowIso(now = new Date()) {
  return now.toISOString();
}

function logGovernanceTick(message: string, fields: Record<string, unknown> = {}) {
  console.info("[governance_tick]", message, fields);
}

function buildJobIdempotencyKey(input: {
  targetKind: GovernanceTickTargetKind;
  topicId: string;
  threadId?: string;
  baseRevision: number;
}) {
  return createIdempotencyKey(
    "governance_tick_job",
    input.targetKind,
    input.topicId,
    input.threadId,
    String(input.baseRevision),
  );
}

function buildManualJobIdempotencyKey(input: {
  targetKind: GovernanceTickTargetKind;
  topicId: string;
  threadId?: string;
  requestKey: string;
}) {
  return createIdempotencyKey(
    "governance_tick_job_manual",
    input.targetKind,
    input.topicId,
    input.threadId,
    input.requestKey,
  );
}

function threadPayload(topic: Topic, thread: Thread, due: ReturnType<typeof isThreadDue>): GovernanceTickJobPayload {
  return {
    targetKind: "thread",
    topicId: topic.id,
    threadId: thread.id,
    baseRevision: thread.revision,
    snapshot: { topic, thread },
    dueReason: due?.reason,
    scheduledAt: due?.scheduledAt.toISOString(),
  };
}

function topicPayload(topic: Topic, due: NonNullable<ReturnType<typeof isTopicDue>>): GovernanceTickJobPayload {
  return {
    targetKind: "topic",
    topicId: topic.id,
    baseRevision: topic.revision,
    snapshot: { topic },
    dueReason: due.reason,
    scheduledAt: due.scheduledAt.toISOString(),
  };
}

export function enqueueManualGovernanceTickJob(input: {
  targetKind: GovernanceTickTargetKind;
  entityId: string;
  idempotencyKey: string;
  userId?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const topics = readTopicsSnapshot([]);

  if (input.targetKind === "topic") {
    const topic = topics.find((item) => item.id === input.entityId);
    if (!topic) throw new Error("未找到 Topic");
    if (topic.status !== "active") throw new Error("Topic 当前不可治理");
    const job = createGovernanceTickJob({
      targetKind: "topic",
      topicId: topic.id,
      userId: input.userId,
      baseRevision: topic.revision,
      payload: {
        targetKind: "topic",
        topicId: topic.id,
        baseRevision: topic.revision,
        snapshot: { topic },
        dueReason: "manual",
        scheduledAt: nowIso(now),
      },
      idempotencyKey: buildManualJobIdempotencyKey({
        targetKind: "topic",
        topicId: topic.id,
        requestKey: input.idempotencyKey,
      }),
      availableAt: nowIso(now),
      createdAt: nowIso(now),
    });
    logGovernanceTick("enqueued manual governance job", {
      jobId: job.id,
      targetKind: job.targetKind,
      topicId: job.topicId,
      baseRevision: job.baseRevision,
      status: job.status,
    });
    return job;
  }

  for (const topic of topics) {
    const thread = topic.threads.find((item) => item.id === input.entityId);
    if (!thread) continue;
    if (topic.status !== "active" || thread.status !== "active") throw new Error("Thread 当前不可治理");
    const job = createGovernanceTickJob({
      targetKind: "thread",
      topicId: topic.id,
      threadId: thread.id,
      userId: input.userId,
      baseRevision: thread.revision,
      payload: {
        targetKind: "thread",
        topicId: topic.id,
        threadId: thread.id,
        baseRevision: thread.revision,
        snapshot: { topic, thread },
        dueReason: "manual",
        scheduledAt: nowIso(now),
      },
      idempotencyKey: buildManualJobIdempotencyKey({
        targetKind: "thread",
        topicId: topic.id,
        threadId: thread.id,
        requestKey: input.idempotencyKey,
      }),
      availableAt: nowIso(now),
      createdAt: nowIso(now),
    });
    logGovernanceTick("enqueued manual governance job", {
      jobId: job.id,
      targetKind: job.targetKind,
      topicId: job.topicId,
      threadId: job.threadId,
      baseRevision: job.baseRevision,
      status: job.status,
    });
    return job;
  }

  throw new Error("未找到 Thread");
}

export function enqueueDueGovernanceTickJobs(input: { now?: Date; userId?: string } = {}) {
  const now = input.now ?? new Date();
  const topics = readTopicsSnapshot([]);
  const jobs: GovernanceTickJobRecord[] = [];

  for (const topic of topics) {
    const due = isTopicDue(topic, now);
    if (due) {
      jobs.push(
        createGovernanceTickJob({
          targetKind: "topic",
          topicId: topic.id,
          userId: input.userId,
          baseRevision: topic.revision,
          payload: topicPayload(topic, due),
          idempotencyKey: buildJobIdempotencyKey({
            targetKind: "topic",
            topicId: topic.id,
            baseRevision: topic.revision,
          }),
          availableAt: nowIso(now),
          createdAt: nowIso(now),
        }),
      );
    }
  }

  const activePairs = topics
    .filter((topic) => topic.status === "active")
    .flatMap((topic) => topic.threads.map((thread) => ({ topic, thread })));
  const dueThreads = selectDueThreads(activePairs.map((pair) => pair.thread), now);
  const pairByThreadId = new Map(activePairs.map((pair) => [pair.thread.id, pair]));
  for (const due of dueThreads) {
    const pair = pairByThreadId.get(due.thread.id);
    if (!pair) continue;
    jobs.push(
      createGovernanceTickJob({
        targetKind: "thread",
        topicId: pair.topic.id,
        threadId: pair.thread.id,
        userId: input.userId,
        baseRevision: pair.thread.revision,
        payload: threadPayload(pair.topic, pair.thread, due),
        idempotencyKey: buildJobIdempotencyKey({
          targetKind: "thread",
          topicId: pair.topic.id,
          threadId: pair.thread.id,
          baseRevision: pair.thread.revision,
        }),
        availableAt: nowIso(now),
        createdAt: nowIso(now),
      }),
    );
  }

  return jobs;
}

export function leaseAndDispatchGovernanceTickJob(input: {
  leaseOwner: string;
  leaseDurationMs: number;
  sendCommand: GovernanceTickDispatchSender;
  now?: Date;
  targetKind?: GovernanceTickTargetKind;
  llm?: GovernanceTickLlmPayload;
}) {
  const leased = acquireGovernanceTickJobLease({
    leaseOwner: input.leaseOwner,
    leaseDurationMs: input.leaseDurationMs,
    now: input.now,
    targetKind: input.targetKind,
    expiredLeaseGraceMs: DEFAULT_GOVERNANCE_TICK_EXPIRED_LEASE_GRACE_MS,
  });
  if (!leased) return null;
  const command: GovernanceTickMachineCommand = {
    type: commandTypeForGovernanceTarget(leased.targetKind),
    requestId: leased.requestId ?? `governance-tick-${leased.id}`,
    governanceJobId: leased.id,
    leaseOwner: leased.leaseOwner ?? input.leaseOwner,
    leaseToken: leased.leaseToken ?? "",
    targetKind: leased.targetKind,
    payload: leased.payload,
    ...(input.llm ? { llm: input.llm } : {}),
  };
  const sent = input.sendCommand(command);
  logGovernanceTick("dispatched lease to machine", {
    jobId: leased.id,
    targetKind: leased.targetKind,
    topicId: leased.topicId,
    threadId: leased.threadId,
    leaseOwner: command.leaseOwner,
    leaseExpiresAt: leased.leaseExpiresAt,
    attemptCount: leased.attemptCount,
    sent,
  });
  return { job: leased, command, sent };
}

export function dispatchReadyGovernanceTickJobsToMachines(input: {
  leaseOwner: string;
  limit?: number;
  leaseDurationMs?: number;
  now?: Date;
  llm?: GovernanceTickLlmPayload;
}): { processed: number; skippedOffline: boolean } {
  const userId = getCurrentUserId();
  const pendingCount = countPendingGovernanceTickJobs({
    now: input.now,
    expiredLeaseGraceMs: DEFAULT_GOVERNANCE_TICK_EXPIRED_LEASE_GRACE_MS,
  });
  if (pendingCount === 0) {
    return { processed: 0, skippedOffline: false };
  }
  if (!input.llm) {
    logGovernanceTick("skipped governance dispatch without llm runtime", {
      userId,
      pendingCount,
      leaseOwner: input.leaseOwner,
    });
    return { processed: 0, skippedOffline: false };
  }
  const hub = getTunnelHub();
  const onlineMachineIds = hub.getOnlineMachineIdsForUser(userId);
  if (onlineMachineIds.length === 0) {
    logGovernanceTick("skipped governance dispatch because machine offline", {
      userId,
      pendingCount,
      leaseOwner: input.leaseOwner,
    });
    return { processed: 0, skippedOffline: true };
  }

  const machineId = onlineMachineIds[0];
  const limit = Math.max(0, input.limit ?? 10);
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const dispatched = leaseAndDispatchGovernanceTickJob({
      leaseOwner: input.leaseOwner,
      leaseDurationMs: input.leaseDurationMs ?? DEFAULT_GOVERNANCE_TICK_LEASE_MS,
      now: input.now,
      llm: input.llm,
      sendCommand(command) {
        hub.sendGovernanceTick({ machineId, command });
        return true;
      },
    });
    if (!dispatched) break;
    processed += 1;
  }

  logGovernanceTick("dispatch ready governance jobs completed", {
    userId,
    machineId,
    pendingCount,
    processed,
    limit,
    leaseOwner: input.leaseOwner,
  });
  return { processed, skippedOffline: false };
}

export function reconcileGovernanceTickMachineHello(input: {
  machineId: string;
  userId: string;
  runningGovernanceJobIds: string[];
  leaseDurationMs?: number;
  now?: Date;
}) {
  const uniqueJobIds = Array.from(new Set(input.runningGovernanceJobIds));
  let renewed = 0;
  for (const jobId of uniqueJobIds) {
    const job = renewGovernanceTickJobLeaseFromHello({
      jobId,
      userId: input.userId,
      machineId: input.machineId,
      leaseDurationMs: input.leaseDurationMs ?? DEFAULT_GOVERNANCE_TICK_LEASE_MS,
      now: input.now,
    });
    if (job) renewed += 1;
  }
  if (uniqueJobIds.length > 0) {
    logGovernanceTick("reconciled running governance jobs from machine", {
      machineId: input.machineId,
      userId: input.userId,
      checked: uniqueJobIds.length,
      renewed,
    });
  }
  return { checked: uniqueJobIds.length, renewed };
}

export function registerGovernanceTickTunnelCallbacks() {
  setTunnelGovernanceTickResultListener((result, context) => {
    logGovernanceTick("received machine result", {
      jobId: result.governanceJobId,
      type: result.type,
      ok: result.ok,
      leaseOwner: result.leaseOwner,
      userId: context?.userId,
      machineId: context?.machineId,
    });
    if (context?.userId) {
      void runWithUserContext(context.userId, () => handleGovernanceTickMachineResult({ result }));
      return;
    }
    void handleGovernanceTickMachineResult({ result });
  });
}

type GovernanceLeaseValidation =
  | { ok: true; acceptLeaseTokenMismatch?: boolean; acceptedExpiredLease?: boolean }
  | { ok: false; reason: string };

function validateLeasedJob(input: {
  job: GovernanceTickJobRecord;
  leaseOwner: string;
  leaseToken: string;
  now: Date;
}): GovernanceLeaseValidation {
  if (input.job.status !== "leased" && input.job.status !== "expired") {
    return { ok: false, reason: `invalid_job_status:${input.job.status}` };
  }
  if (input.job.leaseOwner !== input.leaseOwner) {
    return { ok: false, reason: "lease_owner_mismatch" };
  }
  // 同一 cloud orchestrator 可能在治理长任务未回执前重租同一个 job，导致旧 token 回执。
  // 这里仅放宽 token/过期校验；owner、baseRevision 和实体 revision 仍负责防止跨编排者或脏快照落库。
  const tokenMismatch = input.job.leaseToken !== input.leaseToken;
  const acceptedExpiredLease =
    input.job.status === "expired" ||
    Boolean(input.job.leaseExpiresAt && new Date(input.job.leaseExpiresAt).getTime() <= input.now.getTime());
  if (tokenMismatch || acceptedExpiredLease) {
    logGovernanceTick("accepting governance result with relaxed lease validation", {
      jobId: input.job.id,
      status: input.job.status,
      leaseOwner: input.leaseOwner,
      tokenMismatch,
      acceptedExpiredLease,
      leaseExpiresAt: input.job.leaseExpiresAt,
    });
  }
  return {
    ok: true,
    acceptLeaseTokenMismatch: tokenMismatch,
    acceptedExpiredLease,
  };
}

function currentRevisionForOutcome(outcome: GovernanceTickOutcome) {
  if (outcome.targetKind === "thread") return findThreadById(outcome.threadId)?.revision;
  return findTopicById(outcome.topicId)?.revision;
}

function durationMs(startedAt: string | undefined, finishedAt: string) {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const finished = Date.parse(finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished)) return 0;
  return Math.max(0, finished - started);
}

function recordDispatcherTickHistory(input: {
  job: GovernanceTickJobRecord;
  outcome: GovernanceTickOutcome;
  dispatch?: DispatchThreadActionsResult;
  finishedAt: string;
}) {
  const startedAt = input.job.leasedAt ?? input.job.createdAt;
  const run = createAgentRun({
    id: input.job.id,
    topicId: input.outcome.topicId,
    threadId: input.outcome.targetKind === "thread" ? input.outcome.threadId : undefined,
    role: input.outcome.targetKind === "thread" ? "thread_runner" : "topic_runner",
    status: "completed",
    idempotencyKey: `governance-tick-run:${input.job.id}`,
    startedAt,
  });

  let phase: LoopTickPhase = "completed";
  let ok = true;
  let failureReason: string | undefined;
  let errorKind: string | undefined;
  let assessment: string | undefined;
  let confidence: string | undefined;
  let pauseReason: "failure_threshold" | undefined;
  let silentCount = 0;
  let failureCount: number | undefined;

  if (input.outcome.targetKind === "thread") {
    const { result } = input.outcome;
    ok = result.ok;
    phase = !result.ok ? "failed" : input.dispatch && input.dispatch.errors.length > 0 ? "dispatch_partial_failure" : "completed";
    failureReason = result.ok
      ? input.dispatch && input.dispatch.errors.length > 0
        ? `dispatch_partial_failure(${input.dispatch.errors.length})`
        : undefined
      : result.error.kind;
    errorKind = result.ok ? undefined : result.error.kind;
    assessment = result.ok ? result.output.assessment : undefined;
    confidence = result.ok ? result.output.confidence : undefined;
    pauseReason = result.pauseReason === "failure_threshold" ? "failure_threshold" : undefined;
    silentCount = input.dispatch?.silentReasons.length ?? 0;
    failureCount = result.patch.failureCount;
  } else {
    ok = input.outcome.ok;
    phase = input.outcome.ok ? "completed" : "failed";
    failureReason = input.outcome.ok ? undefined : input.outcome.error ?? "topic_tick_failed";
    errorKind = input.outcome.ok ? undefined : input.outcome.error ?? "topic_tick_failed";
    silentCount = input.outcome.patch.silentCount ?? 0;
    failureCount = input.outcome.patch.failureCount;
  }

  recordLoopEntity({
    kind: input.outcome.targetKind,
    entityId: input.outcome.targetKind === "thread" ? input.outcome.threadId : input.outcome.topicId,
    parentId: input.outcome.targetKind === "thread" ? input.outcome.topicId : undefined,
    agentRunId: run.id,
    startedAt,
    finishedAt: input.finishedAt,
    durationMs: durationMs(startedAt, input.finishedAt),
    ok,
    phase,
    failureReason,
    errorKind,
    dispatchedTaskCount: input.dispatch?.dispatchedTasks.length ?? 0,
    updatedTaskCount: input.dispatch?.updatedTasks.length ?? 0,
    cancelledTaskCount: input.dispatch?.cancelledTasks.length ?? 0,
    sentMessageCount: input.dispatch?.sentMessages.length ?? 0,
    silentCount,
    assessment,
    confidence,
    pauseReason,
    failureCount,
  });

  updateAgentRun({ id: run.id, status: ok ? "completed" : "failed", finishedAt: input.finishedAt });
}

function buildActionKey(jobId: string, kind: string, ordinal: number) {
  return createIdempotencyKey("governance_tick_action", jobId, kind, String(ordinal));
}

function defaultActionCallbacks(jobId: string, invoke?: LlmInvoke): Required<GovernanceTickActionCallbacks> {
  const counters: Record<string, number> = {};
  const nextKey = (kind: string) => {
    counters[kind] = (counters[kind] ?? 0) + 1;
    return buildActionKey(jobId, kind, counters[kind]);
  };
  return {
    dispatchTask: (request) => dispatchTaskFromThread(request, { idempotencyKey: nextKey("dispatch_task"), invoke }),
    updateTask: (request) => updateTaskFromThread(request, { idempotencyKey: nextKey("update_task") }),
    cancelTask: (request) => cancelTaskFromThread(request, { idempotencyKey: nextKey("cancel_task") }),
    sendThreadMessage: async (request) => {
      const traceId = nextKey("post_message");
      const conv = appendThreadMessage({ ...request, traceId });
      const inbox = appendInboxMessage({
        topicId: request.topicId,
        threadId: request.threadId,
        text: request.text,
        severity: request.severity,
        source: "thread_tick",
        traceId,
      });
      return { conversationMessageId: conv.conversationMessageId, inboxItemId: inbox.inboxMessageId };
    },
  };
}

async function applyThreadOutcome(input: {
  job: GovernanceTickJobRecord;
  outcome: GovernanceTickThreadOutcome;
  callbacks?: GovernanceTickActionCallbacks;
  invoke?: LlmInvoke;
}) {
  const callbacks = { ...defaultActionCallbacks(input.job.id, input.invoke), ...(input.callbacks ?? {}) };
  let dispatch: DispatchThreadActionsResult | undefined;
  const result = input.outcome.result;
  if (result.ok) {
    const actionCounters: Record<string, number> = {};
    const nextActionKey = (kind: string) => {
      actionCounters[kind] = (actionCounters[kind] ?? 0) + 1;
      return buildActionKey(input.job.id, kind, actionCounters[kind]);
    };
    const currentTasks =
      input.outcome.currentTasks ??
      goalsSnapshotThreadTaskView.listByThread({
        topicId: input.outcome.topicId,
        threadId: input.outcome.threadId,
      });
    dispatch = await dispatchThreadActions({
      topicId: input.outcome.topicId,
      threadId: input.outcome.threadId,
      output: result.output,
      currentTasks,
      callbacks: {
        dispatchTask: (request) => callbacks.dispatchTask(request, { idempotencyKey: nextActionKey("dispatch_task"), invoke: input.invoke }),
        updateTask: (request) => callbacks.updateTask(request, { idempotencyKey: nextActionKey("update_task") }),
        cancelTask: (request) => callbacks.cancelTask(request, { idempotencyKey: nextActionKey("cancel_task") }),
        sendThreadMessage: async (request) => {
          const traceId = nextActionKey("post_message");
          return callbacks.sendThreadMessage({ ...request, traceId });
        },
      },
    });
    if (dispatch.errors.length > 0) return { ok: false as const, reason: "dispatch_partial_failure", dispatch };
  }

  try {
    updateThread(
      input.outcome.threadId,
      {
        loopInterval: result.patch.loopInterval,
        status: result.patch.status,
        lastTickAt: result.patch.lastTickAt,
        nextTickAt: result.patch.nextTickAt,
        memory: result.patch.memory,
        silentCount: result.patch.silentCount,
        failureCount: result.patch.failureCount,
      },
      input.outcome.baseRevision,
    );
  } catch (error) {
    if (error instanceof ThreadRevisionMismatchError) {
      return { ok: false as const, reason: "stale_revision", staleRevision: true, dispatch };
    }
    throw error;
  }

  return { ok: true as const, dispatch };
}

function applyTopicOutcome(input: {
  outcome: GovernanceTickTopicOutcome;
}) {
  try {
    updateTopic(input.outcome.topicId, input.outcome.patch, input.outcome.baseRevision);
  } catch (error) {
    if (error instanceof TopicRevisionMismatchError) {
      return { ok: false as const, reason: "stale_revision", staleRevision: true };
    }
    throw error;
  }
  return { ok: true as const };
}

export async function persistGovernanceTickOutcome(input: {
  leaseOwner: string;
  leaseToken: string;
  outcome: GovernanceTickOutcome;
  now?: Date;
  callbacks?: GovernanceTickActionCallbacks;
  invoke?: LlmInvoke;
}): Promise<GovernanceTickOutcomeProcessResult> {
  const job = getGovernanceTickJob(input.outcome.governanceJobId);
  if (!job) return { ok: false, job: null, reason: "job_not_found" };
  if (job.status === "completed") {
    return { ok: true, job, duplicate: true };
  }
  const leaseValidation = validateLeasedJob({
    job,
    leaseOwner: input.leaseOwner,
    leaseToken: input.leaseToken,
    now: input.now ?? new Date(),
  });
  if (!leaseValidation.ok) {
    logGovernanceTick("rejected machine result by lease validation", {
      jobId: job.id,
      reason: leaseValidation.reason,
      jobStatus: job.status,
      jobLeaseOwner: job.leaseOwner,
      resultLeaseOwner: input.leaseOwner,
    });
    return { ok: false, job, reason: leaseValidation.reason };
  }
  const acceptLeaseTokenMismatch =
    leaseValidation.acceptLeaseTokenMismatch === true || leaseValidation.acceptedExpiredLease === true;
  if (job.baseRevision !== input.outcome.baseRevision) {
    failGovernanceTickJob({
      jobId: job.id,
      leaseOwner: input.leaseOwner,
      leaseToken: input.leaseToken,
      error: "base_revision_mismatch",
      outcome: input.outcome as unknown as Record<string, unknown>,
      acceptLeaseTokenMismatch,
    });
    logGovernanceTick("rejected outcome by base revision mismatch", {
      jobId: job.id,
      jobBaseRevision: job.baseRevision,
      outcomeBaseRevision: input.outcome.baseRevision,
      targetKind: input.outcome.targetKind,
      topicId: input.outcome.topicId,
    });
    return { ok: false, job: getGovernanceTickJob(job.id), reason: "base_revision_mismatch", staleRevision: true };
  }

  const currentRevision = currentRevisionForOutcome(input.outcome);
  if (currentRevision !== job.baseRevision) {
    const failed = failGovernanceTickJob({
      jobId: job.id,
      leaseOwner: input.leaseOwner,
      leaseToken: input.leaseToken,
      error: "stale_revision",
      outcome: input.outcome as unknown as Record<string, unknown>,
      acceptLeaseTokenMismatch,
    });
    logGovernanceTick("rejected outcome by stale revision", {
      jobId: job.id,
      targetKind: input.outcome.targetKind,
      topicId: input.outcome.topicId,
      currentRevision,
      jobBaseRevision: job.baseRevision,
    });
    return { ok: false, job: failed ?? getGovernanceTickJob(job.id), reason: "stale_revision", staleRevision: true };
  }

  let applied:
    | { ok: true; dispatch?: DispatchThreadActionsResult }
    | { ok: false; reason: string; staleRevision?: boolean; dispatch?: DispatchThreadActionsResult };
  if (input.outcome.targetKind === "thread") {
    applied = await applyThreadOutcome({
      job,
      outcome: input.outcome,
      callbacks: input.callbacks,
      invoke: input.invoke,
    });
  } else {
    applied = applyTopicOutcome({ outcome: input.outcome });
  }

  logGovernanceTick("applied machine outcome", {
    jobId: job.id,
    targetKind: input.outcome.targetKind,
    topicId: input.outcome.topicId,
    threadId: input.outcome.targetKind === "thread" ? input.outcome.threadId : undefined,
    outcomeOk: input.outcome.targetKind === "thread" ? input.outcome.result.ok : input.outcome.ok,
    appliedOk: applied.ok,
    reason: applied.ok ? undefined : applied.reason,
    dispatchErrors: applied.dispatch?.errors.length,
  });

  if (!applied.ok) {
    if (applied.staleRevision) {
      const failed = failGovernanceTickJob({
        jobId: job.id,
        leaseOwner: input.leaseOwner,
        leaseToken: input.leaseToken,
        error: applied.reason,
        outcome: input.outcome as unknown as Record<string, unknown>,
        acceptLeaseTokenMismatch,
      });
      logGovernanceTick("failed outcome after apply stale revision", {
        jobId: job.id,
        targetKind: input.outcome.targetKind,
        reason: applied.reason,
      });
      return { ok: false, job: failed ?? getGovernanceTickJob(job.id), reason: applied.reason, staleRevision: true, dispatch: applied.dispatch };
    }
    return { ok: false, job, reason: applied.reason, dispatch: applied.dispatch };
  }

  const finishedAt = nowIso(input.now);
  const completed = completeGovernanceTickJob({
    jobId: job.id,
    leaseOwner: input.leaseOwner,
    leaseToken: input.leaseToken,
    outcome: input.outcome as unknown as Record<string, unknown>,
    finishedAt,
    acceptLeaseTokenMismatch,
  });
  if (!completed) {
    logGovernanceTick("complete job failed", {
      jobId: job.id,
      targetKind: input.outcome.targetKind,
      topicId: input.outcome.topicId,
      leaseOwner: input.leaseOwner,
    });
    return { ok: false, job: getGovernanceTickJob(job.id), reason: "complete_failed", dispatch: applied.dispatch };
  }
  try {
    recordDispatcherTickHistory({ job: completed, outcome: input.outcome, dispatch: applied.dispatch, finishedAt });
    logGovernanceTick("recorded dispatcher tick history", {
      jobId: completed.id,
      targetKind: input.outcome.targetKind,
      topicId: input.outcome.topicId,
      threadId: input.outcome.targetKind === "thread" ? input.outcome.threadId : undefined,
      finishedAt,
    });
  } catch (error) {
    console.warn("[governance] record dispatcher tick history failed", error);
  }
  try {
    if (input.outcome.targetKind === "thread") {
      pushGovernanceChangeNotification({
        topicId: input.outcome.topicId,
        threadId: input.outcome.threadId,
        dispatch: applied.dispatch,
        paused: input.outcome.result.pauseReason === "failure_threshold",
        traceId: `dispatcher:${job.id}`,
      });
      logGovernanceTick("pushed thread governance notification", {
        jobId: completed.id,
        topicId: input.outcome.topicId,
        threadId: input.outcome.threadId,
        outcomeOk: input.outcome.result.ok,
        paused: input.outcome.result.pauseReason === "failure_threshold",
      });
    } else if (!input.outcome.ok || input.outcome.patch.phase === "failed") {
      pushGovernanceChangeNotification({
        topicId: input.outcome.topicId,
        topicFailureReason: input.outcome.error ?? (input.outcome.patch.phase === "failed" ? "主题治理进入失败状态" : undefined),
        traceId: `dispatcher:${job.id}`,
      });
      logGovernanceTick("pushed topic governance notification", {
        jobId: completed.id,
        topicId: input.outcome.topicId,
        outcomeOk: input.outcome.ok,
        error: input.outcome.error,
        phase: input.outcome.patch.phase,
      });
    }
  } catch (error) {
    console.warn("[governance] push dispatcher change notification failed", error);
  }
  return { ok: true, job: completed, dispatch: applied.dispatch };
}

export async function handleGovernanceTickMachineResult(input: {
  result: GovernanceTickMachineResult;
  now?: Date;
  callbacks?: GovernanceTickActionCallbacks;
  invoke?: LlmInvoke;
}) {
  const job = getGovernanceTickJob(input.result.governanceJobId);
  if (!job) return { ok: false as const, job: null, reason: "job_not_found" };
  if (!input.result.ok || !input.result.outcome) {
    const leaseValidation = validateLeasedJob({
      job,
      leaseOwner: input.result.leaseOwner,
      leaseToken: input.result.leaseToken,
      now: input.now ?? new Date(),
    });
    if (!leaseValidation.ok) {
      logGovernanceTick("rejected failed machine result by lease validation", {
        jobId: job.id,
        reason: leaseValidation.reason,
        jobStatus: job.status,
      });
      return { ok: false as const, job, reason: leaseValidation.reason };
    }
    const failed = failGovernanceTickJob({
      jobId: input.result.governanceJobId,
      leaseOwner: input.result.leaseOwner,
      leaseToken: input.result.leaseToken,
      error: input.result.error ?? "machine_result_failed",
      acceptLeaseTokenMismatch:
        leaseValidation.acceptLeaseTokenMismatch === true || leaseValidation.acceptedExpiredLease === true,
    });
    logGovernanceTick("persisted failed machine result", {
      jobId: input.result.governanceJobId,
      error: input.result.error ?? "machine_result_failed",
      persisted: Boolean(failed),
    });
    return failed
      ? { ok: false as const, job: failed, reason: "machine_result_failed" }
      : { ok: false as const, job, reason: "machine_result_rejected" };
  }
  return persistGovernanceTickOutcome({
    leaseOwner: input.result.leaseOwner,
    leaseToken: input.result.leaseToken,
    outcome: input.result.outcome,
    now: input.now,
    callbacks: input.callbacks,
    invoke: input.invoke,
  });
}
