import assert from "node:assert/strict";

import { compareConversations } from "@/lib/conversationOrdering";
import { useConversationStore } from "@/stores/conversationStore";
import type { Conversation, ConversationMessage, ConversationSummary } from "@/types/kiki";
import type { ConversationEventRecord } from "@/types/conversationEventLog";

function createConversation(id: string): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
    messages: [],
    createdAt: "2026-06-09T00:00:00.000Z",
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
    runSummaryHydrationDoesNotClearLoadedMessagesSpec();
    runSummaryHydrationKeepsLastMessageForListSpec();
    runSummaryHydrationOrdersByLastMessageAtSpec();
    runAppendMessageMaintainsLastMessageAtSpec();
    runSummaryOnlyReadAndUnreadEventsSpec();
    await runSummaryOnlyDeleteLastMessageResyncsSpec();
    runMessageUpdatedVersionGuardSpec();
    runDeleteMessageResetsRuntimeStateSpec();
    await runUpdateMessageInvokesUpdaterOnceSpec();
    await runDeleteConversationWaitsForServerConfirmationSpec();
    await runDeleteConversationFailureKeepsLocalConversationSpec();
  } finally {
    globalThis.fetch = originalFetch;
    useConversationStore.setState({ conversations: [], conversationsHydrated: false });
  }
}

function createTextMessage(id: string, content: string, unread = false): ConversationMessage {
  return {
    id,
    kind: "text",
    role: "user",
    content,
    createdAt: "2026-06-09T00:00:00.000Z",
    status: "done",
    unread,
  };
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

async function runUpdateMessageInvokesUpdaterOnceSpec() {
  const conversationId = "conv-update-once";
  const messageId = "msg-update-once";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => createJsonResponse(200, { ok: true })) as typeof fetch;
  try {
    const base = createConversation(conversationId);
    base.messages = [createTextMessage(messageId, "")];
    useConversationStore.setState({ conversations: [base], conversationsHydrated: true });

    let calls = 0;
    useConversationStore.getState().updateMessage(conversationId, messageId, (message) => {
      calls += 1;
      return { ...message, content: `updated-${calls}` };
    });

    const current = useConversationStore
      .getState()
      .conversations.find((conversation) => conversation.id === conversationId)
      ?.messages.find((message) => message.id === messageId);

    assert.equal(calls, 1, "updateMessage updater 只能执行一次，避免生成两套随机事件 id");
    assert.equal(current?.content, "updated-1", "本地状态应使用同一次 updater 的结果");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
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

function runSummaryHydrationDoesNotClearLoadedMessagesSpec() {
  const conversationId = "conv-summary-preserve-loaded";
  const loaded = {
    ...createConversation(conversationId),
    messages: [createTextMessage("msg-loaded-1", "local loaded")],
    messagesLoaded: true,
    messageCount: 1,
    unreadCount: 0,
    lastMessage: createTextMessage("msg-loaded-1", "local loaded"),
  };
  const summary: ConversationSummary = {
    id: conversationId,
    title: "Summary title",
    messagesLoaded: false,
    messageCount: 99,
    unreadCount: 3,
    lastMessage: createTextMessage("msg-summary-last", "remote summary", true),
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:02.000Z",
    status: "idle",
  };

  useConversationStore.setState({ conversations: [loaded], conversationsHydrated: true });
  useConversationStore.getState().hydrateConversations([summary]);

  const conversation = useConversationStore.getState().conversations.find((entry) => entry.id === conversationId);
  assert.equal(conversation?.messagesLoaded, true, "summary hydrate 不应把已加载会话降级为未加载");
  assert.equal(conversation?.messages.length, 1, "summary hydrate 不应清空本地已加载消息");
  assert.equal(conversation?.messages[0]?.content, "local loaded");
}

function runSummaryHydrationKeepsLastMessageForListSpec() {
  const conversationId = "conv-summary-list";
  const lastMessage = createTextMessage("msg-summary-list-last", "latest summary", true);
  const summary: ConversationSummary = {
    id: conversationId,
    title: "Summary only",
    messagesLoaded: false,
    messageCount: 12,
    unreadCount: 2,
    lastMessage,
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    status: "idle",
  };

  useConversationStore.setState({ conversations: [], conversationsHydrated: false });
  useConversationStore.getState().hydrateConversations([summary]);

  const conversation = useConversationStore.getState().conversations.find((entry) => entry.id === conversationId);
  assert.equal(conversation?.messagesLoaded, false);
  assert.equal(conversation?.messages.length, 0, "summary-only 会话不应把 lastMessage 塞进 messages 冒充完整历史");
  assert.equal(conversation?.messageCount, 12);
  assert.equal(conversation?.unreadCount, 2);
  assert.equal(conversation?.lastMessage?.content, "latest summary");
}

function runSummaryHydrationOrdersByLastMessageAtSpec() {
  const olderUpdatedNewerMessage: ConversationSummary = {
    id: "conv-newer-message",
    title: "Newer message",
    messagesLoaded: false,
    messageCount: 1,
    unreadCount: 0,
    lastMessage: {
      ...createTextMessage("msg-newer", "newer"),
      createdAt: "2026-06-09T04:00:00.000Z",
    },
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    status: "idle",
  };
  const newerUpdatedOlderMessage: ConversationSummary = {
    id: "conv-newer-metadata",
    title: "Newer metadata",
    messagesLoaded: false,
    messageCount: 1,
    unreadCount: 0,
    lastMessage: {
      ...createTextMessage("msg-older", "older"),
      createdAt: "2026-06-09T02:00:00.000Z",
    },
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T05:00:00.000Z",
    status: "idle",
  };

  useConversationStore.setState({ conversations: [], conversationsHydrated: false });
  useConversationStore.getState().hydrateConversations([newerUpdatedOlderMessage, olderUpdatedNewerMessage]);

  const sortedIds = [...useConversationStore.getState().conversations].sort(compareConversations).map((item) => item.id);
  assert.deepEqual(
    sortedIds,
    ["conv-newer-message", "conv-newer-metadata"],
    "summary hydrate 后应按 lastMessageAt 排序，而非按 updatedAt 排序",
  );
}

function runAppendMessageMaintainsLastMessageAtSpec() {
  const conversationId = "conv-append-last-message-at";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => createJsonResponse(200, { ok: true })) as typeof fetch;
  try {
    const base = {
      ...createConversation(conversationId),
      updatedAt: "2026-06-09T01:00:00.000Z",
    };
    const message = {
      ...createTextMessage("msg-append-latest", "latest"),
      createdAt: "2026-06-09T03:00:00.000Z",
    };
    useConversationStore.setState({ conversations: [base], conversationsHydrated: true });

    useConversationStore.getState().appendMessage(conversationId, message);

    const conversation = useConversationStore.getState().conversations.find((entry) => entry.id === conversationId);
    assert.equal(conversation?.lastMessageAt, "2026-06-09T03:00:00.000Z");
    assert.equal(conversation?.lastMessage?.id, message.id);
    assert.equal(conversation?.updatedAt, "2026-06-09T01:00:00.000Z", "追加消息不应借用 updatedAt 排序");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function runSummaryOnlyReadAndUnreadEventsSpec() {
  const conversationId = "conv-summary-events";
  const lastMessage = createTextMessage("msg-summary-events-last", "latest summary", true);
  const summary: Conversation = {
    ...createConversation(conversationId),
    messages: [],
    messagesLoaded: false,
    messageCount: 5,
    unreadCount: 2,
    lastMessage,
  };
  useConversationStore.setState({ conversations: [summary], conversationsHydrated: true });

  useConversationStore.getState().applyConversationEvent({
    id: 1001,
    eventId: "evt-summary-read",
    conversationId,
    kind: "conversation.read",
    payload: { messageIds: [lastMessage.id], revision: 2 },
    producedBy: "user",
    createdAt: "2026-06-09T00:00:00.000Z",
  });
  let conversation = useConversationStore.getState().conversations.find((entry) => entry.id === conversationId);
  assert.equal(conversation?.unreadCount, 0);
  assert.equal(conversation?.lastMessage?.unread, false);

  useConversationStore.getState().applyConversationEvent({
    id: 1002,
    eventId: "evt-summary-unread",
    conversationId,
    kind: "conversation.unread",
    payload: { revision: 3 },
    producedBy: "user",
    createdAt: "2026-06-09T00:00:00.000Z",
  });
  conversation = useConversationStore.getState().conversations.find((entry) => entry.id === conversationId);
  assert.equal(conversation?.unreadCount, 1);
  assert.equal(conversation?.lastMessage?.unread, true);
}

async function runSummaryOnlyDeleteLastMessageResyncsSpec() {
  const conversationId = "conv-summary-delete-resync";
  const deletedLast = {
    ...createTextMessage("msg-summary-delete-latest", "deleted latest", false),
    createdAt: "2026-06-09T04:00:00.000Z",
  };
  const previousLast = {
    ...createTextMessage("msg-summary-delete-previous", "previous latest", false),
    createdAt: "2026-06-09T02:00:00.000Z",
  };
  const summary: Conversation = {
    ...createConversation(conversationId),
    messages: [],
    messagesLoaded: false,
    messageCount: 2,
    unreadCount: 0,
    lastMessage: deletedLast,
    lastMessageAt: deletedLast.createdAt,
  };
  const remoteSummary: ConversationSummary = {
    id: conversationId,
    title: "Remote after delete",
    messagesLoaded: false,
    messageCount: 1,
    unreadCount: 0,
    lastMessage: previousLast,
    lastMessageAt: previousLast.createdAt,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    status: "idle",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    createJsonResponse(200, {
      ok: true,
      conversations: [remoteSummary],
      latestEventId: 0,
    })) as typeof fetch;
  try {
    useConversationStore.setState({ conversations: [summary], conversationsHydrated: true });
    useConversationStore.getState().applyConversationEvent({
      id: 1003,
      eventId: "evt-summary-delete",
      conversationId,
      kind: "message.deleted",
      payload: { messageId: deletedLast.id },
      producedBy: "user",
      createdAt: "2026-06-09T05:00:00.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const conversation = useConversationStore.getState().conversations.find((entry) => entry.id === conversationId);
    assert.equal(conversation?.lastMessage?.id, previousLast.id);
    assert.equal(conversation?.lastMessageAt, previousLast.createdAt);
    assert.equal(conversation?.messageCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
