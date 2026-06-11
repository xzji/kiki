"use client";

import { create } from "zustand";

import {
  appendConversationMessageCommand,
  createConversationCommand,
  deleteConversationCommand,
  deleteConversationMessageCommand,
  fetchConversationState,
  markConversationMessageReadCommand,
  markConversationReadCommand,
  markConversationUnreadCommand,
  renameConversationCommand,
  setConversationGoalCommand,
  setConversationRuntimeEnvCommand,
  setConversationStatusCommand,
  setConversationWorkspaceCommand,
  setGoalInfoCollectionCommand,
  setPlanningRunStateCommand,
  toggleConversationPinnedCommand,
  updateConversationMessageCommand,
} from "@/lib/api/conversation-commands";
import { migrateConversationIds, normalizeGoalId } from "@/lib/opaqueIds";
import type { ConversationEventRecord } from "@/types/conversationEventLog";
import type { Conversation, ConversationMessage, GoalInfoCollection, GoalPlanningRunState } from "@/types/kiki";
import type { CliProcessEvent, CliPromptSection, ConversationCliProcess } from "@/types/runtime";

type ConversationStore = {
  conversations: Conversation[];
  conversationsHydrated: boolean;
  setConversationsHydrated: (hydrated: boolean) => void;
  hydrateConversations: (conversations: Conversation[]) => void;
  applyConversationEvent: (event: ConversationEventRecord) => void;
  setConversationBackgroundIssue: (
    conversationId: string,
    issue: Conversation["backgroundIssue"],
  ) => void;
  createConversation: (title?: string) => Conversation;
  appendMessage: (conversationId: string, message: ConversationMessage) => void;
  updateMessage: (
    conversationId: string,
    messageId: string,
    updater: (message: ConversationMessage) => ConversationMessage,
  ) => void;
  markConversationRead: (conversationId: string) => void;
  markConversationUnread: (conversationId: string) => void;
  markMessageRead: (conversationId: string, messageId: string) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  deleteConversation: (conversationId: string) => Promise<void>;
  toggleConversationPinned: (conversationId: string) => void;
  setGoalForConversation: (conversationId: string, goalId: string) => void;
  setGoalInfoCollection: (conversationId: string, collection: GoalInfoCollection | null) => void;
  setPlanningRunState: (conversationId: string, state: GoalPlanningRunState | null) => void;
  renameConversation: (conversationId: string, title: string) => void;
  setConversationWorkspace: (conversationId: string, workspacePath: string) => void;
  setConversationRuntimeEnv: (conversationId: string, runtimeEnvId: string) => void;
  setConversationStatus: (conversationId: string, status: Conversation["status"]) => void;
};

const MOCK_GOAL_IDS = new Set(
  [
    "goal-toefl",
    "goal-suv",
    "goal-osaka",
    "goal-mail",
    "goal-news",
    "goal-job",
    "goal-tomato-egg",
  ].map((id) => normalizeGoalId(id)),
);
const MOCK_CONVERSATION_IDS = new Set([
  "conv-new-1779009317391",
  ...Array.from(MOCK_GOAL_IDS, (goalId) => `conv-${goalId}`),
]);
const LEGACY_MOCK_CONVERSATION_TITLES = new Set(["越南玩5天"]);
const TERMINAL_CONTROL_NOTICE_PATTERNS = [
  /^\s*（已停止，未检测到正在运行的任务）\s*$/gm,
  /^\s*已停止，未检测到正在运行的任务。\s*$/gm,
];

function sanitizeConversationMessageContent(content: string) {
  return TERMINAL_CONTROL_NOTICE_PATTERNS.reduce(
    (next, pattern) => next.replace(pattern, ""),
    content,
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeConversationHistory(conversations: Conversation[]) {
  return conversations
    .map((conversation) => migrateConversationIds(conversation))
    .filter((conversation) => !MOCK_CONVERSATION_IDS.has(conversation.id))
    .filter((conversation) => !conversation.goalId || !MOCK_GOAL_IDS.has(conversation.goalId))
    .filter((conversation) => !LEGACY_MOCK_CONVERSATION_TITLES.has(conversation.title))
    .map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => ({
        ...message,
        content: sanitizeConversationMessageContent(message.content),
      })),
    }));
}

function mergeById<T extends { id: string }>(primary: T[], secondary: T[]) {
  const merged = new Map<string, T>();
  for (const item of secondary) merged.set(item.id, item);
  for (const item of primary) merged.set(item.id, item);
  return Array.from(merged.values());
}

function sortCliEvents(events: CliProcessEvent[]) {
  return [...events].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
}

// 本端正在本地实时流式驱动的消息 id（由 updateMessage 维护）。仅发送端会逐 token 调 updateMessage
// 推进 streaming 消息；这些消息的本地内容总是领先于本端自产、滞后回灌的快照，因此合并时以本地为准，
// 避免视觉回退抖动。观察方不在此集合内，其消息内容由回灌快照驱动（配合 version 单调守卫前进）。
const locallyStreamingMessageIds = new Set<string>();

function pickCliProcessOutput(
  local: ConversationCliProcess,
  incoming: ConversationCliProcess,
  localLeads: boolean,
) {
  if (incoming.status !== "running") return incoming.output;
  if (localLeads && local.status === "running") return local.output;
  return incoming.output;
}

function pickMessageContent(
  local: Extract<ConversationMessage, { kind: "text" }>,
  incoming: Extract<ConversationMessage, { kind: "text" }>,
  localLeads: boolean,
) {
  if (!local.cliProcess || !incoming.cliProcess) return incoming.content;
  if (incoming.cliProcess.status !== "running") return incoming.content;
  if (localLeads && local.cliProcess.status === "running") return local.content;
  return incoming.content;
}

function getMessageCliProcess(message: ConversationMessage | undefined) {
  if (!message) return undefined;
  if (message.kind === "text" || message.kind === "goal_plan_card") return message.cliProcess;
  return undefined;
}

function mergeCliProcess(
  local: ConversationCliProcess | undefined,
  incoming: ConversationCliProcess | undefined,
  localLeads: boolean,
) {
  if (!local) return incoming;
  if (!incoming) return local;

  const terminalStatus = incoming.status !== "running" ? incoming.status : local.status;
  const promptSections = mergeById<CliPromptSection>(local.promptSections, incoming.promptSections);
  const events = sortCliEvents(mergeById<CliProcessEvent>(local.events, incoming.events));

  return {
    ...incoming,
    status: terminalStatus,
    startedAt: local.startedAt || incoming.startedAt,
    finishedAt: incoming.finishedAt ?? local.finishedAt,
    promptSections,
    events,
    output: pickCliProcessOutput(local, incoming, localLeads),
    error: incoming.error ?? local.error,
  };
}

function mergeMessagePreservingCliProcess(local: ConversationMessage | undefined, incoming: ConversationMessage) {
  if (!local) return incoming;
  // 仅当这条消息正由本端本地实时流式推进时，本地内容才领先于回灌快照。
  const localLeads = locallyStreamingMessageIds.has(incoming.id);
  const cliProcess = mergeCliProcess(getMessageCliProcess(local), getMessageCliProcess(incoming), localLeads);
  if (!cliProcess) return incoming;
  const content = local.kind === "text" && incoming.kind === "text"
    ? pickMessageContent(local, incoming, localLeads)
    : incoming.content;

  if (incoming.kind === "text" || incoming.kind === "goal_plan_card") {
    return {
      ...incoming,
      content,
      cliProcess,
    };
  }
  return incoming;
}

function mergeConversationPreservingCliProcess(local: Conversation | undefined, incoming: Conversation) {
  if (!local) return incoming;
  const localMessages = new Map(local.messages.map((message) => [message.id, message]));
  return {
    ...incoming,
    messages: incoming.messages.map((message) => mergeMessagePreservingCliProcess(localMessages.get(message.id), message)),
  };
}

function mergeConversationsById(...groups: Conversation[][]) {
  const merged = new Map<string, Conversation>();
  for (const group of groups) {
    for (const conversation of group) {
      if (!merged.has(conversation.id)) merged.set(conversation.id, conversation);
    }
  }
  return Array.from(merged.values()).sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
}

function isLocalOptimisticConversation(conversation: Conversation) {
  return conversation.id.startsWith("conv-new-");
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function sendConversationCommand(task: Promise<unknown>, onError?: (error: unknown) => void) {
  task.catch((error) => {
    console.error("[conversation-command]", error);
    onError?.(error);
    void resyncConversations();
  });
}

const messageUpdateQueues = new Map<string, Promise<unknown>>();
// 流式更新去抖合并：本地 UI 仍逐 token 更新（发送端体验不变），但发往服务端的 update_message
// 按 ~120ms 合并为一帧，仅发"最新快照"。这样几百字回复的 POST/message.updated 事件量降 1~2 个
// 数量级，根治事件膨胀与观察方重放卡顿；消息进入终态（非 streaming）时立即 flush，保证最终内容必达。
const MESSAGE_UPDATE_FLUSH_MS = 120;
const messageUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const messageUpdatePayloads = new Map<string, ConversationMessage>();

// 复用 per-key 串行队列：去抖后的请求仍严格按入队顺序落库，确保服务端 version 单调递增。
function enqueueMessageUpdate(conversationId: string, messageId: string, message: ConversationMessage) {
  const key = `${conversationId}:${messageId}`;
  const previous = messageUpdateQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => updateConversationMessageCommand(conversationId, messageId, message))
    .catch((error) => {
      console.error("[conversation-command]", error);
      void resyncConversations();
    });
  messageUpdateQueues.set(key, next);
  void next.finally(() => {
    if (messageUpdateQueues.get(key) === next) {
      messageUpdateQueues.delete(key);
    }
  });
}

function flushMessageUpdate(key: string, conversationId: string, messageId: string) {
  const timer = messageUpdateTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    messageUpdateTimers.delete(key);
  }
  const message = messageUpdatePayloads.get(key);
  if (!message) return;
  messageUpdatePayloads.delete(key);
  enqueueMessageUpdate(conversationId, messageId, message);
}

function sendConversationMessageUpdateCommand(
  conversationId: string,
  messageId: string,
  message: ConversationMessage,
) {
  const key = `${conversationId}:${messageId}`;
  messageUpdatePayloads.set(key, message);
  // 终态（done/error 等）立即 flush，保证最终内容必达，不被去抖窗口延迟或丢弃。
  if (message.status !== "streaming") {
    flushMessageUpdate(key, conversationId, messageId);
    return;
  }
  // 流式中：已有待发帧则只更新 payload（合并），不重复起定时器。
  if (messageUpdateTimers.has(key)) return;
  messageUpdateTimers.set(
    key,
    setTimeout(() => {
      messageUpdateTimers.delete(key);
      flushMessageUpdate(key, conversationId, messageId);
    }, MESSAGE_UPDATE_FLUSH_MS),
  );
}

let resyncPending = false;
async function resyncConversations() {
  if (resyncPending) return;
  resyncPending = true;
  try {
    const remote = await fetchConversationState();
    useConversationStore.getState().hydrateConversations(remote.conversations);
  } catch (error) {
    console.error("[conversation-resync]", error);
  } finally {
    resyncPending = false;
  }
}

function upsertConversation(conversations: Conversation[], next: Conversation) {
  const found = conversations.some((item) => item.id === next.id);
  return found
    ? conversations.map((item) =>
        item.id === next.id ? mergeConversationPreservingCliProcess(item, next) : item,
      )
    : [next, ...conversations];
}

type ConversationEventLoosePayload = {
  conversation?: Conversation;
  title?: string;
  pinned?: boolean;
  goalId?: string;
  workspacePath?: string;
  workspaceInitializedAt?: string;
  runtimeEnvId?: string;
  runtimeKind?: string;
  sessionId?: string;
  status?: Conversation["status"];
  collection?: GoalInfoCollection | null;
  state?: GoalPlanningRunState | null;
  message?: ConversationMessage;
  messageId?: string;
  version?: number;
};

// message.updated 顺序安全守卫：服务端为每条消息维护单调自增 version（见
// conversationMessagesRepository.updateConversationMessage），事件 payload 透传该 version。
// 观察方/回灌方按 messageId 记录已应用的最大 version，丢弃更旧或重复的快照，
// 从根本上消除"旧快照临时覆盖正确内容"导致的词序错乱。
const appliedMessageVersions = new Map<string, number>();
const APPLIED_MESSAGE_VERSIONS_MAX = 5000;

function shouldApplyMessageVersion(messageId: string, version: number | undefined) {
  if (typeof version !== "number") return true;
  const applied = appliedMessageVersions.get(messageId) ?? -1;
  if (version <= applied) return false;
  appliedMessageVersions.set(messageId, version);
  if (appliedMessageVersions.size > APPLIED_MESSAGE_VERSIONS_MAX) {
    const overflow = appliedMessageVersions.size - APPLIED_MESSAGE_VERSIONS_MAX;
    const iterator = appliedMessageVersions.keys();
    for (let i = 0; i < overflow; i += 1) {
      const next = iterator.next();
      if (next.done) break;
      appliedMessageVersions.delete(next.value);
    }
  }
  return true;
}

// 消息被删除时回收其 module 级流式/版本状态，避免：
// 1) locallyStreamingMessageIds 残留导致后续同 id 回灌的权威快照被误判"本地领先"而拒绝应用（内容停滞）；
// 2) appliedMessageVersions 条目无法回收，长程运行下挤占 5000 上限并误淘汰活跃条目。
function forgetMessageRuntimeState(messageId: string) {
  locallyStreamingMessageIds.delete(messageId);
  appliedMessageVersions.delete(messageId);
}

function applyConversationEventToList(conversations: Conversation[], event: ConversationEventRecord) {
  const payload = event.payload as ConversationEventLoosePayload;
  if (event.kind === "conversation.created") return upsertConversation(conversations, payload.conversation as Conversation);
  if (event.kind === "conversation.deleted") return conversations.filter((item) => item.id !== event.conversationId);
  return conversations.map((conversation) => {
    if (conversation.id !== event.conversationId) return conversation;
    switch (event.kind) {
      case "conversation.renamed":
        return { ...conversation, title: payload.title ?? conversation.title };
      case "conversation.pinned_toggled":
        return { ...conversation, pinned: payload.pinned ?? conversation.pinned };
      case "conversation.goal_set":
        return { ...conversation, goalId: payload.goalId };
      case "conversation.workspace_set":
        return {
          ...conversation,
          workspacePath: payload.workspacePath,
          workspaceInitializedAt: payload.workspaceInitializedAt,
        };
      case "conversation.runtime_env_set":
        return { ...conversation, runtimeEnvId: payload.runtimeEnvId };
      case "conversation.runtime_session_set": {
        const runtimeKind = payload.runtimeKind;
        if (!runtimeKind) return conversation;
        const nextSessions = { ...(conversation.runtimeSessions ?? {}) };
        if (payload.sessionId) {
          nextSessions[runtimeKind] = payload.sessionId;
        } else {
          delete nextSessions[runtimeKind];
        }
        return {
          ...conversation,
          runtimeSessions: Object.keys(nextSessions).length > 0 ? nextSessions : undefined,
        };
      }
      case "conversation.status_changed":
        return { ...conversation, status: payload.status ?? conversation.status };
      case "conversation.goal_info_collection_updated":
        return { ...conversation, goalInfoCollection: payload.collection ?? undefined };
      case "conversation.planning_run_state_updated":
        return { ...conversation, planningRunState: payload.state ?? undefined };
      case "conversation.read":
        return { ...conversation, messages: conversation.messages.map((message) => ({ ...message, unread: false })) };
      case "conversation.unread": {
        const lastIndex = conversation.messages.length - 1;
        return {
          ...conversation,
          messages: conversation.messages.map((message, index) =>
            index === lastIndex ? { ...message, unread: true } : message,
          ),
        };
      }
      case "message.appended": {
        if (!payload.message) return conversation;
        return conversation.messages.some((message) => message.id === payload.message?.id)
          ? conversation
          : { ...conversation, messages: [...conversation.messages, payload.message] };
      }
      case "message.updated": {
        if (!payload.message) return conversation;
        // 顺序安全守卫：丢弃比已应用版本更旧或重复的快照，避免旧快照临时覆盖正确内容。
        if (!shouldApplyMessageVersion(payload.message.id, payload.version)) return conversation;
        return {
          ...conversation,
          messages: conversation.messages.map((message) =>
            message.id === payload.message?.id && payload.message
              ? mergeMessagePreservingCliProcess(message, payload.message)
              : message,
          ),
        };
      }
      case "message.deleted":
        if (payload.messageId) forgetMessageRuntimeState(payload.messageId);
        return {
          ...conversation,
          messages: conversation.messages.filter((message) => message.id !== payload.messageId),
        };
      case "message.read":
        return {
          ...conversation,
          messages: conversation.messages.map((message) =>
            message.id === payload.messageId ? { ...message, unread: false } : message,
          ),
        };
      default:
        return conversation;
    }
  });
}

export const useConversationStore = create<ConversationStore>()(
  (set, get) => ({
      conversations: [],
      conversationsHydrated: false,
      setConversationsHydrated: (hydrated) => set({ conversationsHydrated: hydrated }),
      hydrateConversations: (conversations) => {
        const localConversations = get().conversations;
        const localById = new Map(localConversations.map((conversation) => [conversation.id, conversation]));
        const sanitized = sanitizeConversationHistory(mergeConversationsById(conversations));
        const remoteIds = new Set(sanitized.map((conversation) => conversation.id));
        const mergedRemote = sanitized.map((conversation) =>
          mergeConversationPreservingCliProcess(localById.get(conversation.id), conversation),
        );
        const localOptimistic = localConversations.filter(
          (conversation) => isLocalOptimisticConversation(conversation) && !remoteIds.has(conversation.id),
        );
        set({ conversations: mergeConversationsById(mergedRemote, localOptimistic) });
      },
      applyConversationEvent: (event) => {
        set({ conversations: applyConversationEventToList(get().conversations, event) });
      },
      setConversationBackgroundIssue: (conversationId, issue) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, backgroundIssue: issue } : item,
          ),
        });
      },
      createConversation: (title) => {
        const now = new Date().toISOString();
        const next: Conversation = {
          id: `conv-new-${Date.now()}`,
          title: title || "新会话",
          messages: [],
          updatedAt: now,
          status: "idle",
        };
        set({ conversations: [next, ...get().conversations] });
        sendConversationCommand(createConversationCommand(next), (error) => {
          get().setConversationBackgroundIssue(next.id, {
            kind: "persistence",
            message: getErrorMessage(error, "会话保存失败，请稍后重试。"),
            occurredAt: new Date().toISOString(),
            retryable: true,
          });
        });
        return next;
      },
      appendMessage: (conversationId, message) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  messages: [...item.messages, message],
                  updatedAt: message.createdAt,
                }
              : item,
          ),
        });
        sendConversationCommand(appendConversationMessageCommand(conversationId, message));
      },
      updateMessage: (conversationId, messageId, updater) => {
        const currentMessage = get()
          .conversations.find((item) => item.id === conversationId)
          ?.messages.find((message) => message.id === messageId);
        const nextMessage = currentMessage ? updater(currentMessage) : null;
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  messages: item.messages.map((message) =>
                    message.id === messageId ? updater(message) : message,
                  ),
                }
              : item,
          ),
        });
        if (nextMessage) {
          // 维护本端本地实时流式标记：进入 streaming 时登记（本地内容领先回灌快照），
          // 进入终态时清除（之后由服务端权威终态快照收敛）。
          if (nextMessage.status === "streaming") {
            locallyStreamingMessageIds.add(messageId);
          } else {
            locallyStreamingMessageIds.delete(messageId);
          }
          sendConversationMessageUpdateCommand(conversationId, messageId, nextMessage);
        }
      },
      markConversationRead: (conversationId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  messages: item.messages.map((msg) => ({ ...msg, unread: false })),
                }
              : item,
          ),
        });
        sendConversationCommand(markConversationReadCommand(conversationId));
      },
      markConversationUnread: (conversationId) => {
        set({
          conversations: get().conversations.map((item) => {
            if (item.id !== conversationId || item.messages.length === 0) return item;
            const lastIndex = item.messages.length - 1;
            return {
              ...item,
              messages: item.messages.map((msg, index) =>
                index === lastIndex ? { ...msg, unread: true } : msg,
              ),
            };
          }),
        });
        sendConversationCommand(markConversationUnreadCommand(conversationId));
      },
      markMessageRead: (conversationId, messageId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  messages: item.messages.map((msg) =>
                    msg.id === messageId ? { ...msg, unread: false } : msg,
                  ),
                }
              : item,
          ),
        });
        sendConversationCommand(markConversationMessageReadCommand(conversationId, messageId));
      },
      deleteMessage: (conversationId, messageId) => {
        forgetMessageRuntimeState(messageId);
        set({
          conversations: get().conversations.map((item) => {
            if (item.id !== conversationId) return item;
            const nextMessages = item.messages.filter((msg) => msg.id !== messageId);
            const latest = nextMessages[nextMessages.length - 1];
            return {
              ...item,
              messages: nextMessages,
              updatedAt: latest?.createdAt ?? item.updatedAt,
            };
          }),
        });
        sendConversationCommand(deleteConversationMessageCommand(conversationId, messageId));
      },
      deleteConversation: async (conversationId) => {
        await deleteConversationCommand(conversationId);
        const removed = get().conversations.find((item) => item.id === conversationId);
        removed?.messages.forEach((message) => forgetMessageRuntimeState(message.id));
        set({
          conversations: get().conversations.filter((item) => item.id !== conversationId),
        });
      },
      toggleConversationPinned: (conversationId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, pinned: !item.pinned } : item,
          ),
        });
        sendConversationCommand(toggleConversationPinnedCommand(conversationId));
      },
      setGoalForConversation: (conversationId, goalId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, goalId } : item,
          ),
        });
        sendConversationCommand(setConversationGoalCommand(conversationId, goalId));
      },
      setGoalInfoCollection: (conversationId, collection) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? { ...item, goalInfoCollection: collection ?? undefined }
              : item,
          ),
        });
        sendConversationCommand(setGoalInfoCollectionCommand(conversationId, collection));
      },
      setPlanningRunState: (conversationId, state) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, planningRunState: state ?? undefined } : item,
          ),
        });
        sendConversationCommand(setPlanningRunStateCommand(conversationId, state));
      },
      renameConversation: (conversationId, title) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, title } : item,
          ),
        });
        sendConversationCommand(renameConversationCommand(conversationId, title));
      },
      setConversationWorkspace: (conversationId, workspacePath) => {
        const now = new Date().toISOString();
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  workspacePath,
                  workspaceInitializedAt: item.workspaceInitializedAt || now,
                }
              : item,
          ),
        });
        sendConversationCommand(setConversationWorkspaceCommand(conversationId, workspacePath));
      },
      setConversationRuntimeEnv: (conversationId, runtimeEnvId) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, runtimeEnvId } : item,
          ),
        });
        sendConversationCommand(setConversationRuntimeEnvCommand(conversationId, runtimeEnvId));
      },
      setConversationStatus: (conversationId, status) => {
        set({
          conversations: get().conversations.map((item) =>
            item.id === conversationId ? { ...item, status } : item,
          ),
        });
        sendConversationCommand(setConversationStatusCommand(conversationId, status));
      },
    }),
);

export function getConversationUnreadCount(conversation: Conversation) {
  return conversation.messages.filter((msg) => msg.unread).length;
}
