"use client";

import { create } from "zustand";

import { streamClaudeChat } from "@/lib/api/claude";
import { commitGoalDraftToStores } from "@/lib/goalWorkflow";
import { generateTopicSagaPlan } from "@/lib/api/topics";
import { ensureConversationWorkspaceApi } from "@/lib/api/conversationWorkspace";
import { parseSlashCommand } from "@/lib/slashCommands";
import { useConversationStore } from "@/stores/conversationStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { ArtifactRef } from "@/types/artifact";
import type { Conversation, ConversationMessage } from "@/types/kiki";
import { SUPPORTED_RUNTIME_KINDS, type ClaudeStreamEvent, type RuntimeEnvironment } from "@/types/runtime";

type ToolPermissionRequestEvent = Extract<ClaudeStreamEvent, { type: "tool_permission_request" }>;

type SidebarSagaQaRound = {
  questions: string[];
  answer: string;
};

type SidebarSagaAwaitingState = {
  conversationId: string;
  topicText: string;
  questions: string[];
  history: SidebarSagaQaRound[];
};

export type AssistantMessage = {
  id: string;
  role: "user" | "kiki";
  content: string;
  artifactRefs?: ArtifactRef[];
  createdAt: string;
  status?: "streaming" | "done" | "error";
  action?: {
    type: "open_goal_conversation";
    goalId: string;
    conversationId: string;
  };
};

type AssistantState = {
  hydrated: boolean;
  isOpen: boolean;
  messages: AssistantMessage[];
  isSending: boolean;
  error: string | null;
  runtimeSnapshot: RuntimeEnvironment | null;
  permissionRequest: string | null;
  pendingToolPermissionRequest: ToolPermissionRequestEvent | null;
  abortController: AbortController | null;
  sagaAwaiting: SidebarSagaAwaitingState | null;
  hydrate: () => void;
  open: () => void;
  close: () => void;
  toggle: () => void;
  clearError: () => void;
  clearToolPermissionRequest: () => void;
  stop: () => void;
  send: (
    content: string,
    quotedMessage?: {
      roleLabel: string;
      content: string;
    } | null,
  ) => Promise<void>;
};

const STORAGE_KEY = "kiki.assistant.isOpen";
const ASSISTANT_SIDEBAR_CONVERSATION_ID = "assistant-sidebar";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function readPersistedOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "1";
  } catch {
    return false;
  }
}

function writePersistedOpen(open: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
}

function createTurnTimestamps() {
  const base = Date.now();
  return {
    userCreatedAt: new Date(base).toISOString(),
    assistantCreatedAt: new Date(base + 1).toISOString(),
  };
}

function toConversationMessage(message: AssistantMessage): ConversationMessage {
  return {
    id: message.id,
    kind: "text",
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status,
    source: message.role,
  };
}

function buildSidebarConversationSnapshot(messages: AssistantMessage[]): Conversation {
  const latest = messages[messages.length - 1];
  const now = new Date().toISOString();
  const latestCreatedAt = latest?.createdAt;
  return {
    id: ASSISTANT_SIDEBAR_CONVERSATION_ID,
    title: "KiKi 侧边栏助手",
    status: "streaming",
    messages: messages.map(toConversationMessage),
    createdAt: messages[0]?.createdAt ?? latestCreatedAt ?? now,
    lastMessageAt: latestCreatedAt,
    updatedAt: latestCreatedAt ?? now,
  };
}

function formatQuestionList(questions: string[]) {
  return questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
}

// Build a cumulative clarification transcript across ALL awaiting rounds. The
// sidebar Saga runs fresh each call (no server-side resume), so every prior
// round's Q&A must be replayed or earlier answers are lost.
function buildSagaClarificationContext(history: SidebarSagaQaRound[]) {
  if (history.length === 0) return undefined;
  return [
    "已收集的澄清问答（请结合这些信息继续规划，不要重复追问已回答的内容）：",
    ...history.map((round, roundIndex) =>
      [
        `第 ${roundIndex + 1} 轮：`,
        ...round.questions.map((question, index) => `问${index + 1}：${question}`),
        `答：${round.answer}`,
      ].join("\n"),
    ),
  ].join("\n\n");
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  hydrated: false,
  isOpen: false,
  messages: [],
  isSending: false,
  error: null,
  runtimeSnapshot: null,
  permissionRequest: null,
  pendingToolPermissionRequest: null,
  abortController: null,
  sagaAwaiting: null,
  hydrate: () => {
    if (get().hydrated) return;
    set({ hydrated: true, isOpen: readPersistedOpen() });
  },
  open: () => {
    set({ isOpen: true });
    writePersistedOpen(true);
  },
  close: () => {
    set({ isOpen: false });
    writePersistedOpen(false);
  },
  toggle: () => {
    const next = !get().isOpen;
    set({ isOpen: next });
    writePersistedOpen(next);
  },
  clearError: () => {
    set({ error: null, permissionRequest: null, pendingToolPermissionRequest: null });
  },
  clearToolPermissionRequest: () => {
    set({ pendingToolPermissionRequest: null });
  },
  stop: () => {
    get().abortController?.abort();
    set({
      isSending: false,
      abortController: null,
      permissionRequest: null,
      pendingToolPermissionRequest: null,
      messages: get().messages.map((message) =>
        message.status === "streaming"
          ? {
              ...message,
              status: "done",
              content: message.content.trim() ? `${message.content}\n\n（已中断）` : "已中断",
            }
          : message,
      ),
    });
  },
  send: async (content, quotedMessage) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const parsedCommand = parseSlashCommand(trimmed);
    const pendingAwaiting = get().sagaAwaiting;

    // Shared Saga runner used by both the initial `/topic` command and the
    // multi-round awaiting-user follow-up. Persists a real conversation so the
    // generated plan lands in the same place the conversation view expects.
    const runSidebarSagaPlan = async (input: {
      assistantId: string;
      controller: AbortController;
      topicText: string;
      conversationId: string;
      // Full clarification history so far. When the Saga asks for more info, the
      // next round is appended and the whole transcript is replayed as context.
      history: SidebarSagaQaRound[];
    }) => {
      const runtimeEnv = useRuntimeEnvStore.getState().getActiveEnvironment();
      if (!runtimeEnv || runtimeEnv.type !== "local") {
        throw new Error("当前没有可用的本地 Runtime，请先到设置 -> 运行环境完成连接。");
      }
      if (!SUPPORTED_RUNTIME_KINDS.includes(runtimeEnv.runtimeKind || "claude")) {
        throw new Error("当前目标规划暂不支持这个 Runtime。请在运行环境中切换到 Claude CLI、Pi CLI、Cursor CLI 或 Codex CLI。");
      }
      await ensureConversationWorkspaceApi(input.conversationId).catch(() => undefined);
      const result = await generateTopicSagaPlan({
        topicText: input.topicText,
        runtimeEnv,
        conversationId: input.conversationId,
        conversationContext: buildSagaClarificationContext(input.history),
        signal: input.controller.signal,
      });

      if (result.kind === "awaiting_user") {
        const questions = result.questions ?? [];
        set({
          isSending: false,
          abortController: null,
          sagaAwaiting: {
            conversationId: input.conversationId,
            topicText: input.topicText,
            questions,
            history: input.history,
          },
          messages: get().messages.map((message) =>
            message.id === input.assistantId
              ? {
                  ...message,
                  status: "done",
                  content: questions.length
                    ? `5 角色 Saga 仍需要补充信息：\n\n${formatQuestionList(questions)}\n\n你可以继续在下一条消息里一次性回答这些问题。`
                    : "5 角色 Saga 需要更多信息才能继续，请补充后回复“继续”。",
                }
              : message,
          ),
        });
        return;
      }

      const committed = await commitGoalDraftToStores({
        conversationId: input.conversationId,
        draft: result.draft,
      });
      useConversationStore.getState().appendMessage(input.conversationId, {
        id: `msg-goal-plan-${Date.now()}`,
        kind: "goal_plan_card",
        role: "kiki",
        content: "目标规划草案已生成。点击下方卡片或右上角「目标规划」查看详情并确认启动。",
        createdAt: new Date().toISOString(),
        status: "done",
        source: "kiki",
        goalRef: {
          goalId: committed.goalId,
          title: committed.goalTitle,
          summary: committed.summary,
          subGoalCount: committed.subGoalCount,
          taskCount: committed.taskCount,
        },
      });
      set({
        isSending: false,
        abortController: null,
        sagaAwaiting: null,
        messages: get().messages.map((message) =>
          message.id === input.assistantId
            ? {
                ...message,
                status: "done",
                content: `已生成「${committed.goalTitle}」的目标规划草案：${committed.subGoalCount} 个子目标、${committed.taskCount} 个任务。请进入会话查看规划卡片并确认启动。`,
                action: {
                  type: "open_goal_conversation",
                  goalId: committed.goalId,
                  conversationId: input.conversationId,
                },
              }
            : message,
        ),
      });
    };

    // Multi-round follow-up: user is answering the Saga's awaiting questions.
    if (
      pendingAwaiting &&
      !(parsedCommand.kind === "command" && parsedCommand.command === "topic")
    ) {
      const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
      const assistantId = `k-${Date.now() + 1}`;
      const controller = new AbortController();
      const nextHistory: SidebarSagaQaRound[] = [
        ...pendingAwaiting.history,
        { questions: pendingAwaiting.questions, answer: trimmed },
      ];
      set({
        messages: [
          ...get().messages,
          { id: `u-${Date.now()}`, role: "user", content: trimmed, createdAt: userCreatedAt },
          {
            id: assistantId,
            role: "kiki",
            content: "已收到补充信息，正在继续 5 角色拆解...",
            createdAt: assistantCreatedAt,
            status: "streaming",
          },
        ],
        isSending: true,
        abortController: controller,
        error: null,
        permissionRequest: null,
        pendingToolPermissionRequest: null,
      });

      try {
        await runSidebarSagaPlan({
          assistantId,
          controller,
          topicText: pendingAwaiting.topicText,
          conversationId: pendingAwaiting.conversationId,
          history: nextHistory,
        });
      } catch (error) {
        if (isAbortError(error)) {
          set({ isSending: false, abortController: null });
          return;
        }
        set({
          isSending: false,
          abortController: null,
          error: error instanceof Error ? error.message : "目标规划生成失败",
          messages: get().messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  status: "error",
                  content: error instanceof Error ? error.message : "目标规划生成失败",
                }
              : message,
          ),
        });
      }
      return;
    }

    if (parsedCommand.kind === "unknown") {
      const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
      set({
        messages: [
          ...get().messages,
          { id: `u-${Date.now()}`, role: "user", content: trimmed, createdAt: userCreatedAt },
          {
            id: `k-${Date.now() + 1}`,
            role: "kiki",
            content: `暂不支持 ${parsedCommand.commandText} 命令。你可以先使用 /topic 发起规划。`,
            createdAt: assistantCreatedAt,
            status: "done",
          },
        ],
      });
      return;
    }

    if (parsedCommand.kind === "command" && parsedCommand.command === "topic") {
      const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
      const assistantId = `k-${Date.now() + 1}`;
      const controller = new AbortController();
      const conversation = useConversationStore
        .getState()
        .createConversation(parsedCommand.payload.slice(0, 24) || "新主题");
      set({
        messages: [
          ...get().messages,
          { id: `u-${Date.now()}`, role: "user", content: trimmed, createdAt: userCreatedAt },
          {
            id: assistantId,
            role: "kiki",
            content: "正在启动 5 角色拆解 Saga（Interviewer / Planner / Critic / Refiner / Presenter）...",
            createdAt: assistantCreatedAt,
            status: "streaming",
          },
        ],
        isSending: true,
        abortController: controller,
        error: null,
        permissionRequest: null,
        sagaAwaiting: null,
      });

      try {
        await runSidebarSagaPlan({
          assistantId,
          controller,
          topicText: parsedCommand.payload,
          conversationId: conversation.id,
          history: [],
        });
      } catch (error) {
        if (isAbortError(error)) {
          set({ isSending: false, abortController: null });
          return;
        }
        set({
          isSending: false,
          abortController: null,
          error: error instanceof Error ? error.message : "目标规划生成失败",
          messages: get().messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  status: "error",
                  content: error instanceof Error ? error.message : "目标规划生成失败",
                }
              : message,
          ),
        });
      }
      return;
    }

    const runtimeEnv = useRuntimeEnvStore.getState().getActiveEnvironment();
    if (!runtimeEnv || runtimeEnv.type !== "local") {
      set({ error: "当前没有可用的本地 Runtime，请先到设置 -> 运行环境完成连接。" });
      return;
    }

    if (!SUPPORTED_RUNTIME_KINDS.includes(runtimeEnv.runtimeKind || "claude")) {
      set({ error: "当前对话链路暂不支持这个 Runtime。请在运行环境中切换到 Claude CLI 或 Pi CLI。" });
      return;
    }

    if (runtimeEnv.health?.status !== "online") {
      set({ error: "当前本地 Runtime 离线，请先在设置里重新检测连接状态。" });
      return;
    }

    const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
    const userMsg: AssistantMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
      createdAt: userCreatedAt
    };
    const assistantId = `k-${Date.now() + 1}`;
    const controller = new AbortController();
    const contextMessages = [...get().messages, userMsg];
    const kikiMsg: AssistantMessage = {
      id: assistantId,
      role: "kiki",
      content: "",
      createdAt: assistantCreatedAt,
      status: "streaming",
    };
    set({
      messages: [...get().messages, userMsg, kikiMsg],
      isSending: true,
      abortController: controller,
      error: null,
      runtimeSnapshot: runtimeEnv,
      permissionRequest: null,
      pendingToolPermissionRequest: null,
    });

    const handleEvent = (event: ClaudeStreamEvent) => {
      if (event.type === "delta") {
        set({
          messages: get().messages.map((message) =>
            message.id === assistantId
              ? { ...message, content: `${message.content}${event.text}` }
              : message,
          ),
        });
        return;
      }

      if (event.type === "message") {
        set({
          messages: get().messages.map((message) =>
            message.id === assistantId
              ? { ...message, content: event.content, status: "done" }
              : message,
          ),
        });
        return;
      }

      if (event.type === "file_artifact") {
        set({
          messages: get().messages.map((message) =>
            message.id === assistantId
              ? { ...message, artifactRefs: [...(message.artifactRefs ?? []), event.ref] }
              : message,
          ),
        });
        return;
      }

      if (event.type === "permission_request") {
        set({ permissionRequest: event.reason });
        return;
      }
      if (event.type === "tool_permission_request") {
        set({ pendingToolPermissionRequest: event });
        return;
      }
      if (event.type === "tool_permission_resolved") {
        set({ pendingToolPermissionRequest: null });
        return;
      }
      if (event.type === "error") {
        set({
          error: event.message,
          isSending: false,
          messages: get().messages.map((message) =>
            message.id === assistantId ? { ...message, status: "error" } : message,
          ),
        });
        return;
      }

      if (event.type === "done") {
        set({
          isSending: false,
          messages: get().messages.map((message) =>
            message.id === assistantId && message.status === "streaming"
              ? { ...message, status: "done" }
              : message,
          ),
        });
      }
    };

    try {
      await streamClaudeChat(
        {
          message: trimmed,
          conversationId: ASSISTANT_SIDEBAR_CONVERSATION_ID,
          runtimeEnv,
          source: "assistant-sidebar",
          contextSnapshot: {
            conversation: buildSidebarConversationSnapshot(contextMessages),
            goal: null,
          },
          quotedMessage,
        },
        { onEvent: handleEvent },
        { signal: controller.signal },
      );
    } catch (error) {
      if (isAbortError(error)) {
        set({ isSending: false, abortController: null });
        return;
      }
      set({
        error: error instanceof Error ? error.message : "Claude 对话失败",
        isSending: false,
        abortController: null,
        messages: get().messages.map((message) =>
          message.id === assistantId ? { ...message, status: "error" } : message,
        ),
      });
    } finally {
      if (get().abortController === controller) {
        set({ abortController: null });
      }
    }
  }
}));
