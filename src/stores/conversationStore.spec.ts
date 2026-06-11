import assert from "node:assert/strict";

import { useConversationStore } from "@/stores/conversationStore";
import type { Conversation, ConversationMessage } from "@/types/kiki";
import type { ConversationEventRecord } from "@/types/conversationEventLog";

function createConversation(id: string): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
    messages: [],
    updatedAt: "2026-06-09T00:00:00.000Z",
    status: "idle",
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createJsonResponse(status: number, data: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

export async function runConversationStoreSpecs() {
  const originalFetch = globalThis.fetch;
  try {
    runOptimisticHydrationPreservesLocalNewConversationSpec();
    runOptimisticHydrationMergesRemoteConversationSpec();
    runMessageUpdatedVersionGuardSpec();
    runDeleteMessageResetsRuntimeStateSpec();
    await runDeleteConversationWaitsForServerConfirmationSpec();
    await runDeleteConversationFailureKeepsLocalConversationSpec();
  } finally {
    globalThis.fetch = originalFetch;
    useConversationStore.setState({ conversations: [], conversationsHydrated: false });
  }
}

function createStreamingTextMessage(id: string, content: string): ConversationMessage {
  return {
    id,
    kind: "text",
    role: "kiki",
    content,
    createdAt: "2026-06-09T00:00:00.000Z",
    status: "streaming",
    source: "kiki",
    cliProcess: {
      runId: id,
      status: "running",
      startedAt: "2026-06-09T00:00:00.000Z",
      output: content,
      promptSections: [],
      events: [],
    },
  };
}

function createMessageUpdatedEvent(
  id: number,
  conversationId: string,
  message: ConversationMessage,
  version: number,
): ConversationEventRecord<"message.updated"> {
  return {
    id,
    eventId: `evt-${id}`,
    conversationId,
    kind: "message.updated",
    payload: { message, version },
    producedBy: "system",
    createdAt: "2026-06-09T00:00:00.000Z",
  };
}

// 顺序安全守卫：更高 version 的快照应被应用，随后回灌的更旧/重复 version 快照必须被丢弃，
// 不得让旧内容覆盖已应用的较新内容（根治"先词序错乱、刷新后正确"）。
function runMessageUpdatedVersionGuardSpec() {
  const conversationId = "conv-version-guard";
  const messageId = "msg-version-guard";
  // 用唯一 messageId 规避 module 级 version Map 的跨用例污染。
  const base = createConversation(conversationId);
  base.messages = [createStreamingTextMessage(messageId, "")];
  useConversationStore.setState({ conversations: [base], conversationsHydrated: true });

  const apply = (content: string, version: number) =>
    useConversationStore
      .getState()
      .applyConversationEvent(
        createMessageUpdatedEvent(version, conversationId, createStreamingTextMessage(messageId, content), version),
      );

  const currentContent = () =>
    useConversationStore
      .getState()
      .conversations.find((conversation) => conversation.id === conversationId)
      ?.messages.find((message) => message.id === messageId)?.content;

  apply("当然可以，", 1);
  apply("当然可以，序员去面试", 2);
  assert.equal(currentContent(), "当然可以，序员去面试", "更高 version 的快照应被应用");

  // 滞后/乱序回灌的更旧 version 快照（中间态错位内容）必须被丢弃。
  apply("当然可以，序", 1);
  assert.equal(currentContent(), "当然可以，序员去面试", "更旧 version 的快照应被丢弃，不得回退内容");

  // 重复的同一 version 也应被丢弃。
  apply("脏数据", 2);
  assert.equal(currentContent(), "当然可以，序员去面试", "重复 version 的快照应被丢弃");

  // 继续推进的更高 version 仍可正常应用。
  apply("当然可以，序员去面试，面试官问：", 3);
  assert.equal(currentContent(), "当然可以，序员去面试，面试官问：", "后续更高 version 的快照应继续应用");
}

// 泄漏修复：删除消息应回收其 module 级 version/streaming 状态，使同 id 的后续快照不被陈旧的
// 已应用 version 拦截（否则同 id 复用场景下权威快照会被误判为更旧而拒绝应用，导致内容停滞）。
function runDeleteMessageResetsRuntimeStateSpec() {
  const conversationId = "conv-delete-resets-runtime";
  const messageId = "msg-delete-resets-runtime";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => createJsonResponse(200, { ok: true })) as typeof fetch;
  try {
    const base = createConversation(conversationId);
    base.messages = [createStreamingTextMessage(messageId, "")];
    useConversationStore.setState({ conversations: [base], conversationsHydrated: true });

    const apply = (content: string, version: number) =>
      useConversationStore
        .getState()
        .applyConversationEvent(
          createMessageUpdatedEvent(version, conversationId, createStreamingTextMessage(messageId, content), version),
        );
    const currentContent = () =>
      useConversationStore
        .getState()
        .conversations.find((conversation) => conversation.id === conversationId)
        ?.messages.find((message) => message.id === messageId)?.content;

    apply("推进到版本5", 5);
    assert.equal(currentContent(), "推进到版本5", "应应用 version 5 快照");

    // 删除该消息：应回收已应用的 version 记录。
    useConversationStore.getState().deleteMessage(conversationId, messageId);
    assert.equal(
      useConversationStore
        .getState()
        .conversations.find((conversation) => conversation.id === conversationId)
        ?.messages.length,
      0,
      "删除后消息应被移除",
    );

    // 重新出现同 id 的消息（如服务端补发），低 version 应能正常应用而非被旧记录拦截。
    const reborn = createConversation(conversationId);
    reborn.messages = [createStreamingTextMessage(messageId, "")];
    useConversationStore.setState({ conversations: [reborn], conversationsHydrated: true });
    apply("新生命周期版本1", 1);
    assert.equal(currentContent(), "新生命周期版本1", "删除回收 version 后，同 id 低 version 快照应可重新应用");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function runOptimisticHydrationPreservesLocalNewConversationSpec() {
  const localNew = createConversation("conv-new-local-only");
  const remoteExisting = createConversation("conv-existing-remote");

  useConversationStore.setState({
    conversations: [localNew],
    conversationsHydrated: true,
  });
  useConversationStore.getState().hydrateConversations([remoteExisting]);

  const conversations = useConversationStore.getState().conversations;
  assert.ok(
    conversations.some((conversation) => conversation.id === localNew.id),
    "远端旧快照不包含本地 conv-new-* 时，应保留本地乐观会话",
  );
  assert.ok(
    conversations.some((conversation) => conversation.id === remoteExisting.id),
    "远端快照中的会话仍应正常合入",
  );
}

function runOptimisticHydrationMergesRemoteConversationSpec() {
  const conversationId = "conv-new-remote-catches-up";
  const localNew = createConversation(conversationId);
  const remoteNew = {
    ...createConversation(conversationId),
    title: "Remote confirmed title",
    updatedAt: "2026-06-09T00:00:01.000Z",
  };

  useConversationStore.setState({
    conversations: [localNew],
    conversationsHydrated: true,
  });
  useConversationStore.getState().hydrateConversations([remoteNew]);

  const conversations = useConversationStore.getState().conversations.filter(
    (conversation) => conversation.id === conversationId,
  );
  assert.equal(conversations.length, 1, "后续远端快照包含同一 conv-new-* 时不应产生重复会话");
  assert.equal(conversations[0]?.title, remoteNew.title, "远端确认后的字段应合并更新本地乐观会话");
}

async function runDeleteConversationWaitsForServerConfirmationSpec() {
  const conversationId = "conv-front-delete-success";
  const requests: Array<{ url: string; body: unknown }> = [];
  const response = createDeferred<Response>();
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return response.promise;
  }) as typeof fetch;

  useConversationStore.setState({ conversations: [createConversation(conversationId)] });
  const deletePromise = useConversationStore.getState().deleteConversation(conversationId);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "/api/conversations/commands");
  assert.equal((requests[0]?.body as { command?: { type?: string; conversationId?: string } }).command?.type, "delete_conversation");
  assert.equal(
    (requests[0]?.body as { command?: { type?: string; conversationId?: string } }).command?.conversationId,
    conversationId,
  );
  assert.ok(
    useConversationStore.getState().conversations.some((conversation) => conversation.id === conversationId),
    "后端确认前不应乐观移除会话",
  );

  response.resolve(createJsonResponse(200, { ok: true }));
  await deletePromise;

  assert.ok(
    !useConversationStore.getState().conversations.some((conversation) => conversation.id === conversationId),
    "后端确认后应移除本地会话",
  );
  assert.ok(
    requests.every(
      (request) => !request.url.includes("/workspace") && !request.url.includes("/api/goals/commands"),
    ),
    "删除会话不应串联 workspace 或 goals 删除接口",
  );
}

async function runDeleteConversationFailureKeepsLocalConversationSpec() {
  const conversationId = "conv-front-delete-failure";
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return createJsonResponse(500, { ok: false, reason: "deep delete failed" });
  }) as typeof fetch;

  useConversationStore.setState({ conversations: [createConversation(conversationId)] });
  await assert.rejects(
    () => useConversationStore.getState().deleteConversation(conversationId),
    /deep delete failed/,
  );

  assert.equal(requests.length, 1);
  assert.ok(
    useConversationStore.getState().conversations.some((conversation) => conversation.id === conversationId),
    "后端失败时不应移除本地会话",
  );
}
