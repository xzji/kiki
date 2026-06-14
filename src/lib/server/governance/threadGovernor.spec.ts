/**
 * threadGovernor spec — 验证 §3.4.4 frame 编排：
 *  - 仅 due thread 被 tick；
 *  - tick 成功路径：prepareRun → collect → tick → dispatch → persist → record；
 *  - tick 失败路径：dispatch 不调用，persist 仍调用以累计 failureCount；
 *  - persist 冲突 → ticked.persistConflict = true；
 *  - collect callback 抛错 → frameErrors[]，不抛出；
 *  - 单 thread 异常不影响其它 thread。
 */

import assert from "node:assert/strict";

import {
  runThreadLoopFrame,
  type ThreadLoopFrameInput,
} from "@/lib/server/governance/threadGovernor";
import { createAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { listAgentEvents } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import { getGoalEvents } from "@/lib/server/repositories/goalEventLogRepository";
import { appendInboxMessage } from "@/lib/server/repositories/inboxRepository";
import { recordTickOutcome } from "@/lib/server/governance/threadGovernorCallbacks";
import { enterUserContext } from "@/lib/server/context/userContext";
import { THREAD_FAILURE_PAUSE_THRESHOLD, type Thread, type ThreadTickOutput, type Topic } from "@/types/topic";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";

const NOW = new Date("2026-06-01T08:00:00.000Z");

function makeTopic(id = "topic-w-1"): Topic {
  return {
    id,
    title: "x",
    summary: "y",
    loop: { kind: "daily" },
    phase: "idle",
    silentCount: 0,
    failureCount: 0,
    threads: [],
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    revision: 1,
  };
}

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    topicId: "topic-w-1",
    title: id,
    intent: "x",
    loopInterval: "daily",
    status: "active",
    memory: {},
    silentCount: 0,
    failureCount: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    revision: 1,
    lastTickAt: "2026-05-31T07:00:00.000Z",
    ...overrides,
  };
}

function makeOutput(
  actions: ThreadTickOutput["actions"],
  extra: Partial<ThreadTickOutput> = {},
): ThreadTickOutput {
  return {
    assessment: "治理判断证据充分",
    confidence: "high",
    actions,
    ...extra,
  };
}

const okOutput = makeOutput([{ kind: "post_message", threadId: "T-DUE", text: "hi", severity: "info" }]);

function makeInvokeOk(output: ThreadTickOutput): LlmInvoke {
  return async () => ({ rawText: JSON.stringify(output), parsed: output as unknown as Record<string, unknown> });
}

export async function runThreadGovernorSpecs() {
  enterUserContext("thread-governor-spec");

  // ---------- 仅 due thread 被 tick ----------
  {
    const callOrder: string[] = [];
    const candidates = [
      { topic: makeTopic(), thread: makeThread("T-DUE") }, // due（lastTickAt 已超 daily）
      {
        topic: makeTopic(),
        thread: makeThread("T-FUTURE", { nextTickAt: "2026-06-02T08:00:00.000Z" }),
      },
      { topic: makeTopic(), thread: makeThread("T-PAUSED", { status: "paused" }) },
    ];
    const input: ThreadLoopFrameInput = {
      now: NOW,
      invoke: makeInvokeOk(makeOutput([{ kind: "post_message", threadId: "T-DUE", text: "hi", severity: "info" }])),
      callbacks: {
        collectActiveThreads: async () => candidates,
        collectRecentTaskInstances: async () => [],
        prepareAgentRun: async ({ thread }) => {
          callOrder.push(`prepare:${thread.id}`);
          return { agentRunId: `ar-${thread.id}` };
        },
        persistThreadPatch: async ({ thread }) => {
          callOrder.push(`persist:${thread.id}`);
          return { ok: true };
        },
        recordTickOutcome: async ({ thread }) => {
          callOrder.push(`record:${thread.id}`);
        },
        dispatchTask: async () => ({ taskId: "x" }),
        sendThreadMessage: async () => ({ conversationMessageId: "cm" }),
      },
    };

    const outcome = await runThreadLoopFrame(input);
    assert.equal(outcome.ticked.length, 1, "只有 T-DUE 被 tick");
    assert.equal(outcome.ticked[0]?.threadId, "T-DUE");
    assert.equal(outcome.ticked[0]?.ok, true, outcome.ticked[0]?.failureReason);
    assert.equal(outcome.ticked[0]?.sentMessageCount, 1);
    assert.deepEqual(callOrder, ["prepare:T-DUE", "persist:T-DUE", "record:T-DUE"]);
    assert.equal(outcome.frameErrors.length, 0);
  }

  // ---------- tick 失败：dispatch 不调用，persist 仍调用 ----------
  {
    let dispatchCalls = 0;
    let persistCalls = 0;
    const input: ThreadLoopFrameInput = {
      now: NOW,
      invoke: async () => {
        throw new Error("LLM down");
      },
      callbacks: {
        collectActiveThreads: async () => [{ topic: makeTopic(), thread: makeThread("T-DUE") }],
        collectRecentTaskInstances: async () => [],
        prepareAgentRun: async () => ({ agentRunId: "ar-1" }),
        persistThreadPatch: async () => {
          persistCalls += 1;
          return { ok: true };
        },
        recordTickOutcome: async () => {},
        dispatchTask: async () => {
          dispatchCalls += 1;
          return { taskId: "x" };
        },
        sendThreadMessage: async () => {
          dispatchCalls += 1;
          return { conversationMessageId: "x" };
        },
      },
    };
    const outcome = await runThreadLoopFrame(input);
    assert.equal(dispatchCalls, 0, "tick 失败不应触发 dispatch");
    assert.equal(persistCalls, 1, "tick 失败仍要持久化 failureCount");
    assert.equal(outcome.ticked[0]?.ok, false);
    assert.match(outcome.ticked[0]?.failureReason ?? "", /tick_failed/);
  }

  // ---------- persist 乐观锁冲突 ----------
  {
    const input: ThreadLoopFrameInput = {
      now: NOW,
      invoke: makeInvokeOk(okOutput),
      callbacks: {
        collectActiveThreads: async () => [{ topic: makeTopic(), thread: makeThread("T-DUE") }],
        collectRecentTaskInstances: async () => [],
        prepareAgentRun: async () => ({ agentRunId: "ar-1" }),
        persistThreadPatch: async () => ({ ok: false, conflict: true }),
        recordTickOutcome: async () => {},
        dispatchTask: async () => ({ taskId: "x" }),
        sendThreadMessage: async () => ({ conversationMessageId: "cm" }),
      },
    };
    const outcome = await runThreadLoopFrame(input);
    assert.equal(outcome.ticked[0]?.persistConflict, true);
    assert.equal(outcome.ticked[0]?.failureReason, "persist_conflict");
    assert.equal(outcome.ticked[0]?.ok, false);
  }

  // ---------- collect callback 抛错 → frameErrors，不抛出 ----------
  {
    const outcome = await runThreadLoopFrame({
      now: NOW,
      invoke: makeInvokeOk(okOutput),
      callbacks: {
        collectActiveThreads: async () => {
          throw new Error("DB down");
        },
        collectRecentTaskInstances: async () => [],
        prepareAgentRun: async () => ({ agentRunId: "x" }),
        persistThreadPatch: async () => ({ ok: true }),
        recordTickOutcome: async () => {},
        dispatchTask: async () => ({ taskId: "x" }),
        sendThreadMessage: async () => ({ conversationMessageId: "x" }),
      },
    });
    assert.equal(outcome.ticked.length, 0);
    assert.equal(outcome.frameErrors.length, 1);
  }

  // ---------- 单 thread 异常不影响其它 thread ----------
  {
    const candidates = [
      { topic: makeTopic("topic-A"), thread: makeThread("T-A") },
      { topic: makeTopic("topic-B"), thread: makeThread("T-B") },
    ];
    const outcome = await runThreadLoopFrame({
      now: NOW,
      invoke: makeInvokeOk(makeOutput([{ kind: "silent", reason: "ok" }])),
      callbacks: {
        collectActiveThreads: async () => candidates,
        collectRecentTaskInstances: async () => [],
        prepareAgentRun: async ({ thread }) => {
          if (thread.id === "T-A") throw new Error("prepare boom");
          return { agentRunId: `ar-${thread.id}` };
        },
        persistThreadPatch: async () => ({ ok: true }),
        recordTickOutcome: async () => {},
        dispatchTask: async () => ({ taskId: "x" }),
        sendThreadMessage: async () => ({ conversationMessageId: "x" }),
      },
    });
    assert.equal(outcome.ticked.length, 2);
    const a = outcome.ticked.find((t) => t.threadId === "T-A");
    const b = outcome.ticked.find((t) => t.threadId === "T-B");
    assert.equal(a?.ok, false);
    assert.match(a?.failureReason ?? "", /prepareAgentRun_failed/);
    assert.equal(b?.ok, true);
  }

  // ---------- smoke：fake tick 写 agent_events + inbox projection ----------
  {
    const suffix = Date.now().toString(36);
    const topic = makeTopic(`topic-smoke-${suffix}`);
    const thread = makeThread(`thread-smoke-${suffix}`, { topicId: topic.id });
    const agentRunId = `agent-run-smoke-${suffix}`;
    const inboxTraceId = `trace-smoke-${suffix}`;
    const output = makeOutput([
        {
          kind: "post_message",
          threadId: thread.id,
          text: "smoke inbox message",
          severity: "info",
        },
        {
          kind: "dispatch_task",
          threadId: thread.id,
          reason: "smoke dispatch",
          taskDraft: {
            title: "复盘 NVDA",
            objective: "生成一段 smoke 研究摘要",
            deliverable: "摘要",
            acceptanceCriteria: ["可读"],
          },
        },
      ]);

    const outcome = await runThreadLoopFrame({
      now: NOW,
      invoke: makeInvokeOk(output),
      callbacks: {
        collectActiveThreads: async () => [{ topic, thread }],
        collectRecentTaskInstances: async () => [],
        prepareAgentRun: async () => {
          createAgentRun({
            id: agentRunId,
            topicId: topic.id,
            threadId: thread.id,
            role: "thread_runner",
            status: "running",
            idempotencyKey: `thread-smoke:${suffix}`,
            startedAt: NOW.toISOString(),
          });
          return { agentRunId };
        },
        persistThreadPatch: async () => ({ ok: true }),
        recordTickOutcome,
        dispatchTask: async () => ({ taskId: `task-smoke-${suffix}`, instanceId: `inst-smoke-${suffix}` }),
        sendThreadMessage: async ({ text, severity }) => {
          const result = appendInboxMessage({
            topicId: topic.id,
            threadId: thread.id,
            text,
            severity,
            source: "thread_tick",
            traceId: inboxTraceId,
            now: () => NOW,
          });
          return { conversationMessageId: `cm-smoke-${suffix}`, inboxItemId: result.inboxMessageId };
        },
      },
    });

    assert.equal(outcome.ticked.length, 1);
    assert.equal(outcome.ticked[0]?.ok, true, outcome.ticked[0]?.failureReason);
    assert.equal(outcome.ticked[0]?.dispatchedTaskCount, 1);
    assert.equal(outcome.ticked[0]?.sentMessageCount, 1);

    const agentEvents = listAgentEvents({ agentRunId });
    const agentEventKinds = agentEvents.map((event) => event.payload.kind);
    assert.equal(agentEvents.length, 2);
    assert.deepEqual(
      agentEvents.map((event) => event.type),
      ["decision", "decision"],
    );
    assert.ok(agentEventKinds.includes("loop.thread.tick.completed"));
    assert.ok(agentEventKinds.includes("thread.tick.completed"));
    const completedEvent = agentEvents.find((event) => event.payload.kind === "thread.tick.completed");
    assert.equal(completedEvent?.payload.dispatchedTaskCount, 1);
    assert.equal(completedEvent?.payload.sentMessageCount, 1);
    assert.equal(completedEvent?.payload.assessment, output.assessment);
    assert.equal(completedEvent?.payload.confidence, output.confidence);

    const inboxEvents = getGoalEvents({ goalId: topic.id, fromId: 0, limit: 500 }).filter((event) => {
      const payload = event.payload as { target?: unknown; notificationId?: unknown };
      return (
        event.kind === "notification.delivered" &&
        payload.target === "inbox" &&
        payload.notificationId === `inbox-thread_tick-${thread.id}-${inboxTraceId}`
      );
    });
    assert.equal(inboxEvents.length, 1, "thread tick post_message should project one inbox notification");
  }

  // ---------- smoke：连续失败达到阈值 → thread_paused event + inbox alert ----------
  {
    const suffix = `${Date.now().toString(36)}-paused`;
    const topic = makeTopic(`topic-smoke-${suffix}`);
    const thread = makeThread(`thread-smoke-${suffix}`, {
      topicId: topic.id,
      failureCount: THREAD_FAILURE_PAUSE_THRESHOLD - 1,
    });
    const agentRunId = `agent-run-smoke-${suffix}`;

    const outcome = await runThreadLoopFrame({
      now: NOW,
      invoke: async () => {
        throw new Error("LLM down");
      },
      callbacks: {
        collectActiveThreads: async () => [{ topic, thread }],
        collectRecentTaskInstances: async () => [],
        prepareAgentRun: async () => {
          createAgentRun({
            id: agentRunId,
            topicId: topic.id,
            threadId: thread.id,
            role: "thread_runner",
            status: "running",
            idempotencyKey: `thread-paused-smoke:${suffix}`,
            startedAt: NOW.toISOString(),
          });
          return { agentRunId };
        },
        persistThreadPatch: async ({ result }) => {
          assert.equal(result.ok, false);
          assert.equal(result.patch.status, "paused");
          assert.equal(result.patch.failureCount, THREAD_FAILURE_PAUSE_THRESHOLD);
          assert.equal(result.pauseReason, "failure_threshold");
          return { ok: true };
        },
        recordTickOutcome,
        dispatchTask: async () => {
          throw new Error("dispatch should not run on failed tick");
        },
        sendThreadMessage: async () => {
          throw new Error("message should not run on failed tick");
        },
      },
    });

    assert.equal(outcome.ticked.length, 1);
    assert.equal(outcome.ticked[0]?.ok, false);
    assert.match(outcome.ticked[0]?.failureReason ?? "", /tick_failed/);

    const agentEvents = listAgentEvents({ agentRunId });
    assert.deepEqual(
      agentEvents.map((event) => event.type),
      ["error", "error", "thread_paused", "thread_paused"],
    );
    const failedKinds = agentEvents.map((event) => event.payload.kind);
    assert.ok(failedKinds.includes("loop.thread.tick.failed"));
    assert.ok(failedKinds.includes("thread.tick.failed"));
    assert.ok(failedKinds.includes("loop.thread.paused.failure_threshold"));
    assert.ok(failedKinds.includes("thread.paused.failure_threshold"));

    const inboxEvents = getGoalEvents({ goalId: topic.id, fromId: 0, limit: 500 }).filter((event) => {
      const payload = event.payload as { target?: unknown; notificationId?: unknown };
      return (
        event.kind === "notification.delivered" &&
        payload.target === "inbox" &&
        payload.notificationId === `inbox-thread_paused-${thread.id}-thread-paused:${agentRunId}`
      );
    });
    assert.equal(inboxEvents.length, 1, "thread pause should project one inbox alert");
  }

  // ---------- smoke：daemon 重启后 paused/阈值 thread 不再 tick，active thread 继续 ----------
  {
    const suffix = `${Date.now().toString(36)}-restart`;
    const topic = makeTopic(`topic-restart-${suffix}`);
    const paused = makeThread(`thread-paused-${suffix}`, {
      topicId: topic.id,
      status: "paused",
      failureCount: THREAD_FAILURE_PAUSE_THRESHOLD,
    });
    const dirtyThresholdActive = makeThread(`thread-dirty-threshold-${suffix}`, {
      topicId: topic.id,
      status: "active",
      failureCount: THREAD_FAILURE_PAUSE_THRESHOLD,
    });
    const active = makeThread(`thread-active-${suffix}`, {
      topicId: topic.id,
      status: "active",
      failureCount: 0,
    });
    const tickedThreads: string[] = [];

    const outcome = await runThreadLoopFrame({
      now: NOW,
      invoke: makeInvokeOk(makeOutput([{ kind: "silent", reason: "restart continuation smoke" }])),
      callbacks: {
        collectActiveThreads: async () => [
          { topic, thread: paused },
          { topic, thread: dirtyThresholdActive },
          { topic, thread: active },
        ],
        collectRecentTaskInstances: async () => [],
        prepareAgentRun: async ({ thread }) => {
          tickedThreads.push(thread.id);
          return { agentRunId: `agent-run-restart-${thread.id}` };
        },
        persistThreadPatch: async ({ thread, result }) => {
          assert.equal(thread.id, active.id, "only active thread should persist after restart");
          assert.equal(result.ok, true);
          return { ok: true };
        },
        recordTickOutcome: async ({ thread }) => {
          assert.equal(thread.id, active.id, "only active thread should record outcome after restart");
        },
        dispatchTask: async () => {
          throw new Error("silent output should not dispatch task");
        },
        sendThreadMessage: async () => {
          throw new Error("silent output should not send message");
        },
      },
    });

    assert.deepEqual(tickedThreads, [active.id]);
    assert.equal(outcome.ticked.length, 1);
    assert.equal(outcome.ticked[0]?.threadId, active.id);
    assert.equal(outcome.ticked[0]?.ok, true);
    assert.equal(outcome.ticked[0]?.silentCount, 1);
  }
}
