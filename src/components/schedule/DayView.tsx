"use client";

import { useMemo, useRef } from "react";

import type { AgentEvent } from "@/types/schedule";

import { AllDayBar } from "./AllDayBar";
import { CurrentTimeLine } from "./CurrentTimeLine";
import { EventBlock } from "./EventBlock";
import { GRID_MAX_HEIGHT, HOUR_HEIGHT, TIME_GUTTER_WIDTH } from "./colorTokens";
import {
  clampToDay,
  formatHourLabel,
  isEventOnDay,
  isSameYmd,
  minutesToPx
} from "./timeGrid";

type Props = {
  focusDate: Date;
  today: Date;
  events: AgentEvent[];
  onClickEvent: (event: AgentEvent, anchor: DOMRect) => void;
  onCreateAt: (start: Date, end: Date) => void;
};

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function DayView({ focusDate, today, events, onClickEvent, onCreateAt }: Props) {
  const days = useMemo(() => [focusDate], [focusDate]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const dayEvents = useMemo(
    () => events.filter((event) => !event.isAllDay && !spansMultipleDays(event) && isEventOnDay(event.startTime, event.endTime, focusDate)),
    [events, focusDate]
  );

  const focusEvents = useMemo(
    () => dayEvents.filter((event) => event.createdByAgent && event.agentActions?.some((action) => action.type === "primary")),
    [dayEvents]
  );

  const isToday = isSameYmd(focusDate, today);

  return (
    <div className="flex flex-col">
      <div className="flex border-b border-[#E5E7EB]">
        <div
          style={{ width: TIME_GUTTER_WIDTH }}
          className="flex flex-none items-center justify-start border-r border-[#E5E7EB] px-4 py-3 text-[11px] text-[#6B7280]"
        >
          GMT+8
        </div>
        <div className="flex flex-1 items-center justify-center gap-2 py-3 text-sm font-semibold text-[#1F2328]">
          <span>{`周${"日一二三四五六".charAt(focusDate.getDay())}`}</span>
          <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[11px] font-semibold ${isToday ? "bg-[#E5484D] text-white" : "bg-[#F5F6F8] text-[#1F2328]"}`}>
            {focusDate.getDate()}
          </span>
        </div>
      </div>
      <AllDayBar
        days={days}
        events={events}
        onClickEvent={onClickEvent}
      />
      <div ref={scrollRef} className="relative overflow-y-auto" style={{ maxHeight: GRID_MAX_HEIGHT }}>
        <div className="flex">
          <div className="flex-none border-r border-[#E5E7EB]" style={{ width: TIME_GUTTER_WIDTH }}>
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="flex items-start justify-end border-b border-[#E5E7EB] pr-2 pt-1 text-[11px] text-[#6B7280]"
                style={{ height: HOUR_HEIGHT }}
              >
                {formatHourLabel(hour)}
              </div>
            ))}
          </div>
          <div
            className="relative flex-1"
            onClick={(e) => {
              const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const offsetY = e.clientY - bounds.top;
              const startMinutes = Math.max(0, Math.round(offsetY / HOUR_HEIGHT * 60 / 15) * 15);
              const start = new Date(focusDate);
              start.setHours(0, startMinutes, 0, 0);
              const end = new Date(start);
              end.setMinutes(end.getMinutes() + 30);
              onCreateAt(start, end);
            }}
          >
            {HOURS.map((hour) => (
              <div key={hour} className="relative border-b border-[#E5E7EB]" style={{ height: HOUR_HEIGHT }}>
                <div
                  className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-[#EFF1F4]"
                  style={{ top: HOUR_HEIGHT / 2 }}
                />
              </div>
            ))}
            {focusEvents.map((event) => {
              const { startMin, endMin } = clampToDay(event.startTime, event.endTime, focusDate);
              return (
                <div
                  key={`highlight-${event.id}`}
                  className="pointer-events-none absolute left-0 right-0"
                  style={{
                    top: minutesToPx(startMin),
                    height: minutesToPx(endMin - startMin),
                    backgroundColor: "#FBF4D8"
                  }}
                />
              );
            })}
            {dayEvents.map((event) => {
              const { startMin, endMin } = clampToDay(event.startTime, event.endTime, focusDate);
              const top = minutesToPx(startMin);
              const height = minutesToPx(Math.max(15, endMin - startMin));
              return (
                <EventBlock
                  key={event.id}
                  event={event}
                  onClick={onClickEvent}
                  style={{
                    top,
                    height: Math.max(22, height - 2),
                    left: "8px",
                    width: "calc(100% - 16px)"
                  }}
                />
              );
            })}
            {isToday ? <CurrentTimeLine now={today} labelVariant="pill" /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function spansMultipleDays(event: AgentEvent): boolean {
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  return (
    start.getFullYear() !== end.getFullYear() ||
    start.getMonth() !== end.getMonth() ||
    start.getDate() !== end.getDate()
  );
}
