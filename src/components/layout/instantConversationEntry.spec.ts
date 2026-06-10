import assert from "node:assert/strict";

import { startInstantConversationEntry } from "@/components/layout/instantConversationEntry";
import type { Conversation } from "@/types/kiki";

function createConversation(id: string): Conversation {
  return {
    id,
    title: "新会话",
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

async function flushMicrotasks() {
  await Promise.resolve();
}

export async function runInstantConversationEntrySpecs() {
  await runNavigatesBeforeWorkspaceInitializationSettlesSpec();
  await runWorkspaceFailureIsNonBlockingSpec();
}

async function runNavigatesBeforeWorkspaceInitializationSettlesSpec() {
  const conversation = createConversation("conv-new-instant-entry");
  const workspace = createDeferred<string>();
  const operations: string[] = [];
  const workspaceUpdates: Array<{ conversationId: string; workspacePath: string }> = [];

  const returned = startInstantConversationEntry({
    createConversation: () => {
      operations.push("create");
      return conversation;
    },
    ensureConversationWorkspace: (conversationId) => {
      operations.push(`ensure:${conversationId}`);
      return workspace.promise;
    },
    navigate: (href) => {
      operations.push(`navigate:${href}`);
    },
    setConversationWorkspace: (conversationId, workspacePath) => {
      operations.push(`workspace:${workspacePath}`);
      workspaceUpdates.push({ conversationId, workspacePath });
    },
    setConversationBackgroundIssue: () => {
      operations.push("issue");
    },
  });

  assert.equal(returned.id, conversation.id);
  assert.deepEqual(operations, [
    "create",
    `ensure:${conversation.id}`,
    `navigate:/conversations/${conversation.id}`,
  ]);
  assert.deepEqual(workspaceUpdates, [], "跳转不应等待 workspace 初始化完成");

  workspace.resolve("/tmp/kiki-conv-new-instant-entry");
  await flushMicrotasks();

  assert.deepEqual(workspaceUpdates, [
    {
      conversationId: conversation.id,
      workspacePath: "/tmp/kiki-conv-new-instant-entry",
    },
  ]);
  assert.deepEqual(operations.slice(0, 3), [
    "create",
    `ensure:${conversation.id}`,
    `navigate:/conversations/${conversation.id}`,
  ]);
}

async function runWorkspaceFailureIsNonBlockingSpec() {
  const conversation = createConversation("conv-new-workspace-failure");
  const workspace = createDeferred<string>();
  const navigations: string[] = [];
  const issues: Array<NonNullable<Conversation["backgroundIssue"]>> = [];

  startInstantConversationEntry({
    createConversation: () => conversation,
    ensureConversationWorkspace: () => workspace.promise,
    navigate: (href) => navigations.push(href),
    setConversationWorkspace: () => {
      throw new Error("workspace should not be set after failure");
    },
    setConversationBackgroundIssue: (_conversationId, issue) => {
      if (issue) issues.push(issue);
    },
    now: () => new Date("2026-06-09T00:00:02.000Z"),
  });

  assert.deepEqual(navigations, [`/conversations/${conversation.id}`]);

  workspace.reject(new Error("workspace bootstrap failed"));
  await flushMicrotasks();

  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.kind, "workspace");
  assert.equal(issues[0]?.message, "workspace bootstrap failed");
  assert.equal(issues[0]?.occurredAt, "2026-06-09T00:00:02.000Z");
  assert.equal(issues[0]?.retryable, true);
}
