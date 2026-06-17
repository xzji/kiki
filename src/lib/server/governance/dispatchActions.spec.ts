/**
 * dispatchActions spec — 验证 §3.3.4 派发顺序、容错、threadId 防御。
 */

import assert from "node:assert/strict";

import {
  dispatchThreadActions,
  type DispatchTaskCallback,
  type SendThreadMessageCallback,
} from "@/lib/server/governance/dispatchActions";
import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";
import type { Task } from "@/types/kiki";
import type { ThreadTickOutput } from "@/types/topic";

const TOPIC_ID = "topic-d-1";
const THREAD_ID = "thread-d-1";

function makeDraft(title: string): TaskDraft {
  return {
    title,
    objective: `${title}-obj`,
    deliverable: `${title}-deliverable`,
    acceptanceCriteria: ["criterion-1"],
  };
}

function noopDispatch(): DispatchTaskCallback {
  let counter = 0;
  return async () => ({ taskId: `task-${++counter}`, instanceId: `ti-${counter}` });
}
function noopSend(): SendThreadMessageCallback {
  let counter = 0;
  return async () => ({ conversationMessageId: `cm-${++counter}`, inboxItemId: `ib-${counter}` });
}

function makeTask(id: string, title = "既有任务"): Task {
  return {
    id,
    subGoalId: THREAD_ID,
    title,
    description: `${title}-desc`,
    expectedOutcome: `${title}-outcome`,
    taskType: "repeat",
    triggerRule: "每天 09:00",
    progress: 0,
    instances: [],
    executionKind: "generic_result",
  };
}

function makeOutput(actions: ThreadTickOutput["actions"]): ThreadTickOutput {
  return {
    assessment: "派发器测试输出",
    confidence: "high",
    actions,
  };
}

export async function runDispatchActionsSpecs() {
  // ---------- happy: 多动作叠加 + 顺序断言 ----------
  {
    const callOrder: string[] = [];
    const output = makeOutput([
        { kind: "post_message", threadId: THREAD_ID, text: "msg-A", severity: "info" },
        {
          kind: "dispatch_task",
          threadId: THREAD_ID,
          reason: "深度分析",
          taskDraft: makeDraft("复盘 NVDA"),
        },
        { kind: "silent", reason: "no-op" },
        { kind: "post_message", threadId: THREAD_ID, text: "msg-B", severity: "warning" },
    ]);
    const result = await dispatchThreadActions({
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      output,
      callbacks: {
        dispatchTask: async (req) => {
          callOrder.push(`dispatch:${req.taskDraft.title}`);
          return { taskId: "task-1", instanceId: "ti-1" };
        },
        sendThreadMessage: async (req) => {
          callOrder.push(`message:${req.text}`);
          return { conversationMessageId: `cm-${req.text}` };
        },
      },
    });

    // 顺序：先派 task，再发 message
    assert.deepEqual(callOrder, ["dispatch:复盘 NVDA", "message:msg-A", "message:msg-B"]);
    assert.equal(result.dispatchedTasks.length, 1);
    assert.equal(result.sentMessages.length, 2);
    assert.equal(result.silentReasons.length, 1);
    assert.equal(result.errors.length, 0);
  }

  // ---------- update/cancel：基于当前 Task 列表治理 ----------
  {
    const callOrder: string[] = [];
    const currentTasks = [makeTask("task-existing")];
    const output = makeOutput([
        {
          kind: "update_task",
          threadId: THREAD_ID,
          taskId: "task-existing",
          reason: "降低频率",
          patch: { cadence: "每周一" },
        },
        {
          kind: "cancel_task",
          threadId: THREAD_ID,
          taskId: "task-existing",
          reason: "关注点关闭",
        },
    ]);
    const result = await dispatchThreadActions({
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      output,
      currentTasks,
      callbacks: {
        dispatchTask: noopDispatch(),
        updateTask: async (req) => {
          callOrder.push(`update:${req.taskId}:${req.patch.cadence}`);
          return { taskId: req.taskId };
        },
        cancelTask: async (req) => {
          callOrder.push(`cancel:${req.taskId}:${req.reason}`);
          return { taskId: req.taskId };
        },
        sendThreadMessage: noopSend(),
      },
    });
    assert.deepEqual(callOrder, ["update:task-existing:每周一", "cancel:task-existing:关注点关闭"]);
    assert.equal(result.updatedTasks.length, 1);
    assert.equal(result.cancelledTasks.length, 1);
    assert.equal(result.errors.length, 0);
  }

  // ---------- 任一 action 失败不阻断后续 ----------
  {
    let dispatchCalls = 0;
    let messageCalls = 0;
    const output = makeOutput([
        { kind: "dispatch_task", threadId: THREAD_ID, reason: "r1", taskDraft: makeDraft("t1") },
        { kind: "dispatch_task", threadId: THREAD_ID, reason: "r2", taskDraft: makeDraft("t2") },
        { kind: "post_message", threadId: THREAD_ID, text: "m1", severity: "info" },
        { kind: "post_message", threadId: THREAD_ID, text: "m2", severity: "info" },
    ]);
    const result = await dispatchThreadActions({
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      output,
      callbacks: {
        dispatchTask: async (req) => {
          dispatchCalls += 1;
          if (req.taskDraft.title === "t1") throw new Error("boom-task");
          return { taskId: "task-2" };
        },
        sendThreadMessage: async (req) => {
          messageCalls += 1;
          if (req.text === "m1") throw new Error("boom-msg");
          return { conversationMessageId: "cm-2" };
        },
      },
    });
    assert.equal(dispatchCalls, 2, "两条 dispatch 都应被调用，失败不中断");
    assert.equal(messageCalls, 2);
    assert.equal(result.dispatchedTasks.length, 1, "只 1 条成功");
    assert.equal(result.sentMessages.length, 1);
    assert.equal(result.errors.length, 2);
    assert.deepEqual(
      result.errors.map((e) => e.kind),
      ["dispatch_task", "post_message"],
    );
  }

  // ---------- threadId 防御：错配 action 被记录为 error 且不调用 callback ----------
  {
    let dispatchCalled = 0;
    const output = makeOutput([
        {
          kind: "dispatch_task",
          threadId: "OTHER-THREAD",
          reason: "x",
          taskDraft: makeDraft("x"),
        },
    ]);
    const result = await dispatchThreadActions({
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      output,
      callbacks: {
        dispatchTask: async () => {
          dispatchCalled += 1;
          return { taskId: "should-not-happen" };
        },
        sendThreadMessage: noopSend(),
      },
    });
    assert.equal(dispatchCalled, 0, "threadId 错配的 action 不应触发 callback");
    assert.equal(result.errors.length, 1);
    assert.equal(result.dispatchedTasks.length, 0);
  }

  // ---------- 全 silent：无 callback 调用 ----------
  {
    let totalCalls = 0;
    const result = await dispatchThreadActions({
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      output: makeOutput([{ kind: "silent", reason: "无信号" }]),
      callbacks: {
        dispatchTask: async () => {
          totalCalls += 1;
          return { taskId: "x" };
        },
        sendThreadMessage: async () => {
          totalCalls += 1;
          return { conversationMessageId: "x" };
        },
      },
    });
    assert.equal(totalCalls, 0);
    assert.equal(result.silentReasons.length, 1);
    assert.equal(result.errors.length, 0);
  }

  // ---------- 空 actions（理论上 schema 不允许，本派发器仍能容忍） ----------
  {
    const result = await dispatchThreadActions({
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      output: makeOutput([]),
      callbacks: { dispatchTask: noopDispatch(), sendThreadMessage: noopSend() },
    });
    assert.equal(result.dispatchedTasks.length, 0);
    assert.equal(result.sentMessages.length, 0);
    assert.equal(result.errors.length, 0);
  }

  // ---------- dispatch_task 兜底重复检测：fresh currentTasks 命中既有任务时降级为 silent ----------
  {
    let dispatchCalled = 0;
    const currentTasks = [makeTask("task-existing", "复盘 NVDA")];
    const output = makeOutput([
      {
        kind: "dispatch_task",
        threadId: THREAD_ID,
        reason: "周报",
        taskDraft: makeDraft("复盘 NVDA"),
      },
    ]);
    const result = await dispatchThreadActions({
      topicId: TOPIC_ID,
      threadId: THREAD_ID,
      output,
      currentTasks,
      callbacks: {
        dispatchTask: async () => {
          dispatchCalled += 1;
          return { taskId: "should-not-happen" };
        },
        sendThreadMessage: noopSend(),
      },
    });
    assert.equal(dispatchCalled, 0, "重复 dispatch_task 不应真正下发");
    assert.equal(result.dispatchedTasks.length, 0);
    assert.equal(result.silentReasons.length, 1);
    assert.match(result.silentReasons[0]!.reason, /dispatch_skipped_duplicate/);
    // 不能写 errors[]——否则上层 applyThreadOutcome 会把整次 tick 标记为
    // dispatch_partial_failure，thread 状态机不推进，下次重试还会被 dedup 拦下，
    // 陷入循环。dedup 语义上属于 silent。
    assert.equal(result.errors.length, 0, "dedup 应表现为 silent，而不是 dispatch error");
  }
}
