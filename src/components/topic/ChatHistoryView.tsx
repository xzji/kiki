"use client";

import { MessageCircle } from "lucide-react";

import { KikiAvatar } from "@/components/layout/KikiAvatar";
import type { Goal } from "@/types/kiki";

export function ChatHistoryView({ goal }: { goal: Goal }) {
  const turns = goal.chatTurns ?? [];

  return (
    <div className="mx-auto max-w-[760px] pb-12">
      <div className="mb-6 text-xs text-ink-faint">
        历史 <span className="mx-1">/</span>{" "}
        <span className="font-medium text-ink">{goal.title}</span>
      </div>

      <section className="mb-8 border-b border-line pb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-ink-soft">
            <MessageCircle className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[22px] font-semibold tracking-[-0.01em] text-ink">
              {goal.title}
            </h1>
            <div className="mt-1 text-[12px] text-ink-faint">
              {formatDateTime(goal.createdAt)} · 共 {turns.length} 条消息
            </div>
          </div>
        </div>
        {goal.summary ? (
          <p className="mt-4 text-[13px] leading-6 text-ink-soft">{goal.summary}</p>
        ) : null}
      </section>

      <div className="space-y-6">
        {turns.map((turn) => (
          <div
            key={turn.id}
            className={`flex items-start gap-3 ${turn.role === "user" ? "flex-row-reverse" : ""}`}
          >
            {turn.role === "agent" ? (
              <KikiAvatar size="sm" />
            ) : (
              <div className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-white text-xs text-ink-soft">
                J
              </div>
            )}
            <div
              className={`min-w-0 flex-1 ${turn.role === "user" ? "flex flex-col items-end" : ""}`}
            >
              <div
                className={`mb-1 flex items-center gap-2 text-[11px] text-ink-faint ${
                  turn.role === "user" ? "flex-row-reverse" : ""
                }`}
              >
                <span className="font-medium text-ink">
                  {turn.role === "agent" ? "KiKi" : "我"}
                </span>
                <span>{formatTime(turn.timestamp)}</span>
              </div>
              <div
                className={`max-w-[560px] whitespace-pre-wrap rounded-[14px] px-4 py-3 text-[14px] leading-7 ${
                  turn.role === "agent"
                    ? "border border-line bg-surface-hover text-ink"
                    : "bg-ink text-white"
                }`}
              >
                {turn.content}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-10 rounded-[14px] border border-dashed border-line bg-transparent px-4 py-4 text-center text-[12px] text-ink-faint">
        对话已结束 · 如需继续，可在右下角 KiKi 中重新发起
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
