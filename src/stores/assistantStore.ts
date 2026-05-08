"use client";

import { create } from "zustand";

import { streamClaudeChat } from "@/lib/api/claude";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { ClaudeStreamEvent, RuntimeEnvironment } from "@/types/runtime";

export type AssistantMessage = {
  id: string;
  role: "user" | "kiki";
  content: string;
  createdAt: string;
  status?: "streaming" | "done" | "error";
};

type AssistantState = {
  hydrated: boolean;
  isOpen: boolean;
  messages: AssistantMessage[];
  isSending: boolean;
  error: string | null;
  runtimeSnapshot: RuntimeEnvironment | null;
  permissionRequest: string | null;
  hydrate: () => void;
  open: () => void;
  close: () => void;
  toggle: () => void;
  clearError: () => void;
  send: (
    content: string,
    quotedMessage?: {
      roleLabel: string;
      content: string;
    } | null,
  ) => Promise<void>;
};

const STORAGE_KEY = "dora.assistant.isOpen";

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

export const useAssistantStore = create<AssistantState>((set, get) => ({
  hydrated: false,
  isOpen: false,
  messages: [],
  isSending: false,
  error: null,
  runtimeSnapshot: null,
  permissionRequest: null,
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
    set({ error: null, permissionRequest: null });
  },
  send: async (content, quotedMessage) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const runtimeEnv = useRuntimeEnvStore.getState().getActiveEnvironment();
    if (!runtimeEnv || runtimeEnv.type !== "local") {
      set({ error: "当前没有可用的本地 Claude 环境，请先到设置 -> 运行环境完成连接。" });
      return;
    }

    if ((runtimeEnv.runtimeKind || "claude") !== "claude") {
      set({ error: "当前对话链路暂只支持 Claude CLI。请在运行环境中切换到 Claude CLI，Codex/Gemini 后续可继续接入。" });
      return;
    }

    if (runtimeEnv.health?.status !== "online") {
      set({ error: "当前本地 Claude 环境离线，请先在设置里重新检测连接状态。" });
      return;
    }

    const now = new Date().toISOString();
    const userMsg: AssistantMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
      createdAt: now
    };
    const assistantId = `k-${Date.now() + 1}`;
    const kikiMsg: AssistantMessage = {
      id: assistantId,
      role: "kiki",
      content: "",
      createdAt: now,
      status: "streaming",
    };
    set({
      messages: [...get().messages, userMsg, kikiMsg],
      isSending: true,
      error: null,
      runtimeSnapshot: runtimeEnv,
      permissionRequest: null,
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

      if (event.type === "permission_request") {
        set({ permissionRequest: event.reason });
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
          runtimeEnv,
          source: "assistant-sidebar",
          quotedMessage,
        },
        { onEvent: handleEvent },
      );
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Claude 对话失败",
        isSending: false,
        messages: get().messages.map((message) =>
          message.id === assistantId ? { ...message, status: "error" } : message,
        ),
      });
    }
  }
}));
