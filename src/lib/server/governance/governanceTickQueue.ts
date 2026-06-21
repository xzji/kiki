/**
 * governanceTickQueue — 治理 tick job 队列管理。
 *
 * 职责：
 *  - enqueue（自动 due / 手动）
 *  - lease 到本地 worker / 远端 daemon 之间共用的 lease + 派发钩子
 *  - reconcile machine HELLO（renew running jobs 的 lease）
 *
 * 不做的事：
 *  - 不连 tunnel（transport 由 governanceTickTransport 管）
 *  - 不写回 outcome（由 dispatcher 主入口 persistGovernanceTickOutcome 管）
 *
 * idempotency key 策略集中在本模块（buildJob / buildManual），让重复 enqueue
 * 在同一 baseRevision / 同一 manual requestKey 上落到同一 job。
 */

import { createIdempotencyKey } from "@/lib/opaqueIds";
import {
  acquireGovernanceTickJobLease,
  createGovernanceTickJob,
  failGovernanceTickJob,
  renewGovernanceTickJobLeaseFromHello,
  type GovernanceTickJobPayload,
  type GovernanceTickJobRecord,
  type GovernanceTickTargetKind,
} from "@/lib/server/repositories/governanceTickJobsRepository";
import { readComposedTopicsSnapshot } from "@/lib/server/runtime/composedTopicsView";
import { isThreadDue, selectDueThreads } from "@/lib/server/governance/threadScheduler";
import { isTopicDue } from "@/lib/server/governance/topicScheduler";
import {
  buildThreadSnapshot,
  buildTopicSnapshot,
  checkLeasedRevisionStaleness,
  refreshGovernancePayload,
} from "@/lib/server/governance/governanceTickSnapshot";
import {
  commandTypeForGovernanceTarget,
  type GovernanceTickLlmPayload,
  type GovernanceTickMachineCommand,
} from "@/lib/server/governance/governanceTickProtocol";
import type { Thread, Topic } from "@/types/topic";

export const DEFAULT_GOVERNANCE_TICK_LEASE_MS = 10 * 60 * 1000;
export const DEFAULT_GOVERNANCE_TICK_EXPIRED_LEASE_GRACE_MS = 5 * 60 * 1000;

export type GovernanceTickDispatchSender = (command: GovernanceTickMachineCommand) => boolean;

function nowIso(now = new Date()) {
  return now.toISOString();
}

function logQueue(message: string, fields: Record<string, unknown> = {}) {
  console.info("[governance_tick_queue]", message, fields);
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
    snapshot: buildThreadSnapshot(topic, thread),
    dueReason: due?.reason,
    scheduledAt: due?.scheduledAt.toISOString(),
  };
}

function topicPayload(topic: Topic, due: NonNullable<ReturnType<typeof isTopicDue>>): GovernanceTickJobPayload {
  return {
    targetKind: "topic",
    topicId: topic.id,
    baseRevision: topic.revision,
    snapshot: buildTopicSnapshot(topic),
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
  const topics = readComposedTopicsSnapshot([]);

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
        snapshot: buildTopicSnapshot(topic),
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
    logQueue("enqueued manual governance job", {
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
        snapshot: buildThreadSnapshot(topic, thread),
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
    logQueue("enqueued manual governance job", {
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
  const topics = readComposedTopicsSnapshot([]);
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

/**
 * Lease 一个 job 并通过 sender 派发命令。
 *
 * 顺序：
 *  1. acquire lease
 *  2. checkLeasedRevisionStaleness — entity 已变更则放弃 lease（避免烧 LLM）
 *  3. refreshGovernancePayload — 用最新 envelope 数据刷新 LLM 输入
 *  4. 构造 command + 调 sender 派发
 */
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

  const staleCheck = checkLeasedRevisionStaleness(leased);
  if (staleCheck.stale) {
    failGovernanceTickJob({
      jobId: leased.id,
      leaseOwner: leased.leaseOwner ?? input.leaseOwner,
      leaseToken: leased.leaseToken,
      error: "stale_revision_at_lease",
    });
    logQueue("abandoned lease due to stale revision before dispatch", {
      jobId: leased.id,
      targetKind: leased.targetKind,
      topicId: leased.topicId,
      threadId: leased.threadId,
      jobBaseRevision: leased.baseRevision,
      currentRevision: staleCheck.currentRevision,
    });
    return null;
  }

  const refreshedPayload = refreshGovernancePayload(leased.payload);
  const command: GovernanceTickMachineCommand = {
    type: commandTypeForGovernanceTarget(leased.targetKind),
    requestId: leased.requestId ?? `governance-tick-${leased.id}`,
    governanceJobId: leased.id,
    leaseOwner: leased.leaseOwner ?? input.leaseOwner,
    leaseToken: leased.leaseToken ?? "",
    targetKind: leased.targetKind,
    payload: refreshedPayload,
    ...(input.llm ? { llm: input.llm } : {}),
  };
  const sent = input.sendCommand(command);
  logQueue("dispatched lease to machine", {
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
    logQueue("reconciled running governance jobs from machine", {
      machineId: input.machineId,
      userId: input.userId,
      checked: uniqueJobIds.length,
      renewed,
    });
  }
  return { checked: uniqueJobIds.length, renewed };
}
