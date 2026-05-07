"use client";

import { useState } from "react";

import type { Article } from "@/types/dora";

export function ReadingDigestView({ articles, onComplete }: { articles: Article[]; onComplete: () => void }) {
  const [activeId, setActiveId] = useState(articles[0]?.id);
  const active = articles.find((article) => article.id === activeId) ?? articles[0];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-[240px_1fr]">
        <div className="space-y-2">
          {articles.map((article) => (
            <button key={article.id} onClick={() => setActiveId(article.id)} className={`block w-full rounded-xl border p-3 text-left ${active.id === article.id ? "border-[#111] bg-white" : "border-[#E5E7EB] bg-[#F8FAFC]"}`}>
              <div className="text-sm font-medium text-[#111]">{article.title}</div>
              <div className="mt-1 text-xs text-[#6B7280]">{article.summary}</div>
            </button>
          ))}
        </div>
        <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-5">
          <div className="text-xs text-[#6B7280]">{active.source}</div>
          <div className="mt-1 text-lg font-semibold text-[#111]">{active.title}</div>
          <p className="mt-4 text-sm leading-7 text-[#374151]">{active.body}</p>
        </div>
      </div>
      <div className="flex justify-center"><button className="rounded-lg bg-[#111] px-5 py-2 text-sm text-white hover:bg-[#333]" onClick={onComplete}>标记已读</button></div>
    </div>
  );
}
