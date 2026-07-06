"use client";

import Link from "next/link";

import { useInboxStore } from "@/stores/inboxStore";

export default function InboxItemPage({ params }: { params: { itemId: string } }) {
  const item = useInboxStore((state) => state.items.find((entry) => entry.id === params.itemId));

  if (!item) {
    return <div className="rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">该收件箱卡片不存在或已被处理。</div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[#111]">{item.title}</h1>
      <p className="mt-4 text-sm leading-7 text-ink-soft">{item.snippet}</p>
      <div className="mt-6">
        <Link href={item.linkTo} className="rounded-lg bg-[#111] px-4 py-2 text-sm text-white hover:bg-[#333]">进入相关任务</Link>
      </div>
    </div>
  );
}
