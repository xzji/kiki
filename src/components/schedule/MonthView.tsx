"use client";

import { useMemo } from "react";

import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { cn } from "@/lib/utils";
import type { AgentEvent } from "@/types/schedule";

import { DEFAULT_EVENT_COLOR, EVENT_COLORS } from "./colorTokens";
import { eachDayOfMonthGrid, formatClockShort, formatMonthTitle, isEventOnDay, isSameYmd } from "./timeGrid";

type Props = {
  focusDate: Date;
  today: Date;
  events: AgentEvent[];
  onClickEvent: (event: AgentEvent, anchor: DOMRect) => void;
  onSelectDay: (day: Date) => void;
};

export function MonthView({ focusDate, today, events, onClickEvent, onSelectDay }: Props) {
  const days = useMemo(() => eachDayOfMonthGrid(focusDate), [focusDate]);
  const isMobile = useIsMobileViewport();

  return (
    <div className="flex flex-col">
        <div className="flex items-center justify-between px-3 py-3 md:px-4 md:py-4">
          <div className="text-[22px] font-semibold text-ink md:text-[28px]">{formatMonthTitle(focusDate)}</div>
      </div>
      <div className="grid grid-cols-7 border-t border-line text-[11px] text-ink-soft">
        {["日", "一", "二", "三", "四", "五", "六"].map((d) => (
          <div key={d} className="border-l border-line px-3 py-2 first:border-l-0">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day, index) => {
          const inMonth = day.getMonth() === focusDate.getMonth();
          const isToday = isSameYmd(day, today);
          const cellEvents = events.filter((event) => isEventOnDay(event.startTime, event.endTime, day));
            const visibleEvents = cellEvents.slice(0, isMobile ? 1 : 3);
          const overflow = cellEvents.length - visibleEvents.length;
          return (
            <button
              key={day.toISOString() + index}
              type="button"
              onClick={() => onSelectDay(day)}
              className={cn(
                "group flex flex-col items-stretch border-l border-t border-line px-2 py-2 text-left",
                "min-h-[72px] md:min-h-[calc((100vh-320px)/6)]",
                index % 7 === 0 && "border-l-0",
                !inMonth && "bg-surface"
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "text-xs",
                    !inMonth ? "text-ink-faint" : "text-ink",
                    isToday && "font-semibold text-info"
                  )}
                >
                  {day.getDate()}
                </span>
              </div>
              <div className="mt-1 flex flex-col gap-1">
                {visibleEvents.map((event) => {
                  const palette = EVENT_COLORS[event.color ?? DEFAULT_EVENT_COLOR];
                  const cancelled = event.status === "cancelled";
                  const start = new Date(event.startTime);
                  const label = event.isAllDay ? "全天" : formatClockShort(start);
                  return (
                    <span
                      key={event.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        onClickEvent(event, rect);
                      }}
                      className={cn(
                        "flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px]",
                        cancelled && "line-through opacity-60"
                      )}
                      style={{ color: palette.fg, backgroundColor: palette.bg }}
                    >
                      <span className="h-2.5 w-0.5 rounded" style={{ backgroundColor: palette.bar }} />
                      <span className="truncate">
                        <span className="mr-1 text-[10px] opacity-80">{label}</span>
                        {event.title}
                      </span>
                    </span>
                  );
                })}
                {overflow > 0 ? (
                  <span className="text-[11px] text-ink-soft">+{overflow} 更多</span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
