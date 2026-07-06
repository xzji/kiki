"use client";

import { Activity, ChevronDown, Clock } from "lucide-react";
import { useMemo, useState } from "react";

import { InboxEmptyState } from "@/components/inbox/InboxEmptyState";
import { InboxList } from "@/components/inbox/InboxList";
import { formatChineseDate } from "@/lib/date";
import { selectTaskMonitorRows } from "@/lib/taskMonitor";
import { cn } from "@/lib/utils";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useTaskMonitorStore } from "@/stores/taskMonitorStore";
import { useTriggerStore } from "@/stores/triggerStore";

export default function HomePage() {
  const items = useInboxStore((state) => state.items);
  const snoozedItems = useInboxStore((state) => state.snoozedItems);
  const currentTime = useTriggerStore((state) => state.currentTime);
  const goals = useGoalStore(selectVisibleGoals);
  const openTaskMonitor = useTaskMonitorStore((state) => state.openMonitor);
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);
  const orderedItems = useMemo(() => [...items].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)), [items]);
  const orderedSnoozed = useMemo(
    () => [...snoozedItems].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
    [snoozedItems],
  );
  const runningCount = useMemo(
    () => selectTaskMonitorRows(goals).filter((row) => row.group === "running").length,
    [goals],
  );

  return (
      <div>
        <div className="mb-5 flex flex-col gap-3 md:mb-6 md:flex-row md:items-center md:justify-between md:gap-4">
          <h1 className="text-[26px] font-semibold tracking-tight text-[#111] md:text-[32px]">{formatChineseDate(currentTime)}</h1>
        <button
          type="button"
          onClick={openTaskMonitor}
            className="inline-flex w-fit items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-[13px] font-medium text-ink transition hover:border-[#111]"
        >
          <Activity className="h-4 w-4 text-ink-soft" />
            <span className="md:hidden">任务</span>
            <span className="hidden md:inline">任务执行情况</span>
          {runningCount > 0 ? (
            <span className="rounded-full bg-success-bg px-2 py-0.5 text-[12px] font-semibold text-success">
              {runningCount}
            </span>
          ) : null}
        </button>
      </div>
      {orderedItems.length > 0 ? <InboxList items={orderedItems} /> : <InboxEmptyState />}

      {orderedSnoozed.length > 0 ? (
        <div className="mt-8">
          <button
            type="button"
            onClick={() => setSnoozedExpanded((prev) => !prev)}
            className="flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left text-[13px] font-medium text-ink-soft transition hover:text-[#111]"
          >
            <Clock className="h-4 w-4" />
            <span>稍后处理</span>
            <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[12px] font-semibold text-ink-soft">
              {orderedSnoozed.length}
            </span>
            <ChevronDown
              className={cn(
                "ml-auto h-4 w-4 transition-transform",
                snoozedExpanded && "rotate-180",
              )}
            />
          </button>
          {snoozedExpanded ? (
            <div className="mt-3">
              <InboxList items={orderedSnoozed} variant="snoozed" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
