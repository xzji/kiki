"use client";

import { useState } from "react";

import type { EmailDraft } from "@/types/dora";

export function DraftReviewView({ drafts, onComplete, onRewrite }: { drafts: EmailDraft[]; onComplete: () => void; onRewrite: () => void }) {
  const [items, setItems] = useState(drafts);
  const [index, setIndex] = useState(0);
  const current = items[index];

  const next = () => {
    if (index === items.length - 1) onComplete();
    else setIndex((prev) => prev + 1);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-5">
        <div className="mb-2 text-xs text-[#6B7280]">第 {index + 1} / {items.length} 封</div>
        <div className="text-sm font-medium text-[#111]">收件人：{current.recipient}</div>
        <div className="mt-1 text-sm text-[#374151]">主题：{current.subject}</div>
        <textarea value={current.body} onChange={(event) => setItems((prev) => prev.map((draft, draftIndex) => draftIndex === index ? { ...draft, body: event.target.value } : draft))} className="mt-4 h-48 w-full rounded-xl border border-[#E5E7EB] px-3 py-3 text-sm text-[#374151] outline-none" />
      </div>
      <div className="flex justify-center gap-3">
        <button className="rounded-lg bg-[#111] px-5 py-2 text-sm text-white hover:bg-[#333]" onClick={next}>发送</button>
        <button className="rounded-lg border border-[#D0D7DE] px-5 py-2 text-sm text-[#111] hover:bg-[#F5F6F8]" onClick={next}>跳过</button>
        <button className="rounded-lg border border-[#D0D7DE] px-5 py-2 text-sm text-[#111] hover:bg-[#F5F6F8]" onClick={onRewrite}>让 Kiki 重写</button>
      </div>
    </div>
  );
}
