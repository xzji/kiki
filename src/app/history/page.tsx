"use client";

import { useInboxStore } from "@/stores/inboxStore";

export default function HistoryPage() {
  const historyItems = useInboxStore((state) => state.historyItems);

  return (
    <div className="rounded-2xl border border-[#D8DDE4] bg-white p-6">
      <h1 className="mb-4 text-2xl font-semibold text-[#111]">历史</h1>
      {historyItems.length === 0 ? <p className="text-sm text-[#6B7280]">还没有归档项目，完成订票或邮件处理后会出现在这里。</p> : null}
      <div className="space-y-3">
        {historyItems.map((item) => (
          <div key={item.id} className="rounded-xl border border-[#E5E7EB] px-4 py-3 text-sm text-[#374151]">{item.title}</div>
        ))}
      </div>
    </div>
  );
}
