"use client";

import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ScheduleViewMode } from "@/types/schedule";

import { formatDayTitle, formatMonthTitle, formatWeekTitle, getWeekRange } from "./timeGrid";

type Props = {
  viewMode: ScheduleViewMode;
  focusDate: string;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onChangeMode: (mode: ScheduleViewMode) => void;
  onCreate: () => void;
};

export function ScheduleHeader({ viewMode, focusDate, onToday, onPrev, onNext, onChangeMode, onCreate }: Props) {
  const anchor = new Date(focusDate);
  const title = (() => {
    if (viewMode === "day") return formatDayTitle(anchor);
    if (viewMode === "week") {
      const [start, end] = getWeekRange(anchor);
      return formatWeekTitle(start, end);
    }
    return formatMonthTitle(anchor);
  })();

  return (
    <div className="flex flex-col gap-2 border-b border-[#E5E7EB] px-3 py-3 md:h-14 md:flex-row md:items-center md:justify-between md:px-4 md:py-0">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onToday}
          className="rounded-lg border border-[#E5E7EB] bg-[#F5F6F8] px-3 py-1.5 text-sm text-[#1F2328] hover:bg-[#EEF0F3]"
        >
          今天
        </button>
        <button
          type="button"
          onClick={onPrev}
          aria-label="上一个"
          className="rounded-md p-1.5 text-[#6B7280] hover:bg-[#F5F6F8]"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="下一个"
          className="rounded-md p-1.5 text-[#6B7280] hover:bg-[#F5F6F8]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <div className="min-w-0 text-sm font-semibold text-[#1F2328] md:ml-2">{title}</div>
      </div>
      <div className="flex items-center justify-between gap-2 md:justify-start">
        <div className="inline-flex rounded-lg border border-[#E5E7EB] p-0.5 text-xs text-[#475467]">
          {(["day", "week", "month"] as ScheduleViewMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChangeMode(mode)}
              className={cn(
                "rounded-md px-3 py-1.5 transition",
                viewMode === mode ? "bg-[#F5F6F8] font-semibold text-[#1F2328]" : "hover:bg-[#F5F6F8]"
              )}
            >
              {mode === "day" ? "日" : mode === "week" ? "周" : "月"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1 rounded-lg bg-[#111] px-3 py-1.5 text-xs text-white hover:bg-[#333]"
        >
          <Plus className="h-3.5 w-3.5" /> <span className="md:hidden">新建</span><span className="hidden md:inline">新建日程</span>
        </button>
      </div>
    </div>
  );
}
