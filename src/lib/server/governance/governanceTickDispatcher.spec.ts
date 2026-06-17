import assert from "node:assert/strict";

import { handleGovernanceTickDaemonCommand } from "@/lib/daemon/remoteDaemonLoop";
import { deriveOpaqueId, normalizeSubGoalId } from "@/lib/opaqueIds";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import { getDatabase } from "@/lib/server/db/client";
import {
  acquireGovernanceTickJobLease,
  createGovernanceTickJob,
  expireGovernanceTickJobLeases,
  getGovernanceTickJob,
} from "@/lib/server/repositories/governanceTickJobsRepository";
import { listGovernanceTicksByEntity } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import {
  registerMachineWsConnection,
  unregisterMachineWsConnection,
  type MachineCommand,
  type MachineResult,
} from "@/lib/server/tunnel/tunnelHub";
import { findThreadById, updateThread } from "@/lib/server/repositories/threadsRepository";
import { findTopicById } from "@/lib/server/repositories/topicsRepository";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { readGoalsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import { writeGoalsProjection } from "@/lib/server/services/goalRuntimeService";
import type { DispatchTaskRequest } from "@/lib/server/services/dispatchTaskFromThread";
import type { ThreadTickResult } from "@/lib/server/thread/threadRunner";
import type { Goal } from "@/types/kiki";
import type { Thread, Topic } from "@/types/topic";

import {
  enqueueDueGovernanceTickJobs,
  dispatchReadyGovernanceTickJobsToMachines,
  enqueueManualGovernanceTickJob,
  handleGovernanceTickMachineResult,
  leaseAndDispatchGovernanceTickJob,
  persistGovernanceTickOutcome,
  reconcileGovernanceTickMachineHello,
  type GovernanceTickOutcome,
} from "./governanceTickDispatcher";

const TOPIC_ID = deriveOpaqueId("goal", "governance-tick-topic");
const THREAD_ID = deriveOpaqueId("sg", "governance-tick-thread");

function topicStatusToWorkflow(status: Topic["status"]): Goal["workflow"] {
  return {
    phase: status === "active" ? "executing" : status === "paused" ? "paused" : "completed",
    planDecision: "confirmed",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function seedGoal(input: {
  topic?: Partial<Topic>;
  thread?: Partial<Thread>;
}) {
  getDatabase().prepare(`DELETE FROM governance_tick_jobs`).run();
  const thread: Thread = {
    id: THREAD_ID,
    topicId: TOPIC_ID,
    title: "治理线程",
    intent: "持续跟踪",
    loopInterval: "daily",
    status: "active",
    lastTickAt: "2026-05-31T00:00:00.000Z",
    nextTickAt: "2026-06-01T00:00:00.000Z",
    memory: {},
    silentCount: 0,
    failureCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    ...input.thread,
  };
  const topic: Topic = {
    id: TOPIC_ID,
    title: "治理 Topic",
    summary: "",
    loop: { kind: "daily" },
    phase: "idle",
    lastTickAt: "2026-05-31T00:00:00.000Z",
    nextTickAt: "2026-06-01T00:00:00.000Z",
    silentCount: 0,
    failureCount: 0,
    threads: [thread],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    ...input.topic,
  };
  const goal: Goal = {
    id: topic.id,
    title: topic.title,
    deadline: "",
    progress: 0,
    summary: topic.summary,
    createdAt: topic.createdAt,
    workflow: topicStatusToWorkflow(topic.status),
    topicLoop: topic.loop,
    topicPhase: topic.phase,
    topicLastTickAt: topic.lastTickAt,
    topicNextTickAt: topic.nextTickAt,
    topicSilentCount: topic.silentCount,
    topicFailureCount: topic.failureCount,
    topicRevision: topic.revision,
    subGoals: [
      {
        id: thread.id,
        goalId: topic.id,
        title: thread.title,
        description: thread.intent,
        reviewInterval: thread.loopInterval as string,
        reviewTrigger: thread.loopTrigger,
        threadStatus: thread.status,
        lastTickAt: thread.lastTickAt,
        nextTickAt: thread.nextTickAt,
        threadMemory: thread.memory,
        silentCount: thread.silentCount,
        failureCount: thread.failureCount,
        threadRevision: thread.revision,
        tasks: [],
      },
    ],
  };
  const result = writeGoalsProjection([goal], readGoalsSnapshotMeta([]).revision);
  assert.equal(result.ok, true, "seed goal ok");
  return { topic, thread };
}

function makeThreadResult(overrides: Partial<Extract<ThreadTickResult, { ok: true }>> = {}): ThreadTickResult {
  return {
    ok: true,
    patch: {
      status: "active",
      lastTickAt: "2026-06-01T00:00:00.000Z",
      nextTickAt: "2026-06-02T00:00:00.000Z",
      memory: {},
      silentCount: 1,
      failureCount: 0,
    },
    output: {
      assessment: "本轮无外部动作",
      confidence: "high",
      actions: [{ kind: "silent", reason: "无新变化" }],
    },
    ...overrides,
  };
}

function createThreadJob(baseRevision = 0) {
  return createGovernanceTickJob({
    targetKind: "thread",
    topicId: TOPIC_ID,
    threadId: THREAD_ID,
    userId: "spec-test-user",
    baseRevision,
    payload: {
      targetKind: "thread",
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      baseRevision,
      snapshot: {},
    },
    idempotencyKey: `governance-tick-dispatcher-${baseRevision}-${Date.now()}-${Math.random()}`,
    createdAt: "2026-06-01T00:00:00.000Z",
  });
}

function createTopicJob(baseRevision = 0) {
  return createGovernanceTickJob({
    targetKind: "topic",
    topicId: TOPIC_ID,
    userId: "spec-test-user",
    baseRevision,
    payload: {
      targetKind: "topic",
      topicId: TOPIC_ID,
      baseRevision,
      snapshot: {},
    },
    idempotencyKey: `governance-tick-dispatcher-topic-${baseRevision}-${Date.now()}-${Math.random()}`,
    createdAt: "2026-06-01T00:00:00.000Z",
  });
}

function makeOutcome(jobId: string, result = makeThreadResult()): GovernanceTickOutcome {
  return {
    governanceJobId: jobId,
    targetKind: "thread",
    topicId: TOPIC_ID,
    threadId: THREAD_ID,
    baseRevision: 0,
    result,
    currentTasks: [],
  };
}

function makeFailedTopicOutcome(jobId: string): GovernanceTickOutcome {
  return {
    governanceJobId: jobId,
    targetKind: "topic",
    topicId: TOPIC_ID,
    baseRevision: 0,
    ok: false,
    error: "validation_error",
    patch: {
      phase: "failed",
      lastTickAt: "2026-06-01T00:30:00.000Z",
      nextTickAt: "2026-06-02T00:30:00.000Z",
      silentCount: 0,
      failureCount: 1,
    },
  };
}

export async function runGovernanceTickDispatcherSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // 1. due Topic/Thread 建 job，并能租约下发 command 边界。
  {
    ensureIsolatedPlanningSpecDataDir();
    seedGoal({});
    const jobs = enqueueDueGovernanceTickJobs({
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    assert.ok(jobs.some((job) => job.targetKind === "topic"), "due topic creates a job");
    assert.ok(jobs.some((job) => job.targetKind === "thread"), "due thread creates a job");

    const sentCommands: Array<{ governanceJobId: string; targetKind: string }> = [];
    const dispatched = leaseAndDispatchGovernanceTickJob({
      leaseOwner: "dispatcher-worker",
      leaseDurationMs: 10_000,
      now: new Date("2026-06-01T00:00:00.000Z"),
      sendCommand(command) {
        sentCommands.push({ governanceJobId: command.governanceJobId, targetKind: command.targetKind });
        return true;
      },
    });
    assert.ok(dispatched?.job);
    assert.equal(dispatched?.command.type, `${dispatched?.job.targetKind}_governance_tick`);
    assert.equal(dispatched?.command.leaseOwner, "dispatcher-worker");
    assert.equal(dispatched?.command.leaseToken, dispatched?.job.leaseToken);
    assert.equal(sentCommands.length, 1);
  }

  // 1a. 手动治理使用同一张 governance_tick_jobs 队列表，且不受 nextTickAt 限制。
  {
    ensureIsolatedPlanningSpecDataDir();
    seedGoal({
      topic: { nextTickAt: "2026-06-20T00:00:00.000Z" },
      thread: { nextTickAt: "2026-06-20T00:00:00.000Z" },
    });
    const topicJob = enqueueManualGovernanceTickJob({
      targetKind: "topic",
      entityId: TOPIC_ID,
      idempotencyKey: "manual-topic-spec",
      userId: "spec-test-user",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    const threadJob = enqueueManualGovernanceTickJob({
      targetKind: "thread",
      entityId: THREAD_ID,
      idempotencyKey: "manual-thread-spec",
      userId: "spec-test-user",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    assert.equal(topicJob.targetKind, "topic");
    assert.equal(topicJob.status, "queued");
    assert.equal(topicJob.payload.dueReason, "manual");
    assert.equal(threadJob.targetKind, "thread");
    assert.equal(threadJob.status, "queued");
    assert.equal(threadJob.payload.dueReason, "manual");
    assert.equal(threadJob.threadId, THREAD_ID);
  }

  // 1b. cloud orchestrator 路径能把 queued governance job 下发到在线 machine。
  {
    ensureIsolatedPlanningSpecDataDir();
    seedGoal({});
    const job = createThreadJob(0);
    const machineId = `machine-governance-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sent: MachineCommand[] = [];
    const sender = (command: MachineCommand) => {
      sent.push(command);
      return true;
    };
    registerMachineWsConnection({ machineId, userId: "spec-test-user", sender });
    try {
      const result = dispatchReadyGovernanceTickJobsToMachines({
        leaseOwner: "governance-orchestrator-worker",
        leaseDurationMs: 10_000,
        now: new Date("2026-06-01T00:00:00.000Z"),
        limit: 1,
          llm: {
            runtimeEnv: { id: "runtime-spec", name: "Spec Runtime", type: "local", workingDirectory: process.cwd() } as never,
            cwd: process.cwd(),
          },
      });
      assert.equal(result.processed, 1);
      assert.equal(result.skippedOffline, false);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.type, "thread_governance_tick");
      assert.equal("governanceJobId" in sent[0] ? sent[0].governanceJobId : undefined, job.id);
      assert.equal(getGovernanceTickJob(job.id)?.status, "leased");
    } finally {
      unregisterMachineWsConnection(machineId, sender);
    }

    // 1b-guard. 没有 LLM runtime payload 时不应租约/下发 governance job，
    // 否则 daemon 会必然失败并把 job 错误标记为 failed。
    {
      ensureIsolatedPlanningSpecDataDir();
      seedGoal({});
      const job = createThreadJob(0);
      const machineId = `machine-governance-no-llm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const sent: MachineCommand[] = [];
      const sender = (command: MachineCommand) => {
        sent.push(command);
        return true;
      };
      registerMachineWsConnection({ machineId, userId: "spec-test-user", sender });
      try {
        const result = dispatchReadyGovernanceTickJobsToMachines({
          leaseOwner: "governance-orchestrator-worker",
          leaseDurationMs: 10_000,
          now: new Date("2026-06-01T00:00:00.000Z"),
          limit: 1,
        });
        assert.equal(result.processed, 0);
        assert.equal(sent.length, 0);
        assert.equal(getGovernanceTickJob(job.id)?.status, "queued");
      } finally {
        unregisterMachineWsConnection(machineId, sender);
      }
    }
  }

  // 1c. WS hello 上报仍在本地执行的 governance job 后，重连调度不重复下发。
  {
    ensureIsolatedPlanningSpecDataDir();
    seedGoal({});
    const job = createThreadJob(0);
    const lease = acquireGovernanceTickJobLease({
      leaseOwner: "governance-hello-worker",
      leaseDurationMs: 1_000,
      now: new Date("2026-06-01T00:00:00.000Z"),
      targetKind: "thread",
    });
    assert.equal(lease?.id, job.id);
    const machineId = `machine-governance-hello-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const reconciled = reconcileGovernanceTickMachineHello({
      machineId,
      userId: "spec-test-user",
      runningGovernanceJobIds: [job.id, job.id],
      leaseDurationMs: 10_000,
      now: new Date("2026-06-01T00:00:02.000Z"),
    });
    assert.deepEqual(reconciled, { checked: 1, renewed: 1 });
    assert.equal(getGovernanceTickJob(job.id)?.status, "leased");

    const sent: MachineCommand[] = [];
    const sender = (command: MachineCommand) => {
      sent.push(command);
      return true;
    };
    registerMachineWsConnection({ machineId, userId: "spec-test-user", sender });
    try {
      const result = dispatchReadyGovernanceTickJobsToMachines({
        leaseOwner: "governance-hello-worker",
        leaseDurationMs: 10_000,
        now: new Date("2026-06-01T00:00:02.000Z"),
        limit: 1,
          llm: {
            runtimeEnv: { id: "runtime-spec", name: "Spec Runtime", type: "local", workingDirectory: process.cwd() } as never,
            cwd: process.cwd(),
          },
      });
      assert.equal(result.processed, 0);
      assert.equal(sent.length, 0, "running governance job reported by hello is not redispatched");
    } finally {
      unregisterMachineWsConnection(machineId, sender);
    }
  }

  // 1d. 远程端到端：云端下发 topic/thread tick，本地 daemon 返回 outcome，
  // 云端校验 lease + revision 后持久化。
  for (const targetKind of ["topic", "thread"] as const) {
    ensureIsolatedPlanningSpecDataDir();
    seedGoal({});
    const queued = enqueueDueGovernanceTickJobs({
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    assert.ok(queued.some((job) => job.targetKind === targetKind));
    const sentCommands: MachineCommand[] = [];
    const dispatched = leaseAndDispatchGovernanceTickJob({
      leaseOwner: `remote-e2e-${targetKind}`,
      leaseDurationMs: 10_000,
      now: new Date("2026-06-01T00:00:00.000Z"),
      targetKind,
      sendCommand(command) {
        sentCommands.push(command);
        return true;
      },
    });
    assert.ok(dispatched?.job);
    assert.equal(sentCommands.length, 1);
    assert.equal(sentCommands[0]?.type, `${targetKind}_governance_tick`);

    const invoke: LlmInvoke = async ({ context }) => {
      if (targetKind === "topic") {
        assert.deepEqual(context, { topicId: TOPIC_ID });
        return {
          rawText: "{}",
          parsed: {
            assessment: "topic still needs monitoring",
            confidence: "high",
            actions: [{ kind: "mark_running", reason: "signals remain active" }],
          },
        };
      }
      return {
        rawText: "{}",
        parsed: {
          assessment: "thread has no new signals",
          confidence: "high",
          actions: [{ kind: "silent", reason: "no task update" }],
        },
      };
    };
    const daemonResults: MachineResult[] = [];
    const daemonResult = await handleGovernanceTickDaemonCommand({
      command: sentCommands[0] as Extract<MachineCommand, { type: "topic_governance_tick" | "thread_governance_tick" }>,
      invoke,
      now: new Date("2026-06-01T00:00:01.000Z"),
      sendResult: async (result) => {
        daemonResults.push(result);
      },
    });
    assert.equal(daemonResults.length, 1);
    assert.equal(daemonResult.ok, true);
    assert.equal(getGovernanceTickJob(dispatched.job.id)?.status, "leased");
    assert.equal(findTopicById(TOPIC_ID)?.revision, 0, "daemon local execution does not write topic authority");
    assert.equal(findThreadById(THREAD_ID)?.revision, 0, "daemon local execution does not write thread authority");

    const persisted = await handleGovernanceTickMachineResult({
      result: daemonResult,
      now: new Date("2026-06-01T00:00:02.000Z"),
    });
    assert.equal(persisted.ok, true);
    assert.equal(persisted.job?.status, "completed");
    if (targetKind === "topic") {
      assert.equal(findTopicById(TOPIC_ID)?.revision, 1);
      assert.equal(findTopicById(TOPIC_ID)?.phase, "running");
      assert.equal(findThreadById(THREAD_ID)?.revision, 0);
    } else {
      assert.equal(findThreadById(THREAD_ID)?.revision, 1);
      assert.equal(findThreadById(THREAD_ID)?.silentCount, 1);
      assert.equal(findTopicById(TOPIC_ID)?.revision, 0);
    }
  }

  // 2. completed outcome 持久化 thread patch；重复 outcome 不再重复推进 revision。
  {
    ensureIsolatedPlanningSpecDataDir();
    seedGoal({});
    const job = createThreadJob(0);
    const lease = acquireGovernanceTickJobLease({
      leaseOwner: "outcome-worker",
      leaseDurationMs: 10_000,
      now: new Date("2026-06-01T00:00:00.000Z"),
      targetKind: "thread",
    });
    assert.equal(lease?.id, job.id);

    const outcome = makeOutcome(job.id);
    const beforeHistoryCount = listGovernanceTicksByEntity({ kind: "thread", entityId: THREAD_ID }).length;
    const first = await persistGovernanceTickOutcome({
      leaseOwner: "outcome-worker",
      leaseToken: lease!.leaseToken!,
      outcome,
      now: new Date("2026-06-01T00:00:01.000Z"),
    });
    assert.equal(first.ok, true);
    assert.equal(first.job?.status, "completed");
    assert.equal(findThreadById(THREAD_ID)?.revision, 1);
    const history = listGovernanceTicksByEntity({ kind: "thread", entityId: THREAD_ID });
    assert.equal(history.length, beforeHistoryCount + 1, "dispatcher path writes one loop tick history event");
    assert.equal(history[0]?.phase, "completed");
    assert.equal(history[0]?.silentCount, 1);

    const duplicate = await persistGovernanceTickOutcome({
      leaseOwner: "outcome-worker",
      leaseToken: lease!.leaseToken!,
      outcome,
      now: new Date("2026-06-01T00:00:02.000Z"),
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(findThreadById(THREAD_ID)?.revision, 1, "duplicate outcome does not persist again");
    assert.equal(
      listGovernanceTicksByEntity({ kind: "thread", entityId: THREAD_ID }).length,
      beforeHistoryCount + 1,
      "duplicate outcome does not append tick history again",
    );
  }

  // 3. stale revision 拒绝并把 job 标记 failed。
  {
    ensureIsolatedPlanningSpecDataDir();
    seedGoal({});
    const job = createThreadJob(0);
    const lease = acquireGovernanceTickJobLease({
      leaseOwner: "stale-worker",
      leaseDurationMs: 10_000,
      now: new Date("2026-06-01T00:10:00.000Z"),
      targetKind: "thread",
    });
    assert.equal(lease?.id, job.id);
    updateThread(THREAD_ID, { silentCount: 9 }, 0);

    const stale = await persistGovernanceTickOutcome({
      leaseOwner: "stale-worker",
      leaseToken: lease!.leaseToken!,
      outcome: makeOutcome(job.id),
      now: new Date("2026-06-01T00:10:01.000Z"),
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.staleRevision, true);
    assert.equal(getGovernanceTickJob(job.id)?.status, "failed");
    assert.equal(getGovernanceTickJob(job.id)?.lastError, "stale_revision");
  }

  // 4. topic tick 失败也要持久化 patch 并写治理历史，供回顾周期弹窗展示。
  {
    ensureIsolatedPlanningSpecDataDir();
    seedGoal({});
    const job = createTopicJob(0);
    const lease = acquireGovernanceTickJobLease({
      leaseOwner: "topic-failed-worker",
      leaseDurationMs: 10_000,
      now: new Date("2026-06-01T00:30:00.000Z"),
      targetKind: "topic",
    });
    assert.equal(lease?.id, job.id);

    const persisted = await persistGovernanceTickOutcome({
      leaseOwner: "topic-failed-worker",
      leaseToken: lease!.leaseToken!,
      outcome: makeFailedTopicOutcome(job.id),
      now: new Date("2026-06-01T00:30:01.000Z"),
    });
    assert.equal(persisted.ok, true);
    assert.equal(persisted.job?.status, "completed");
    assert.equal(findTopicById(TOPIC_ID)?.phase, "failed");
    assert.equal(findTopicById(TOPIC_ID)?.failureCount, 1);
    const history = listGovernanceTicksByEntity({ kind: "topic", entityId: TOPIC_ID });
    assert.equal(history[0]?.phase, "failed");
    assert.equal(history[0]?.failureCount, 1);
  }

  // 5. partial failure 后 lease 过期重试，action-level idempotencyKey 防止重复写 task。
  {
    ensureIsolatedPlanningSpecDataDir();
    seedGoal({});
    const job = createThreadJob(0);
    const firstLease = acquireGovernanceTickJobLease({
      leaseOwner: "partial-worker-1",
      leaseDurationMs: 1_000,
      now: new Date("2026-06-01T00:20:00.000Z"),
      targetKind: "thread",
    });
    assert.equal(firstLease?.id, job.id);

    const seenDispatchKeys = new Set<string>();
    const createdTaskKeys: string[] = [];
    let sendAttempts = 0;
    const result = makeThreadResult({
      output: {
        assessment: "需要派发并通知",
        confidence: "high",
        actions: [
          {
            kind: "dispatch_task",
            threadId: THREAD_ID,
            reason: "补充跟踪",
            taskDraft: {
              title: "跟踪新闻",
              objective: "收集新闻",
              deliverable: "新闻摘要",
              acceptanceCriteria: ["包含来源"],
            },
          },
          {
            kind: "post_message",
            threadId: THREAD_ID,
            text: "已安排跟踪",
            severity: "info",
          },
        ],
      },
    });
    const outcome = makeOutcome(job.id, result);
    const callbacks = {
      dispatchTask: async (_request: DispatchTaskRequest, options: { idempotencyKey: string }) => {
        if (!seenDispatchKeys.has(options.idempotencyKey)) {
          seenDispatchKeys.add(options.idempotencyKey);
          createdTaskKeys.push(options.idempotencyKey);
        }
        return { taskId: `task-${createdTaskKeys.length}` };
      },
      sendThreadMessage: async (request: {
        topicId: string;
        threadId: string;
        text: string;
        severity: "info" | "warning" | "important";
        traceId: string;
      }) => {
        sendAttempts += 1;
        assert.ok(request.traceId.includes("governance_tick_action"));
        if (sendAttempts === 1) throw new Error("conversation write failed");
        return { conversationMessageId: `msg-${sendAttempts}`, inboxItemId: `inbox-${sendAttempts}` };
      },
    };

    const partial = await persistGovernanceTickOutcome({
      leaseOwner: "partial-worker-1",
      leaseToken: firstLease!.leaseToken!,
      outcome,
      now: new Date("2026-06-01T00:20:00.500Z"),
      callbacks,
    });
    assert.equal(partial.ok, false);
    assert.equal(partial.reason, "dispatch_partial_failure");
    assert.equal(findThreadById(THREAD_ID)?.revision, 0, "patch waits for clean retry");
    assert.equal(createdTaskKeys.length, 1);

    expireGovernanceTickJobLeases({ now: new Date("2026-06-01T00:20:02.000Z") });
    const secondLease = acquireGovernanceTickJobLease({
      leaseOwner: "partial-worker-2",
      leaseDurationMs: 1_000,
      now: new Date("2026-06-01T00:20:02.000Z"),
      targetKind: "thread",
    });
    assert.equal(secondLease?.id, job.id);

    const retried = await persistGovernanceTickOutcome({
      leaseOwner: "partial-worker-2",
      leaseToken: secondLease!.leaseToken!,
      outcome,
      now: new Date("2026-06-01T00:20:02.500Z"),
      callbacks,
    });
    assert.equal(retried.ok, true);
    assert.equal(createdTaskKeys.length, 1, "same action idempotencyKey suppresses duplicate task create");
    assert.equal(sendAttempts, 2);
    assert.equal(findThreadById(THREAD_ID)?.revision, 1);
    assert.equal(getGovernanceTickJob(job.id)?.status, "completed");
  }

  // 5. 长耗时治理：旧 lease token 的回执仍按 jobId + owner 接受，避免重租后死锁。
  {
    ensureIsolatedPlanningSpecDataDir();
    seedGoal({});
    const job = createThreadJob(0);
    const firstLease = acquireGovernanceTickJobLease({
      leaseOwner: "long-running-worker",
      leaseDurationMs: 1_000,
      now: new Date("2026-06-01T00:30:00.000Z"),
      targetKind: "thread",
    });
    assert.equal(firstLease?.id, job.id);
    expireGovernanceTickJobLeases({ now: new Date("2026-06-01T00:30:02.000Z") });
    const secondLease = acquireGovernanceTickJobLease({
      leaseOwner: "long-running-worker",
      leaseDurationMs: 1_000,
      now: new Date("2026-06-01T00:30:02.000Z"),
      targetKind: "thread",
    });
    assert.equal(secondLease?.id, job.id);
    assert.notEqual(secondLease?.leaseToken, firstLease?.leaseToken);

    const accepted = await persistGovernanceTickOutcome({
      leaseOwner: "long-running-worker",
      leaseToken: firstLease!.leaseToken!,
      outcome: makeOutcome(job.id),
      now: new Date("2026-06-01T00:30:02.500Z"),
    });
    assert.equal(accepted.ok, true);
    assert.equal(findThreadById(normalizeSubGoalId(THREAD_ID))?.revision, 1);
    assert.equal(getGovernanceTickJob(job.id)?.status, "completed");
  }
}
