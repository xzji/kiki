"use client";

import { Activity } from "lucide-react";
import { useMemo } from "react";

import { InboxEmptyState } from "@/components/inbox/InboxEmptyState";
import { InboxList } from "@/components/inbox/InboxList";
import { formatChineseDate } from "@/lib/date";
import { selectTaskMonitorRows } from "@/lib/taskMonitor";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useTaskMonitorStore } from "@/stores/taskMonitorStore";
import { useTriggerStore } from "@/stores/triggerStore";

export default function HomePage() {
  const items = useInboxStore((state) => state.items);
  const currentTime = useTriggerStore((state) => state.currentTime);
  const goals = useGoalStore(selectVisibleGoals);
  const openTaskMonitor = useTaskMonitorStore((state) => state.openMonitor);
  const orderedItems = useMemo(() => [...items].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)), [items]);
  const runningCount = useMemo(
    () => selectTaskMonitorRows(goals).filter((row) => row.group === "running").length,
    [goals],
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-[32px] font-semibold tracking-tight text-[#111]">{formatChineseDate(currentTime)}</h1>
        <button
          type="button"
          onClick={openTaskMonitor}
          className="inline-flex items-center gap-2 rounded-lg border border-[#E5E7EB] bg-white px-3 py-2 text-[13px] font-medium text-[#1F2328] transition hover:border-[#111]"
        >
          <Activity className="h-4 w-4 text-[#6B7280]" />
          <span>任务执行情况</span>
          {runningCount > 0 ? (
            <span className="rounded-full bg-[#E6F4EA] px-2 py-0.5 text-[12px] font-semibold text-[#137333]">
              {runningCount}
            </span>
          ) : null}
        </button>
      </div>
      {orderedItems.length > 0 ? <InboxList items={orderedItems} /> : <InboxEmptyState />}
    </div>
  );
}
