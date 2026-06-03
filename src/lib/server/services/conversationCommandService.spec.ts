import assert from "node:assert/strict";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import { listConversationMessages } from "@/lib/server/repositories/conversationMessagesRepository";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  applyConversationCommand,
  ConversationCommandConflictError,
  ConversationCommandIdempotencyConflictError,
} from "@/lib/server/services/conversationCommandService";
import type { ConversationMessage } from "@/types/kiki";

function textMessage(id: string, content: string): ConversationMessage {
  return {
    id,
    kind: "text",
    role: "user",
    content,
    createdAt: new Date().toISOString(),
    status: "done",
  };
}

export function runConversationCommandServiceSpecs() {
  ensureIsolatedPlanningSpecDataDir();
  const conversationId = "conv-command-spec";
  const created = applyConversationCommand({
    command: { type: "create_conversation", conversation: { id: conversationId, title: "命令测试" } },
    idempotencyKey: createIdempotencyKey("conversation.spec.create", conversationId),
  });
  assert.equal(created.conversation?.id, conversationId);
  assert.equal(created.revision, 1);

  assert.throws(
    () =>
      applyConversationCommand({
        command: { type: "create_conversation", conversation: { id: conversationId, title: "重复" } },
        idempotencyKey: createIdempotencyKey("conversation.spec.create.duplicate", conversationId),
      }),
    (error) => error instanceof ConversationCommandConflictError,
  );

  assert.throws(
    () =>
      applyConversationCommand({
        command: { type: "rename_conversation", conversationId, title: "复用 key" },
        idempotencyKey: createIdempotencyKey("conversation.spec.create", conversationId),
        expectedRevision: 1,
      }),
    (error) => error instanceof ConversationCommandIdempotencyConflictError,
  );

  const appended = applyConversationCommand({
    command: { type: "append_message", conversationId, message: textMessage("msg-spec-1", "hello") },
    idempotencyKey: createIdempotencyKey("conversation.spec.message", conversationId, "msg-spec-1"),
  });
  assert.equal(appended.conversation?.messages.length, 1);

  const duplicateAppend = applyConversationCommand({
    command: { type: "append_message", conversationId, message: textMessage("msg-spec-1", "hello") },
    idempotencyKey: createIdempotencyKey("conversation.spec.message.retry", conversationId, "msg-spec-1"),
  });
  assert.equal(duplicateAppend.conversation?.messages.length, 1);

  const updated = applyConversationCommand({
    command: {
      type: "update_message",
      conversationId,
      messageId: "msg-spec-1",
      patch: { content: "hello world" },
      expectedVersion: 1,
    },
    idempotencyKey: createIdempotencyKey("conversation.spec.message.update", conversationId, "msg-spec-1"),
  });
  assert.equal(updated.conversation?.messages[0]?.content, "hello world");

  assert.throws(
    () =>
      applyConversationCommand({
        command: {
          type: "update_message",
          conversationId,
          messageId: "msg-spec-1",
          patch: { content: "stale" },
          expectedVersion: 1,
        },
        idempotencyKey: createIdempotencyKey("conversation.spec.message.update.stale", conversationId, "msg-spec-1"),
      }),
    (error) => error instanceof ConversationCommandConflictError,
  );

  applyConversationCommand({
    command: { type: "append_message", conversationId, message: textMessage("msg-spec-2", "second") },
    idempotencyKey: createIdempotencyKey("conversation.spec.message", conversationId, "msg-spec-2"),
  });
  const paged = listConversationMessages({ conversationId, afterSeq: 1, limit: 10 });
  assert.deepEqual(
    paged.map((message) => message.id),
    ["msg-spec-2"],
  );

  const cascadeConversationId = "conv-command-cascade-spec";
  const goalId = "goal-command-cascade-spec";
  const threadId = "thread-command-cascade-spec";
  const taskId = "task-command-cascade-spec";
  const instanceId = "instance-command-cascade-spec";
  const sagaId = "saga-command-cascade-spec";
  const agentRunId = "agent-run-command-cascade-spec";
  const runtimeJobId = "runtime-job-command-cascade-spec";
  const now = new Date().toISOString();
  const db = getDatabase();

  applyConversationCommand({
    command: {
      type: "create_conversation",
      conversation: { id: cascadeConversationId, title: "级联删除测试", goalId },
    },
    idempotencyKey: createIdempotencyKey("conversation.spec.cascade.create", cascadeConversationId),
  });
  applyConversationCommand({
    command: {
      type: "append_message",
      conversationId: cascadeConversationId,
      message: textMessage("msg-cascade-1", "cascade"),
    },
    idempotencyKey: createIdempotencyKey("conversation.spec.cascade.message", cascadeConversationId),
  });

  db.prepare(
    `INSERT OR REPLACE INTO runtime_state_snapshots (key, value_json, updated_at) VALUES (?, ?, ?)`,
  ).run(
    "goals",
    JSON.stringify({
      value: [
        {
          id: goalId,
          title: "级联目标",
          deadline: "",
          progress: 0,
          conversationId: cascadeConversationId,
          subGoals: [{ id: threadId, title: "Thread", tasks: [{ id: taskId, instances: [{ id: instanceId, createdAt: now }] }] }],
          createdAt: now,
        },
      ],
      revision: 1,
      updatedAt: now,
    }),
    now,
  );
  db.prepare(
    `INSERT OR REPLACE INTO runtime_state_snapshots (key, value_json, updated_at) VALUES (?, ?, ?)`,
  ).run(
    "topics",
    JSON.stringify({
      value: [
        {
          id: goalId,
          conversationId: cascadeConversationId,
          title: "级联 Topic",
          summary: "",
          threads: [
            {
              id: threadId,
              topicId: goalId,
              title: "Thread",
              intent: "test",
              loopInterval: "daily",
              status: "active",
              memory: {},
              silentCount: 0,
              failureCount: 0,
              createdAt: now,
              updatedAt: now,
              revision: 0,
            },
          ],
          status: "active",
          createdAt: now,
          updatedAt: now,
          revision: 0,
        },
      ],
      revision: 1,
      updatedAt: now,
    }),
    now,
  );
  db.prepare(
    `
      INSERT INTO runtime_jobs (
        id, task_instance_id, task_id, goal_id, topic_id, thread_id, saga_instance_id,
        conversation_id, user_id, kind, status, runtime_transport, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local-user', 'goal_task', 'queued', 'local_daemon', '{}', ?, ?)
    `,
  ).run(runtimeJobId, instanceId, taskId, goalId, goalId, threadId, sagaId, cascadeConversationId, now, now);
  db.prepare(
    `
      INSERT INTO artifacts (
        id, conversation_id, task_id, instance_id, runtime_job_id, kind, label, created_at
      ) VALUES ('artifact-command-cascade-spec', ?, ?, ?, ?, 'text_block', 'artifact', ?)
    `,
  ).run(cascadeConversationId, taskId, instanceId, runtimeJobId, now);
  db.prepare(
    `
      INSERT INTO artifact_interaction_state (
        artifact_id, conversation_id, task_id, instance_id, state_json, created_at, updated_at
      ) VALUES ('artifact-command-cascade-spec', ?, ?, ?, '{}', ?, ?)
    `,
  ).run(cascadeConversationId, taskId, instanceId, now, now);
  db.prepare(
    `INSERT INTO goal_deliverables (goal_id, payload_json, revision, updated_at) VALUES (?, '{}', 1, ?)`,
  ).run(goalId, now);
  db.prepare(
    `
      INSERT INTO goal_event_log (
        event_id, goal_id, task_id, instance_id, kind, payload_json, produced_by, created_at
      ) VALUES ('goal-event-command-cascade-spec', ?, ?, ?, 'goal.structure_changed', '{}', 'api', ?)
    `,
  ).run(goalId, taskId, instanceId, now);
  db.prepare(
    `
      INSERT INTO saga_instances (
        id, topic_id, type, status, started_at, revision
      ) VALUES (?, ?, 'topic_init', 'running', ?, 0)
    `,
  ).run(sagaId, goalId, now);
  db.prepare(
    `
      INSERT INTO agent_runs (
        id, topic_id, thread_id, task_id, saga_instance_id, role, status, started_at
      ) VALUES (?, ?, ?, ?, ?, 'planner', 'running', ?)
    `,
  ).run(agentRunId, goalId, threadId, taskId, sagaId, now);
  db.prepare(
    `INSERT INTO agent_events (id, agent_run_id, seq, type, payload, created_at) VALUES ('agent-event-command-cascade-spec', ?, 1, 'started', '{}', ?)`,
  ).run(agentRunId, now);
  db.prepare(
    `INSERT INTO agent_messages (id, saga_instance_id, from_role, to_role, kind, payload, created_at) VALUES ('agent-message-command-cascade-spec', ?, 'planner', 'critic', 'handoff', '{}', ?)`,
  ).run(sagaId, now);
  db.prepare(
    `INSERT INTO agent_snapshots (agent_run_id, last_event_seq, state_json, updated_at) VALUES (?, 1, '{}', ?)`,
  ).run(agentRunId, now);

  applyConversationCommand({
    command: { type: "delete_conversation", conversationId: cascadeConversationId },
    idempotencyKey: createIdempotencyKey("conversation.spec.cascade.delete", cascadeConversationId),
  });

  for (const [table, where] of [
    ["conversations", "id = ?"],
    ["conversation_messages", "conversation_id = ?"],
    ["conversation_event_log", "conversation_id = ?"],
    ["runtime_jobs", "conversation_id = ? OR id = ?"],
    ["artifacts", "conversation_id = ?"],
    ["artifact_interaction_state", "conversation_id = ?"],
    ["goal_event_log", "goal_id = ?"],
    ["goal_deliverables", "goal_id = ?"],
    ["saga_instances", "id = ?"],
    ["agent_runs", "id = ?"],
    ["agent_events", "agent_run_id = ?"],
    ["agent_messages", "saga_instance_id = ?"],
    ["agent_snapshots", "agent_run_id = ?"],
  ] as const) {
    const params =
      table === "runtime_jobs"
        ? [cascadeConversationId, runtimeJobId]
        : table.startsWith("goal_")
          ? [goalId]
          : table === "saga_instances" || table === "agent_messages"
            ? [sagaId]
            : table === "agent_runs" || table === "agent_events" || table === "agent_snapshots"
              ? [agentRunId]
              : [cascadeConversationId];
    const count = (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params) as { count: number })
      .count;
    assert.equal(count, 0, `${table} should be deleted`);
  }

  const topics = db.prepare(`SELECT value_json FROM runtime_state_snapshots WHERE key = 'topics'`).get() as {
    value_json: string;
  };
  const goals = db.prepare(`SELECT value_json FROM runtime_state_snapshots WHERE key = 'goals'`).get() as {
    value_json: string;
  };
  assert.equal(JSON.stringify(JSON.parse(topics.value_json)).includes(cascadeConversationId), false);
  assert.equal(JSON.stringify(JSON.parse(goals.value_json)).includes(cascadeConversationId), false);

  const preDeletedConversationId = "conv-command-predeleted-projection-spec";
  const preDeletedGoalId = "goal-command-predeleted-projection-spec";
  applyConversationCommand({
    command: {
      type: "create_conversation",
      conversation: { id: preDeletedConversationId, title: "预删除投影测试", goalId: preDeletedGoalId },
    },
    idempotencyKey: createIdempotencyKey("conversation.spec.predeleted.create", preDeletedConversationId),
  });
  db.prepare(
    `INSERT OR REPLACE INTO runtime_state_snapshots (key, value_json, updated_at) VALUES (?, ?, ?)`,
  ).run("goals", JSON.stringify({ value: [], revision: 21, updatedAt: now }), now);
  db.prepare(
    `INSERT OR REPLACE INTO runtime_state_snapshots (key, value_json, updated_at) VALUES (?, ?, ?)`,
  ).run("topics", JSON.stringify({ value: [], revision: 22, updatedAt: now }), now);

  applyConversationCommand({
    command: { type: "delete_conversation", conversationId: preDeletedConversationId },
    idempotencyKey: createIdempotencyKey("conversation.spec.predeleted.delete", preDeletedConversationId),
  });
  const preDeletedGoals = db.prepare(`SELECT value_json FROM runtime_state_snapshots WHERE key = 'goals'`).get() as {
    value_json: string;
  };
  const preDeletedTopics = db.prepare(`SELECT value_json FROM runtime_state_snapshots WHERE key = 'topics'`).get() as {
    value_json: string;
  };
  assert.equal(JSON.parse(preDeletedGoals.value_json).revision, 21);
  assert.equal(JSON.parse(preDeletedTopics.value_json).revision, 22);

  const retryDelete = applyConversationCommand({
    command: { type: "delete_conversation", conversationId: preDeletedConversationId },
    idempotencyKey: createIdempotencyKey("conversation.spec.predeleted.delete.retry", preDeletedConversationId),
  });
  assert.equal(retryDelete.event.kind, "conversation.deleted");
}
