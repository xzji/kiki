import assert from "node:assert/strict";

import { useConversationStore } from "@/stores/conversationStore";
import type { Conversation } from "@/types/kiki";

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
    await runDeleteConversationWaitsForServerConfirmationSpec();
    await runDeleteConversationFailureKeepsLocalConversationSpec();
  } finally {
    globalThis.fetch = originalFetch;
    useConversationStore.setState({ conversations: [], conversationsHydrated: false });
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
