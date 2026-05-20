"use client";

import { useMemo } from "react";

import { InboxEmptyState } from "@/components/inbox/InboxEmptyState";
import { InboxList } from "@/components/inbox/InboxList";
import { formatChineseDate } from "@/lib/date";
import { useInboxStore } from "@/stores/inboxStore";
import { useTriggerStore } from "@/stores/triggerStore";

export default function HomePage() {
  const items = useInboxStore((state) => state.items);
  const currentTime = useTriggerStore((state) => state.currentTime);
  const orderedItems = useMemo(() => [...items].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)), [items]);

  return (
    <div>
      <h1 className="mb-6 text-[32px] font-semibold tracking-tight text-[#111]">{formatChineseDate(currentTime)}</h1>
      {orderedItems.length > 0 ? <InboxList items={orderedItems} /> : <InboxEmptyState />}
    </div>
  );
}
