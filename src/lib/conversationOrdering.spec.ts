import assert from "node:assert/strict";

import { compareConversations, getConversationSortAt } from "@/lib/conversationOrdering";
import type { Conversation } from "@/types/kiki";

function conversation(input: Partial<Conversation> & Pick<Conversation, "id">): Conversation {
  return {
    id: input.id,
    title: input.title ?? input.id,
    messages: input.messages ?? [],
    createdAt: input.createdAt ?? "2026-06-09T00:00:00.000Z",
    lastMessageAt: input.lastMessageAt,
    lastMessage: input.lastMessage,
    updatedAt: input.updatedAt ?? "2026-06-09T00:00:00.000Z",
    pinned: input.pinned,
    status: input.status ?? "idle",
  };
}

export function runConversationOrderingSpecs() {
  const unpinnedLatest = conversation({
    id: "conv-unpinned-latest",
    lastMessageAt: "2026-06-09T03:00:00.000Z",
  });
  const pinnedOlder = conversation({
    id: "conv-pinned-older",
    pinned: true,
    lastMessageAt: "2026-06-09T01:00:00.000Z",
  });
  assert.deepEqual(
    [unpinnedLatest, pinnedOlder].sort(compareConversations).map((item) => item.id),
    ["conv-pinned-older", "conv-unpinned-latest"],
    "置顶会话应恒排在非置顶会话之前",
  );

  const olderMetadataNewerMessage = conversation({
    id: "conv-message-newer",
    lastMessageAt: "2026-06-09T04:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
  });
  const newerMetadataOlderMessage = conversation({
    id: "conv-metadata-newer",
    lastMessageAt: "2026-06-09T02:00:00.000Z",
    updatedAt: "2026-06-09T05:00:00.000Z",
  });
  assert.deepEqual(
    [newerMetadataOlderMessage, olderMetadataNewerMessage].sort(compareConversations).map((item) => item.id),
    ["conv-message-newer", "conv-metadata-newer"],
    "同一置顶组内应按最后消息时间排序，而非按 updatedAt 排序",
  );

  const emptyOld = conversation({ id: "conv-empty-old", createdAt: "2026-06-09T01:00:00.000Z" });
  const emptyNew = conversation({ id: "conv-empty-new", createdAt: "2026-06-09T02:00:00.000Z" });
  assert.deepEqual(
    [emptyOld, emptyNew].sort(compareConversations).map((item) => item.id),
    ["conv-empty-new", "conv-empty-old"],
    "空会话应按 createdAt 兜底排序",
  );

  const lastMessageFallback = conversation({
    id: "conv-last-message-fallback",
    createdAt: "2026-06-09T01:00:00.000Z",
    lastMessage: {
      id: "msg-last",
      kind: "text",
      role: "user",
      content: "latest",
      createdAt: "2026-06-09T03:00:00.000Z",
      status: "done",
    },
  });
  assert.equal(
    getConversationSortAt(lastMessageFallback),
    "2026-06-09T03:00:00.000Z",
    "缺少 lastMessageAt 时应回退到 lastMessage.createdAt",
  );

  const sameTimeA = conversation({ id: "conv-a", createdAt: "2026-06-09T01:00:00.000Z" });
  const sameTimeB = conversation({ id: "conv-b", createdAt: "2026-06-09T01:00:00.000Z" });
  assert.deepEqual(
    [sameTimeA, sameTimeB].sort(compareConversations).map((item) => item.id),
    ["conv-b", "conv-a"],
    "相同时间戳下应按 id 倒序稳定排序",
  );
}
