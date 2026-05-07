"use client";

import { MessageCircle } from "lucide-react";

import { DoraAvatar } from "@/components/layout/DoraAvatar";
import type { Goal } from "@/types/dora";

export function ChatHistoryView({ goal }: { goal: Goal }) {
  const turns = goal.chatTurns ?? [];

  return (
    <div className="mx-auto max-w-[760px] pb-12">
      <div className="mb-6 text-xs text-[#8C9198]">
        历史 <span className="mx-1">/</span>{" "}
        <span className="font-medium text-[#1F2328]">{goal.title}</span>
      </div>

      <section className="mb-8 border-b border-[#E5E7EB] pb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F5F6F8] text-[#6B7280]">
            <MessageCircle className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[22px] font-semibold tracking-[-0.01em] text-[#1F2328]">
              {goal.title}
            </h1>
            <div className="mt-1 text-[12px] text-[#8C9198]">
              {formatDateTime(goal.createdAt)} · 共 {turns.length} 条消息
            </div>
          </div>
        </div>
        {goal.summary ? (
          <p className="mt-4 text-[13px] leading-6 text-[#6B7280]">{goal.summary}</p>
        ) : null}
      </section>

      <div className="space-y-6">
        {turns.map((turn) => (
          <div
            key={turn.id}
            className={`flex items-start gap-3 ${turn.role === "user" ? "flex-row-reverse" : ""}`}
          >
            {turn.role === "agent" ? (
              <DoraAvatar size="sm" />
            ) : (
              <div className="flex h-7 w-7 items-center justify-center rounded-full border border-[#E5E7EB] bg-white text-xs text-[#6B7280]">
                J
              </div>
            )}
            <div
              className={`min-w-0 flex-1 ${turn.role === "user" ? "flex flex-col items-end" : ""}`}
            >
              <div
                className={`mb-1 flex items-center gap-2 text-[11px] text-[#8C9198] ${
                  turn.role === "user" ? "flex-row-reverse" : ""
                }`}
              >
                <span className="font-medium text-[#1F2328]">
                  {turn.role === "agent" ? "Kiki" : "我"}
                </span>
                <span>{formatTime(turn.timestamp)}</span>
              </div>
              <div
                className={`max-w-[560px] whitespace-pre-wrap rounded-[14px] px-4 py-3 text-[14px] leading-7 ${
                  turn.role === "agent"
                    ? "border border-[#E5E7EB] bg-[#F8F9FB] text-[#1F2328]"
                    : "bg-[#1F2328] text-white"
                }`}
              >
                {turn.content}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-10 rounded-[14px] border border-dashed border-[#D4D7DD] bg-transparent px-4 py-4 text-center text-[12px] text-[#8C9198]">
        对话已结束 · 如需继续，可在右下角 Kiki 中重新发起
      </div>
    </div>
  );
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}
