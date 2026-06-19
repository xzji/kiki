import { createIdempotencyKey } from "@/lib/opaqueIds";
import {
  buildThreadActionDetails,
  buildTopicActionDetails,
  type GovernanceActionPresentation,
} from "@/lib/server/governance/governanceActionPresentation";
import { pushGovernanceChangeNotification } from "@/lib/server/governance/governanceChangeNotifications";
import { type DispatchThreadActionsResult } from "@/lib/server/governance/dispatchActions";
import { applyThreadTickResult } from "@/lib/server/governance/applyThreadTickResult";
import type {
  CancelTaskRequest,
  DispatchTaskRequest,
  SendThreadMessageRequest,
  UpdateTaskRequest,
} from "@/lib/server/services/dispatchTaskFromThread";
import {
  type GovernanceTickMachineCommand,
  type GovernanceTickMachineResult,
  type GovernanceTickOutcome,
  type GovernanceTickThreadOutcome,
  type GovernanceTickTopicOutcome,
} from "@/lib/server/governance/governanceTickProtocol";
import { recordEntity as recordLoopEntity, type LoopTickPhase } from "@/lib/server/observability/loopTickLog";
import { createAgentRun, updateAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { appendThreadMessage } from "@/lib/server/repositories/conversationMessagesRepository";
import {
  completeGovernanceTickJob,
  failGovernanceTickJob,
  getGovernanceTickJob,
  requeueGovernanceTickJobForRetry,
  type GovernanceTickJobRecord,
} from "@/lib/server/repositories/governanceTickJobsRepository";
import { appendInboxMessage } from "@/lib/server/repositories/inboxRepository";
import { findThreadById } from "@/lib/server/repositories/threadsRepository";
import { TopicRevisionMismatchError, updateTopic } from "@/lib/server/repositories/topicsRepository";
import {
  cancelTaskFromThread,
  dispatchTaskFromThread,
  updateTaskFromThread,
} from "@/lib/server/services/dispatchTaskFromThread";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { Thread, Topic } from "@/types/topic";

// §candidate-2 P3b：lease / expire 默认常量集中在 governanceTickQueue。
// 这里通过 alias 引用，避免本文件维护副本。

export type GovernanceTickOutcomeProcessResult =
  | { ok: true; job: GovernanceTickJobRecord; duplicate?: boolean; dispatch?: DispatchThreadActionsResult }
  | { ok: false; job: GovernanceTickJobRecord | null; reason: string; staleRevision?: boolean; dispatch?: DispatchThreadActionsResult };

// §candidate-2 P3b：GovernanceTickDispatchSender 由 governanceTickQueue 拥有，
// 通过下面的 re-export 暴露。

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

// §candidate-2 P3b：enqueue / lease / reconcile 已迁移到 governanceTickQueue，
// 通过下面的 re-export 兼容旧 import 路径。


export {
  enqueueDueGovernanceTickJobs,
  enqueueManualGovernanceTickJob,
  leaseAndDispatchGovernanceTickJob,
  reconcileGovernanceTickMachineHello,
} from "@/lib/server/governance/governanceTickQueue";
export type { GovernanceTickDispatchSender } from "@/lib/server/governance/governanceTickQueue";



// §candidate-2 P3c：transport 已迁移到 governanceTickTransport。
// dispatchReadyGovernanceTickJobsToMachines re-export 自该模块；
// registerGovernanceTickTunnelCallbacks 通过 callback 注入避免循环依赖。
export { dispatchReadyGovernanceTickJobsToMachines } from "@/lib/server/governance/governanceTickTransport";

import { registerGovernanceTickTunnelCallbacks as registerTransportCallbacks } from "@/lib/server/governance/governanceTickTransport";

export function registerGovernanceTickTunnelCallbacks() {
  registerTransportCallbacks({
    handleResult: async ({ result }) => {
      await handleGovernanceTickMachineResult({ result });
    },
  });
}

// §candidate-2 P3d：lease + revision 校验已迁移到 governanceTickValidation。
// dispatcher 改用 import；GovernanceLeaseValidation 类型也在该模块。
import {
  currentRevisionForOutcome,
  durationMs,
  validateLeasedJob,
} from "@/lib/server/governance/governanceTickValidation";

function topicSnapshotFromJob(job: GovernanceTickJobRecord) {
  const topic = job.payload.snapshot.topic;
  return topic && typeof topic === "object" && !Array.isArray(topic) ? topic as Topic : undefined;
}

function buildDispatcherActionDetails(input: {
  job: GovernanceTickJobRecord;
  outcome: GovernanceTickOutcome;
  dispatch?: DispatchThreadActionsResult;
}) {
  if (input.outcome.targetKind === "thread") {
    return buildThreadActionDetails({
      output: input.outcome.result.ok ? input.outcome.result.output : undefined,
      dispatch: input.dispatch,
    });
  }
  return buildTopicActionDetails({
    outcome: input.outcome,
    topicSnapshot: topicSnapshotFromJob(input.job),
  });
}

/**
 * 创建 / 完成 dispatcher 端的 agent_run。
 *
 * §candidate-1 P0：thread 路径的 loopTickLog 已由 applyThreadTickResult 写入，
 * 这里只负责 agent_run 行（id 复用 jobId 让两端 join 时简单）。
 * topic 路径仍由本函数写 loopTickLog（topicGovernor 还没接 module）。
 */
function recordDispatcherTickHistory(input: {
  job: GovernanceTickJobRecord;
  outcome: GovernanceTickOutcome;
  dispatch?: DispatchThreadActionsResult;
  actionDetails?: GovernanceActionPresentation[];
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

  let ok = true;

  if (input.outcome.targetKind === "thread") {
    // thread 路径的 loopTickLog 已由 applyThreadTickResult 写。
    // 这里只汇报 agent_run 状态。
    ok = input.outcome.result.ok;
  } else {
    ok = input.outcome.ok;
    const phase: LoopTickPhase = input.outcome.ok ? "completed" : "failed";
    const failureReason = input.outcome.ok ? undefined : input.outcome.error ?? "topic_tick_failed";
    recordLoopEntity({
      kind: "topic",
      entityId: input.outcome.topicId,
      agentRunId: run.id,
      startedAt,
      finishedAt: input.finishedAt,
      durationMs: durationMs(startedAt, input.finishedAt),
      ok,
      phase,
      failureReason,
      errorKind: failureReason,
      dispatchedTaskCount: 0,
      updatedTaskCount: 0,
      cancelledTaskCount: 0,
      sentMessageCount: 0,
      silentCount: input.outcome.patch.silentCount ?? 0,
      assessment: input.outcome.output?.assessment,
      confidence: input.outcome.output?.confidence,
      failureCount: input.outcome.patch.failureCount,
      actionDetails: input.actionDetails,
    });
  }

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
  startedAt: string;
  finishedAt: string;
}) {
  const callbacks = { ...defaultActionCallbacks(input.job.id, input.invoke), ...(input.callbacks ?? {}) };
  const result = input.outcome.result;

  // §candidate-1 P1：partial-failure 重试上限。达上限时强制 persist patch
  // 让 thread 推进，避免无限循环烧 LLM。partialAttemptCount 由
  // requeueGovernanceTickJobForRetry 累加。
  const partialAttempts = input.job.partialAttemptCount ?? 0;
  const persistPatchPolicy: "always" | "auto-skip-on-dispatch-errors" =
    partialAttempts >= GOVERNANCE_PARTIAL_RETRY_MAX
      ? "always"
      : "auto-skip-on-dispatch-errors";

  // §candidate-1 P0：dispatch + persist + record + notify 走共享尾路。
  // dispatcher 仍负责 agent_run / job 状态机。
  const startedAtMs = Date.parse(input.startedAt);
  const finishedAtMs = Date.parse(input.finishedAt);
  let applied: Awaited<ReturnType<typeof applyThreadTickResult>>;
  try {
    applied = await applyThreadTickResult({
      topic: { id: input.outcome.topicId } as never as Topic,
      thread: dispatcherThreadStub(input),
      baseRevision: input.outcome.baseRevision,
      agentRunId: input.job.id,
      result,
      currentTasks: input.outcome.currentTasks,
      callbacks: {
        dispatchTask: (request: DispatchTaskRequest) =>
          callbacks.dispatchTask(request, {
            idempotencyKey: buildActionKey(input.job.id, "dispatch_task", nextCounter(input.job.id, "dispatch_task")),
            invoke: input.invoke,
          }),
        updateTask: (request: UpdateTaskRequest) =>
          callbacks.updateTask(request, {
            idempotencyKey: buildActionKey(input.job.id, "update_task", nextCounter(input.job.id, "update_task")),
          }),
        cancelTask: (request: CancelTaskRequest) =>
          callbacks.cancelTask(request, {
            idempotencyKey: buildActionKey(input.job.id, "cancel_task", nextCounter(input.job.id, "cancel_task")),
          }),
        sendThreadMessage: (request: SendThreadMessageRequest) =>
          callbacks.sendThreadMessage({
            ...request,
            traceId: buildActionKey(input.job.id, "post_message", nextCounter(input.job.id, "post_message")),
          }),
      },
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs:
        Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
          ? Math.max(0, finishedAtMs - startedAtMs)
          : 0,
      persistPatchPolicy,
      traceIdPrefix: `dispatcher:${input.job.id}`,
    });
  } finally {
    resetCounters(input.job.id);
  }

  if (applied.dispatchHadErrors && !applied.patchPersisted) {
    return {
      ok: false as const,
      reason: "dispatch_partial_failure",
      dispatch: applied.dispatch,
      shouldRequeue: partialAttempts < GOVERNANCE_PARTIAL_RETRY_MAX,
      partialAttemptCount: partialAttempts,
    };
  }
  if (applied.staleRevision) {
    return { ok: false as const, reason: "stale_revision", staleRevision: true, dispatch: applied.dispatch };
  }
  if (!applied.patchPersisted) {
    return { ok: false as const, reason: "persist_failed", dispatch: applied.dispatch };
  }
  return {
    ok: true as const,
    dispatch: applied.dispatch,
    actionDetails: applied.actionDetails,
    /** dispatch 仍有 errors，但因为达到 retry 上限已强制 persist；caller 应 complete + 记录 final_partial */
    forcedFinalPartial: applied.dispatchHadErrors,
  };
}

const GOVERNANCE_PARTIAL_RETRY_MAX = 3;

// dispatcher 端没有完整 Thread 对象（只有 outcome.threadId + topicId + baseRevision）；
// applyThreadTickResult 只读 thread.id / thread.title / thread.revision。
// title 用 envelope 现取；revision 用 baseRevision；id 用 outcome.threadId。
function dispatcherThreadStub(input: {
  outcome: GovernanceTickThreadOutcome;
}) {
  const located = findThreadById(input.outcome.threadId);
  return {
    id: input.outcome.threadId,
    title: located?.title ?? "(unknown thread)",
    revision: input.outcome.baseRevision,
  } as never as Thread;
}

// 共享 counter map：同一 jobId 的同 kind 动作应使用单调递增 ordinal。
// 与原 dispatcher 行为一致；resetCounters 在 applyThreadOutcome 退出前清理。
const dispatcherActionCounters = new Map<string, Record<string, number>>();
function nextCounter(jobId: string, kind: string): number {
  const counters = dispatcherActionCounters.get(jobId) ?? {};
  counters[kind] = (counters[kind] ?? 0) + 1;
  dispatcherActionCounters.set(jobId, counters);
  return counters[kind];
}
function resetCounters(jobId: string): void {
  dispatcherActionCounters.delete(jobId);
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
    | { ok: true; dispatch?: DispatchThreadActionsResult; actionDetails?: GovernanceActionPresentation[] }
    | { ok: false; reason: string; staleRevision?: boolean; dispatch?: DispatchThreadActionsResult };
  if (input.outcome.targetKind === "thread") {
    const startedAt = job.leasedAt ?? job.createdAt;
    const finishedAtForApply = nowIso(input.now);
    applied = await applyThreadOutcome({
      job,
      outcome: input.outcome,
      callbacks: input.callbacks,
      invoke: input.invoke,
      startedAt,
      finishedAt: finishedAtForApply,
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
    // §candidate-1 P1：dispatch_partial_failure 在重试上限内 → requeue 让下一帧重跑 LLM；
    // 超过上限会进入 always policy（applied.ok=true + forcedFinalPartial）由下面的 complete 分支处理。
    if (
      applied.reason === "dispatch_partial_failure" &&
      "shouldRequeue" in applied &&
      applied.shouldRequeue === true
    ) {
      const requeued = requeueGovernanceTickJobForRetry({
        jobId: job.id,
        leaseOwner: input.leaseOwner,
        leaseToken: input.leaseToken,
        acceptLeaseTokenMismatch,
        now: input.now,
      });
      const previousAttempt =
        "partialAttemptCount" in applied && typeof applied.partialAttemptCount === "number"
          ? applied.partialAttemptCount
          : 0;
      logGovernanceTick("requeued job for partial-failure retry", {
        jobId: job.id,
        partialAttemptCount: previousAttempt + 1,
        max: GOVERNANCE_PARTIAL_RETRY_MAX,
        dispatchErrors: applied.dispatch?.errors.length,
      });
      return {
        ok: false,
        job: requeued ?? getGovernanceTickJob(job.id),
        reason: "dispatch_partial_failure",
        dispatch: applied.dispatch,
      };
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
    const actionDetails = buildDispatcherActionDetails({ job: completed, outcome: input.outcome, dispatch: applied.dispatch });
    recordDispatcherTickHistory({ job: completed, outcome: input.outcome, dispatch: applied.dispatch, actionDetails, finishedAt });
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
      // §candidate-1 P0：thread 路径的 change-notification 已由 applyThreadTickResult 推送，
      // 这里不再重复推。
      logGovernanceTick("thread governance notification handled by applyThreadTickResult", {
        jobId: completed.id,
        topicId: input.outcome.topicId,
        threadId: input.outcome.threadId,
        outcomeOk: input.outcome.result.ok,
        paused: input.outcome.result.pauseReason === "failure_threshold",
      });
    } else {
      const actionDetails = buildDispatcherActionDetails({ job: completed, outcome: input.outcome, dispatch: applied.dispatch });
      pushGovernanceChangeNotification({
        topicId: input.outcome.topicId,
        actionDetails,
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
