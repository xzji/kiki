"use client";

import { useInboxStore } from "@/stores/inboxStore";

export default function HistoryPage() {
  const historyItems = useInboxStore((state) => state.historyItems);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold text-[#111]">历史</h1>
      {historyItems.length === 0 ? <p className="text-sm text-ink-soft">还没有归档项目，完成订票或邮件处理后会出现在这里。</p> : null}
      <div className="space-y-3">
        {historyItems.map((item) => (
          <div key={item.id} className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-strong">{item.title}</div>
        ))}
      </div>
    </div>
  );
}
