/**
 * conversationMessagesRepository.appendThreadMessage spec — PR14.4。
 *
 * 计划 ref：§12.3.4。
 *
 * 覆盖：
 *  1. 写入成功：创建一条 text/role:kiki/unread 消息，conversationMessageId 派生规则正确。
 *  2. 同 traceId 幂等：重入返回相同 ID，不重复插入。
 *  3. 缺 topicId / threadId / 空 text 抛错。
 *  4. topicId 找不到关联 conversation 抛错。
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { getDatabase } from "@/lib/server/db/client";
import { normalizeGoalId } from "@/lib/opaqueIds";

import {
  appendThreadMessage,
  insertConversationMessage,
  listConversationMessages,
  updateConversationMessage,
} from "./conversationMessagesRepository";

// 与生产路径一致：conversations.goal_id 在写入前会被 normalize；spec seed 也照此做。
function seedConversation(conversationId: string, goalId: string) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT OR REPLACE INTO conversations (
        id, title, goal_id, status, pinned, revision, created_at, updated_at, user_id
      ) VALUES (?, ?, ?, 'idle', 0, 1, ?, ?, 'local-user')
    `,
  ).run(
    conversationId,
    conversationId,
    normalizeGoalId(goalId),
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z",
  );
}

function countMessages(conversationId: string): number {
  const row = getDatabase()
    .prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?`)
    .get(conversationId) as { n: number };
  return row.n;
}

function makeCliProcess(runId: string) {
  return {
    runId,
    status: "completed" as const,
    startedAt: "2026-06-01T00:00:00.000Z",
    finishedAt: "2026-06-01T00:00:02.000Z",
    promptSections: [],
    events: [
      {
        id: `${runId}-status`,
        type: "status" as const,
        createdAt: "2026-06-01T00:00:01.000Z",
        title: "目标规划草案已生成",
        content: "目标规划草案已生成",
      },
    ],
    output: "目标规划草案已生成",
  };
}

export async function runAppendThreadMessageSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // 1. 基本写入
  {
    seedConversation("conv-1", "topic-1");
    const traceId = "2026-06-01T00:00:00.000Z";
    const result = appendThreadMessage({
      topicId: "topic-1",
      threadId: "thread-1",
      text: "hello world",
      severity: "info",
      traceId,
    });
    assert.equal(result.conversationId, "conv-1");
    assert.equal(
      result.conversationMessageId,
      `msg-thread-thread-1-${traceId}`,
      "messageId 派生规则",
    );
    const msgs = listConversationMessages({ conversationId: "conv-1" });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.kind, "text");
    assert.equal(msgs[0]?.role, "kiki");
    assert.equal(msgs[0]?.content, "hello world");
    assert.equal(msgs[0]?.unread, true);
  }

  // 2. 幂等
  {
    seedConversation("conv-2", "topic-2");
    const traceId = "2026-06-01T01:00:00.000Z";
    const r1 = appendThreadMessage({
      topicId: "topic-2",
      threadId: "thread-2",
      text: "first",
      severity: "info",
      traceId,
    });
    const before = countMessages("conv-2");
    const r2 = appendThreadMessage({
      topicId: "topic-2",
      threadId: "thread-2",
      text: "first",
      severity: "info",
      traceId,
    });
    assert.equal(r1.conversationMessageId, r2.conversationMessageId, "重入返回同一 ID");
    const after = countMessages("conv-2");
    assert.equal(after, before, "幂等：消息数不变");
  }

  // 3. 输入校验
  {
    seedConversation("conv-3", "topic-3");
    assert.throws(
      () =>
        appendThreadMessage({
          topicId: "",
          threadId: "thread-3",
          text: "x",
          severity: "info",
        }),
      /topicId required/,
    );
    assert.throws(
      () =>
        appendThreadMessage({
          topicId: "topic-3",
          threadId: "",
          text: "x",
          severity: "info",
        }),
      /threadId required/,
    );
    assert.throws(
      () =>
        appendThreadMessage({
          topicId: "topic-3",
          threadId: "thread-3",
          text: "   ",
          severity: "info",
        }),
      /text required/,
    );
  }

  // 4. 找不到 conversation
  {
    assert.throws(
      () =>
        appendThreadMessage({
          topicId: "topic-orphan",
          threadId: "thread-orphan",
          text: "x",
          severity: "info",
          traceId: "t",
        }),
      /no conversation linked/,
    );
  }

  // 5. goal_plan_card 持久化 cliProcess
  {
    seedConversation("conv-5", "topic-5");
    const cliProcess = makeCliProcess("goal-cli-msg-5");
    insertConversationMessage("conv-5", {
      id: "msg-plan-5",
      kind: "goal_plan_card",
      role: "kiki",
      content: "目标规划草案已生成。",
      createdAt: "2026-06-01T02:00:00.000Z",
      status: "done",
      source: "kiki",
      cliProcess,
      goalRef: {
        goalId: "goal-5",
        title: "目标 5",
        subGoalCount: 1,
        taskCount: 2,
      },
    });
    const [message] = listConversationMessages({ conversationId: "conv-5" });
    assert.equal(message?.kind, "goal_plan_card");
    assert.deepEqual(message?.kind === "goal_plan_card" ? message.cliProcess : undefined, cliProcess);
  }

  // 6. text 更新为 goal_plan_card 后仍保留 cliProcess
  {
    seedConversation("conv-6", "topic-6");
    const cliProcess = makeCliProcess("goal-cli-msg-6");
    insertConversationMessage("conv-6", {
      id: "msg-plan-6",
      kind: "text",
      role: "kiki",
      content: "正在生成目标规划...",
      createdAt: "2026-06-01T03:00:00.000Z",
      status: "streaming",
      source: "kiki",
      cliProcess,
    });
    const updated = updateConversationMessage({
      conversationId: "conv-6",
      messageId: "msg-plan-6",
      patch: {
        kind: "goal_plan_card",
        role: "kiki",
        content: "目标规划草案已生成。",
        status: "done",
        source: "kiki",
        cliProcess,
        goalRef: {
          goalId: "goal-6",
          title: "目标 6",
          subGoalCount: 2,
          taskCount: 3,
        },
      },
    });
    assert.ok(updated && !("conflict" in updated && updated.conflict));
    const [message] = listConversationMessages({ conversationId: "conv-6" });
    assert.equal(message?.kind, "goal_plan_card");
    assert.deepEqual(message?.kind === "goal_plan_card" ? message.cliProcess : undefined, cliProcess);
  }
}
