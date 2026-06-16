"use client";

import { create } from "zustand";

import { streamClaudeChat } from "@/lib/api/claude";
import { continueGoalWorkflowAfterInfo, startGoalInfoCollection } from "@/lib/goalWorkflow";
import { appendGoalProgressMessage } from "@/lib/goalProgressLog";
import { parseSlashCommand } from "@/lib/slashCommands";
import { useConversationStore } from "@/stores/conversationStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { ArtifactRef } from "@/types/artifact";
import type { Conversation, ConversationMessage, GoalInfoCollection } from "@/types/kiki";
import { SUPPORTED_RUNTIME_KINDS, type ClaudeStreamEvent, type RuntimeEnvironment } from "@/types/runtime";

type ToolPermissionRequestEvent = Extract<ClaudeStreamEvent, { type: "tool_permission_request" }>;

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
  goalInfoCollection: (GoalInfoCollection & { conversationId: string }) | null;
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
  goalInfoCollection: null,
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
    const pendingCollection = get().goalInfoCollection;
    if (
      pendingCollection &&
      !(parsedCommand.kind === "command" && parsedCommand.command === "goal")
    ) {
      const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
      const assistantId = `k-${Date.now() + 1}`;
      const controller = new AbortController();
      set({
        messages: [
          ...get().messages,
          { id: `u-${Date.now()}`, role: "user", content: trimmed, createdAt: userCreatedAt },
          {
            id: assistantId,
            role: "kiki",
            content: "已收到背景信息，正在生成目标规划...",
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
        const result = await continueGoalWorkflowAfterInfo({
          answer: trimmed,
          source: "assistant-sidebar",
          conversationId: pendingCollection.conversationId,
          signal: controller.signal,
          onProgress: (progress) => {
            set({
              messages: get().messages.map((message) =>
                message.id === assistantId
                  ? { ...message, content: appendGoalProgressMessage(message.content, progress.message) }
                  : message,
              ),
            });
          },
        });
        if (result.kind === "collecting_info") {
          const latestRound = result.collection.rounds[result.collection.rounds.length - 1];
          const questionText = latestRound.questions
            .map((question, index) => `${index + 1}. ${question}`)
            .join("\n");
          set({
            isSending: false,
            abortController: null,
            goalInfoCollection: {
              conversationId: result.conversationId,
              ...result.collection,
            },
            messages: get().messages.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    status: "done",
                    content: `${result.assistantMessage}\n\n${questionText}\n\n你可以继续在下一条消息里一次性回答这些问题。`,
                  }
                : message,
            ),
          });
          return;
        }
        useConversationStore.getState().appendMessage(result.conversationId, {
          id: `msg-goal-plan-${Date.now()}`,
          kind: "goal_plan_card",
          role: "kiki",
          content: "目标规划草案已生成。点击下方卡片或右上角「目标规划」查看详情并确认启动。",
          createdAt: new Date().toISOString(),
          status: "done",
          source: "kiki",
          goalRef: {
            goalId: result.goalId,
            title: result.goalTitle,
            summary: result.summary,
            subGoalCount: result.subGoalCount,
            taskCount: result.taskCount,
          },
        });
        set({
          isSending: false,
          abortController: null,
          goalInfoCollection: null,
          messages: get().messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  status: "done",
                  content: `已生成「${result.goalTitle}」的目标规划草案：${result.subGoalCount} 个子目标、${result.taskCount} 个任务。请进入会话查看规划卡片并确认启动。`,
                  action: {
                    type: "open_goal_conversation",
                    goalId: result.goalId,
                    conversationId: result.conversationId,
                  },
                }
              : message,
          ),
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
            content: `暂不支持 ${parsedCommand.commandText} 命令。你可以先使用 /goal 创建长程目标。`,
            createdAt: assistantCreatedAt,
            status: "done",
          },
        ],
      });
      return;
    }

    if (parsedCommand.kind === "command" && parsedCommand.command === "goal") {
      const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
      const assistantId = `k-${Date.now() + 1}`;
      const controller = new AbortController();
      set({
        messages: [
          ...get().messages,
          { id: `u-${Date.now()}`, role: "user", content: trimmed, createdAt: userCreatedAt },
          {
            id: assistantId,
            role: "kiki",
            content: "正在理解目标和关键约束...",
            createdAt: assistantCreatedAt,
            status: "streaming",
          },
        ],
        isSending: true,
        abortController: controller,
        error: null,
        permissionRequest: null,
      });

      try {
        const result = await startGoalInfoCollection({
          goalText: parsedCommand.payload,
          source: "assistant-sidebar",
          signal: controller.signal,
          onProgress: (progress) => {
            set({
              messages: get().messages.map((message) =>
                message.id === assistantId
                  ? { ...message, content: appendGoalProgressMessage(message.content, progress.message) }
                  : message,
              ),
            });
          },
        });
        const latestRound = result.collection.rounds[result.collection.rounds.length - 1];
        const questionText = latestRound.questions
          .map((question, index) => `${index + 1}. ${question}`)
          .join("\n");
        set({
          isSending: false,
          abortController: null,
          goalInfoCollection: {
            conversationId: result.conversationId,
            ...result.collection,
          },
          messages: get().messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  status: "done",
                  content: `${result.assistantMessage}\n\n${questionText}\n\n你可以直接在下一条消息里一次性回答这些问题。`,
                }
              : message,
          ),
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
