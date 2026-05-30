import assert from "node:assert/strict";

import { createIdempotencyKey } from "@/lib/opaqueIds";
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
}
