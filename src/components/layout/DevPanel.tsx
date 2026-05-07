"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

import { formatClock, formatChineseDate } from "@/lib/date";
import { useVirtualClock } from "@/hooks/useVirtualClock";

export function DevPanel() {
  const { currentTime, advanceHours, jumpToTomorrowEleven } = useVirtualClock();
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="fixed bottom-6 left-16 z-20 inline-flex items-center gap-1 rounded-full border border-[#E5E7EB] bg-white px-3 py-1.5 text-[11px] text-[#6B7280] hover:bg-[#F5F6F8]"
      >
        <span>Dev</span>
        <span className="text-[#1F2328]">{formatClock(currentTime)}</span>
        <ChevronUp className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 left-16 z-20 w-64 rounded-xl border border-[#E5E7EB] bg-white/95 p-4 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-[#6B7280]">Dev 演示浮层</div>
        <button
          type="button"
          aria-label="收起"
          onClick={() => setExpanded(false)}
          className="rounded p-1 text-[#6B7280] hover:bg-[#F5F6F8]"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="text-sm font-semibold text-[#1F2328]">{formatChineseDate(currentTime)}</div>
      <div className="mb-4 text-lg font-semibold text-[#111]">{formatClock(currentTime)}</div>
      <div className="flex gap-2">
        <button className="flex-1 rounded-lg bg-[#111] px-3 py-2 text-xs text-white hover:bg-[#333]" onClick={() => advanceHours(1)}>
          快进 1 小时
        </button>
        <button className="flex-1 rounded-lg border border-[#D0D7DE] px-3 py-2 text-xs text-[#111] hover:bg-[#F5F6F8]" onClick={jumpToTomorrowEleven}>
          跳到明早 11:00
        </button>
      </div>
    </div>
  );
}
