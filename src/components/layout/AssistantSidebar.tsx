"use client";

import { PanelRightClose, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";

import { openSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useAssistantStore } from "@/stores/assistantStore";

import { AssistantComposer } from "./AssistantComposer";

export function AssistantSidebar() {
  const {
    isOpen,
    close,
    hydrated,
    messages,
    send,
    isSending,
    error,
    runtimeSnapshot,
    permissionRequest,
    clearError,
  } = useAssistantStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  // 自动滚到底部
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isOpen]);

  if (!hydrated || !isOpen) return null;

  return (
    <aside
      className="fixed inset-y-0 right-0 z-20 flex w-[400px] flex-col border-l border-[#E5E7EB] bg-white"
      aria-label="KiKi 助手"
    >
      <div className="flex h-12 flex-none items-center justify-between border-b border-[#E5E7EB] px-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#1F2328]">
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-[#E5E7EB] bg-[#F5F6F8]">
            <Sparkles className="h-3.5 w-3.5 text-[#5B3DBE]" />
          </span>
          <span>KiKi</span>
        </div>
        <button
          type="button"
          aria-label="收起 KiKi"
          onClick={close}
          className="rounded-md p-1.5 text-[#6B7280] hover:bg-[#F5F6F8]"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {error ? (
          <div className="mb-4 rounded-2xl border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-[12px] leading-5 text-[#B42318]">
            <div>{error}</div>
            <button
              type="button"
              onClick={() => {
                clearError();
                openSettings("runtime");
              }}
              className="mt-2 text-[12px] font-medium text-[#B42318] underline"
            >
              前往运行环境
            </button>
          </div>
        ) : null}

        {permissionRequest ? (
          <div className="mb-4 rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 text-[12px] leading-5 text-[#92400E]">
            {permissionRequest}
          </div>
        ) : null}

        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-[#E5E7EB] bg-[#F5F6F8]">
              <Sparkles className="h-5 w-5 text-[#5B3DBE]" />
            </div>
            <div className="text-sm font-semibold text-[#1F2328]">和 KiKi 聊聊</div>
            <div className="mt-2 max-w-[240px] text-[12px] leading-5 text-[#6B7280]">
              说出你的想法、目标或问题，KiKi 会在后台推进，并把关键节点同步到你的收件箱。
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[280px] rounded-2xl rounded-br-sm bg-[#111] px-3 py-2 text-sm text-white">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex justify-start">
                  <div className="mr-2 mt-1 flex h-6 w-6 flex-none items-center justify-center rounded-full border border-[#E5E7EB] bg-[#E9E6FF]">
                    <Sparkles className="h-3 w-3 text-[#5B3DBE]" />
                  </div>
                  <div
                    className={cn(
                      "max-w-[260px] rounded-2xl rounded-bl-sm border border-[#E5E7EB] bg-white px-3 py-2 text-sm text-[#1F2328]",
                      m.status === "streaming" && "after:ml-1 after:inline-block after:h-2 after:w-2 after:animate-pulse after:rounded-full after:bg-[#5B3DBE] after:align-middle after:content-['']",
                    )}
                  >
                    {m.content}
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>

      <div className="flex-none border-t border-[#E5E7EB] bg-[#F9FAFB] px-3 py-3">
        {runtimeSnapshot ? (
          <div className="mb-2 flex items-center justify-between rounded-xl border border-[#E5E7EB] bg-white px-3 py-2 text-[12px] text-[#6B7280]">
            <span>
              本地 Claude · {runtimeSnapshot.name}
            </span>
            <span>
              {runtimeSnapshot.permissionMode === "readonly"
                ? "只读聊天"
                : runtimeSnapshot.permissionMode === "confirm"
                  ? "手动确认"
                  : "项目内可执行"}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => openSettings("runtime")}
            className="mb-2 w-full rounded-xl border border-dashed border-[#D0D7DE] bg-white px-3 py-2 text-left text-[12px] text-[#6B7280] hover:border-[#111] hover:text-[#111]"
          >
            还没有连接本地 Claude CLI，点击前往运行环境设置
          </button>
        )}
        <AssistantComposer onSubmit={send} disabled={isSending} localMode />
      </div>
    </aside>
  );
}
