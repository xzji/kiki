import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import { getUserMemoryDir, getUserProfileMemoryFilePath } from "@/lib/server/storage/paths";
import { listConversationMessages } from "@/lib/server/repositories/conversationMessagesRepository";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  applyConversationCommand,
  ConversationCommandConflictError,
  ConversationCommandIdempotencyConflictError,
} from "@/lib/server/services/conversationCommandService";
import {
  ensureConversationWorkspace,
  getConversationSessionMemoryFilePath,
} from "@/lib/server/workspace/conversationWorkspace";
import type { ConversationMessage } from "@/types/kiki";

function textMessage(id: string, content: string): Extract<ConversationMessage, { kind: "text" }> {
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
    command: {
      type: "append_message",
      conversationId,
      message: {
        ...textMessage("msg-spec-1", "hello"),
        quotedMessage: {
          roleLabel: "KiKi",
          content: "上一条任务结果摘要",
          messageId: "msg-task-spec",
          messageKind: "task_card",
          taskRef: {
            goalId: "goal-spec",
            subGoalId: "sub-spec",
            taskId: "task-spec",
            instanceId: "inst-spec",
          },
        },
      },
    },
    idempotencyKey: createIdempotencyKey("conversation.spec.message", conversationId, "msg-spec-1"),
  });
  assert.equal(appended.conversation?.messages.length, 1);
  assert.equal(
    (appended.conversation?.messages[0]?.kind === "text" && appended.conversation.messages[0].quotedMessage?.content) || "",
    "上一条任务结果摘要",
  );

  const confirmationMessage: Extract<ConversationMessage, { kind: "governance_confirmation" }> = {
    id: "msg-governance-confirm-1",
    kind: "governance_confirmation",
    role: "kiki",
    content: "确认修改任务标准",
    createdAt: new Date().toISOString(),
    status: "done",
    governance: {
      status: "pending",
      summary: "给任务增加来源 URL 要求",
      diffs: [{ field: "expectedResult.completionCriteria", before: "包含事件", after: "包含事件\n包含来源 URL" }],
      payload: {
        intent: "amend_task",
        taskRef: {
          goalId: "goal-spec",
          subGoalId: "sub-spec",
          taskId: "task-spec",
        },
        patch: {
          expectedResult: {
            completionCriteria: "包含来源 URL",
          },
        },
      },
      userMessage: "下次增加来源 URL",
    },
  };
  applyConversationCommand({
    command: {
      type: "append_message",
      conversationId,
      message: confirmationMessage,
    },
    idempotencyKey: createIdempotencyKey("conversation.spec.governance.confirm", conversationId),
  });
  const confirmationMessages = listConversationMessages({ conversationId, afterSeq: 1, limit: 10 });
  const restoredConfirmation = confirmationMessages.find((message) => message.id === confirmationMessage.id);
  assert.equal(restoredConfirmation?.kind, "governance_confirmation");
  assert.equal(
    restoredConfirmation?.kind === "governance_confirmation" && restoredConfirmation.governance.payload.intent,
    "amend_task",
  );

  const duplicateAppend = applyConversationCommand({
    command: { type: "append_message", conversationId, message: textMessage("msg-spec-1", "hello") },
    idempotencyKey: createIdempotencyKey("conversation.spec.message.retry", conversationId, "msg-spec-1"),
  });
  assert.equal(duplicateAppend.conversation?.messages.length, 2);

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
    ["msg-governance-confirm-1", "msg-spec-2"],
  );

  const cascadeConversationId = "conv-command-cascade-spec";
  const goalId = "goal-command-cascade-spec";
  const threadId = "thread-command-cascade-spec";
  const taskId = "task-command-cascade-spec";
  const instanceId = "instance-command-cascade-spec";
  const sagaId = "saga-command-cascade-spec";
  const agentRunId = "agent-run-command-cascade-spec";
  const runtimeOnlyAgentRunId = "agent-run-runtime-only-command-cascade-spec";
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
      INSERT INTO inbox_item_states (
        inbox_item_id, goal_id, status, favorite, unread, updated_at, created_at
      ) VALUES ('inbox-item-command-cascade-spec', ?, 'active', 0, 1, ?, ?)
    `,
  ).run(goalId, now, now);
  db.prepare(
    `
      INSERT INTO task_notification_states (
        instance_id, goal_id, task_id, notification_json, delivery_state,
        notification_sequence, inbox_item_id, conversation_message_ids_json, updated_at, created_at
      ) VALUES (?, ?, ?, '{}', 'delivered', 1, 'inbox-item-command-cascade-spec', '[]', ?, ?)
    `,
  ).run(instanceId, goalId, taskId, now, now);
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
  db.prepare(
    `
      INSERT INTO agent_runs (
        id, runtime_job_id, role, status, started_at
      ) VALUES (?, ?, 'executor', 'running', ?)
    `,
  ).run(runtimeOnlyAgentRunId, runtimeJobId, now);
  db.prepare(
    `INSERT INTO agent_events (id, agent_run_id, seq, type, payload, created_at) VALUES ('agent-event-runtime-only-command-cascade-spec', ?, 1, 'started', '{}', ?)`,
  ).run(runtimeOnlyAgentRunId, now);
  db.prepare(
    `INSERT INTO agent_snapshots (agent_run_id, last_event_seq, state_json, updated_at) VALUES (?, 1, '{}', ?)`,
  ).run(runtimeOnlyAgentRunId, now);

  applyConversationCommand({
    command: { type: "delete_conversation", conversationId: cascadeConversationId },
    idempotencyKey: createIdempotencyKey("conversation.spec.cascade.delete", cascadeConversationId),
  });

  for (const [table, where] of [
    ["conversations", "id = ?"],
    ["conversation_messages", "conversation_id = ?"],
    ["runtime_jobs", "conversation_id = ? OR id = ?"],
    ["artifacts", "conversation_id = ?"],
    ["artifact_interaction_state", "conversation_id = ?"],
    ["goal_event_log", "goal_id = ?"],
    ["goal_deliverables", "goal_id = ?"],
    ["task_notification_states", "goal_id = ?"],
    ["inbox_item_states", "goal_id = ?"],
    ["saga_instances", "id = ?"],
    ["agent_runs", "id = ?"],
    ["agent_events", "agent_run_id = ?"],
    ["agent_messages", "saga_instance_id = ?"],
    ["agent_snapshots", "agent_run_id = ?"],
  ] as const) {
    const params =
      table === "runtime_jobs"
        ? [cascadeConversationId, runtimeJobId]
        : table.startsWith("goal_") || table === "task_notification_states" || table === "inbox_item_states"
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
  const deleteEvents = db
    .prepare(
      `
        SELECT kind, idempotency_key FROM conversation_event_log
        WHERE conversation_id = ?
      `,
    )
    .all(cascadeConversationId) as Array<{ kind: string; idempotency_key: string | null }>;
  assert.deepEqual(
    deleteEvents.map((event) => event.kind),
    ["conversation.deleted"],
    "conversation_event_log should keep only the tombstone delete event",
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM agent_runs WHERE id = ?`).get(runtimeOnlyAgentRunId) as { count: number })
      .count,
    0,
    "agent_runs linked only by runtime_job_id should be deleted",
  );
  assert.equal(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM agent_events WHERE agent_run_id = ?`)
        .get(runtimeOnlyAgentRunId) as { count: number }
    ).count,
    0,
    "agent_events linked only by runtime_job_id should be deleted",
  );
  assert.equal(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM agent_snapshots WHERE agent_run_id = ?`)
        .get(runtimeOnlyAgentRunId) as { count: number }
    ).count,
    0,
    "agent_snapshots linked only by runtime_job_id should be deleted",
  );

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
  const sameDeleteKey = createIdempotencyKey("conversation.spec.predeleted.delete.same-key", preDeletedConversationId);
  const firstSameKeyDelete = applyConversationCommand({
    command: { type: "delete_conversation", conversationId: preDeletedConversationId },
    idempotencyKey: sameDeleteKey,
  });
  const secondSameKeyDelete = applyConversationCommand({
    command: { type: "delete_conversation", conversationId: preDeletedConversationId },
    idempotencyKey: sameDeleteKey,
  });
  assert.equal(secondSameKeyDelete.event.id, firstSameKeyDelete.event.id, "delete command should be idempotent by key");

  const deepConversationId = "conv-command-deep-delete-spec";
  const profilePath = getUserProfileMemoryFilePath();
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, "# User Memory\n\n## 项目偏好\n- profile should stay\n", "utf8");
  const workspace = ensureConversationWorkspace(deepConversationId);
  fs.writeFileSync(getConversationSessionMemoryFilePath(deepConversationId), "# Session Memory\n\n临时记忆\n", "utf8");
  fs.writeFileSync(path.join(workspace.workspaceDir, "attachments", "input.txt"), "attachment", "utf8");
  fs.mkdirSync(path.join(workspace.workspaceDir, "logs", "claude-traces"), { recursive: true });
  fs.writeFileSync(path.join(workspace.workspaceDir, "logs", "claude-traces", "trace.jsonl"), "trace\n", "utf8");
  const candidatesPath = path.join(getUserMemoryDir(), "candidates.json");
  fs.writeFileSync(
    candidatesPath,
    `${JSON.stringify(
      {
        version: 1,
        candidates: [
          {
            candidateKey: "keep-other-source",
            patch: { op: "add", section: "workPreferences", content: "保留其他来源", confidence: "high" },
            sourceConversationIds: [deepConversationId, "conv-other-source"],
            hitCount: 2,
            confidence: "high",
            contentHash: "hash-keep",
            firstSeenAt: now,
            lastSeenAt: now,
          },
          {
            candidateKey: "remove-empty-source",
            patch: { op: "add", section: "workPreferences", content: "删除空来源", confidence: "high" },
            sourceConversationIds: [deepConversationId],
            hitCount: 1,
            confidence: "high",
            contentHash: "hash-remove",
            firstSeenAt: now,
            lastSeenAt: now,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  applyConversationCommand({
    command: {
      type: "create_conversation",
      conversation: {
        id: deepConversationId,
        title: "深度删除测试",
        runtimeSessions: { claude: "11111111-1111-4111-8111-111111111111" },
      },
    },
    idempotencyKey: createIdempotencyKey("conversation.spec.deep.create", deepConversationId),
  });
  applyConversationCommand({
    command: { type: "delete_conversation", conversationId: deepConversationId },
    idempotencyKey: createIdempotencyKey("conversation.spec.deep.delete", deepConversationId),
  });
  assert.equal(fs.existsSync(workspace.workspaceDir), false, "conversation workspace should be removed");
  assert.equal(fs.readFileSync(profilePath, "utf8").includes("profile should stay"), true, "profile memory should stay");
  const candidateFile = JSON.parse(fs.readFileSync(candidatesPath, "utf8")) as {
    candidates: Array<{ candidateKey: string; sourceConversationIds: string[] }>;
  };
  assert.deepEqual(
    candidateFile.candidates.map((candidate) => [candidate.candidateKey, candidate.sourceConversationIds]),
    [["keep-other-source", ["conv-other-source"]]],
  );
  const auditPath = path.join(getUserMemoryDir(), "audit.jsonl");
  const auditLines = fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    target: string;
    conversationId?: string;
    action: string;
  });
  assert.equal(
    auditLines.some(
      (event) => event.target === "session" && event.conversationId === deepConversationId && event.action === "clear",
    ),
    true,
    "session memory cleanup should be audited",
  );
  assert.equal(
    auditLines.some(
      (event) => event.target === "candidate" && event.conversationId === deepConversationId && event.action === "clear",
    ),
    true,
    "candidate memory cleanup should be audited",
  );
}
