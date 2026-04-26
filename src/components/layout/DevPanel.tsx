"use client";

import { formatClock, formatChineseDate } from "@/lib/date";
import { useVirtualClock } from "@/hooks/useVirtualClock";

export function DevPanel() {
  const { currentTime, advanceHours, jumpToTomorrowEleven } = useVirtualClock();

  return (
    <div className="fixed bottom-28 right-8 z-20 w-64 rounded-xl border border-[#E5E7EB] bg-white/95 p-4 shadow-sm backdrop-blur">
      <div className="mb-2 text-xs font-medium text-[#6B7280]">Dev 演示浮层</div>
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
