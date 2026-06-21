"use client";

import { useMemo, useRef } from "react";

import type { AgentEvent } from "@/types/schedule";

import { AllDayBar } from "./AllDayBar";
import { CurrentTimeLine } from "./CurrentTimeLine";
import { EventBlock } from "./EventBlock";
import { GRID_MAX_HEIGHT, HOUR_HEIGHT, TIME_GUTTER_WIDTH } from "./colorTokens";
import {
  clampToDay,
  eachDayOfWeek,
  formatHourLabel,
  formatWeekdayShort,
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
const WEEKEND_BG = "#F5F6F8";

function isWeekend(day: Date): boolean {
  const w = day.getDay();
  return w === 0 || w === 6;
}

export function WeekView({ focusDate, today, events, onClickEvent, onCreateAt }: Props) {
  const days = useMemo(() => eachDayOfWeek(focusDate), [focusDate]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleCreateClick = (day: Date, offsetY: number) => {
    const startMinutes = Math.max(0, Math.round(offsetY / HOUR_HEIGHT * 60 / 15) * 15);
    const start = new Date(day);
    start.setHours(0, startMinutes, 0, 0);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + 30);
    onCreateAt(start, end);
  };

  return (
    <div className="flex flex-col overflow-x-auto">
      <div className="min-w-[980px] md:min-w-0">
      <div className="flex border-b border-[#E5E7EB]">
        <div
          className="flex-none border-r border-[#E5E7EB] px-2 py-2 text-[11px] text-[#6B7280]"
          style={{ width: TIME_GUTTER_WIDTH }}
        >
          GMT+8
        </div>
        <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((day) => {
            const isToday = isSameYmd(day, today);
            const weekend = isWeekend(day);
            return (
              <div
                key={day.toISOString()}
                className="flex flex-col items-center border-l border-[#E5E7EB] py-2 text-xs first:border-l-0"
                style={{ backgroundColor: weekend ? WEEKEND_BG : undefined }}
              >
                <span className="text-[11px] text-[#6B7280]">{formatWeekdayShort(day)}</span>
                <span className={`mt-1 text-sm font-semibold ${isToday ? "text-[#3370FF]" : "text-[#1F2328]"}`}>
                  {day.getDate()}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <AllDayBar days={days} events={events} onClickEvent={onClickEvent} />
      <div ref={scrollRef} className="relative overflow-y-auto" style={{ maxHeight: GRID_MAX_HEIGHT }}>
        <div className="flex">
          <div
            className="flex-none border-r border-[#E5E7EB]"
            style={{ width: TIME_GUTTER_WIDTH }}
          >
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
          <div className="relative flex-1">
            <div className="grid h-full" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
              {days.map((day) => (
                <DayColumn
                  key={day.toISOString()}
                  day={day}
                  events={events}
                  onClickEvent={onClickEvent}
                  onEmptyClick={(offsetY) => handleCreateClick(day, offsetY)}
                />
              ))}
            </div>
            {isWithinWeek(today, days) ? <CurrentTimeLine now={today} labelVariant="text" /> : null}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

function isWithinWeek(date: Date, days: Date[]): boolean {
  return days.some((day) => isSameYmd(day, date));
}

type DayColumnProps = {
  day: Date;
  events: AgentEvent[];
  onClickEvent: (event: AgentEvent, anchor: DOMRect) => void;
  onEmptyClick: (offsetY: number) => void;
};

function DayColumn({ day, events, onClickEvent, onEmptyClick }: DayColumnProps) {
  const dayEvents = events.filter(
    (event) => !event.isAllDay && !spansMultipleDays(event) && isEventOnDay(event.startTime, event.endTime, day)
  );
  const positioned = layoutEvents(dayEvents, day);
  const weekend = isWeekend(day);

  return (
    <div
      className="relative border-l border-[#E5E7EB] first:border-l-0"
      style={{ backgroundColor: weekend ? WEEKEND_BG : undefined }}
      onClick={(e) => {
        const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onEmptyClick(e.clientY - bounds.top);
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
      {positioned.map(({ event, top, height, leftPercent, widthPercent }) => (
        <EventBlock
          key={event.id}
          event={event}
          onClick={onClickEvent}
          compact={height < 48}
          style={{
            top,
            height: Math.max(22, height - 2),
            left: `calc(${leftPercent}% + 2px)`,
            width: `calc(${widthPercent}% - 4px)`
          }}
        />
      ))}
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

type Positioned = {
  event: AgentEvent;
  top: number;
  height: number;
  leftPercent: number;
  widthPercent: number;
};

function layoutEvents(events: AgentEvent[], day: Date): Positioned[] {
  const sorted = [...events].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const columns: AgentEvent[][] = [];
  const placement: Record<string, { col: number; colCount: number }> = {};

  sorted.forEach((event) => {
    const { startMin } = clampToDay(event.startTime, event.endTime, day);
    let placed = false;
    for (let i = 0; i < columns.length; i += 1) {
      const column = columns[i];
      const last = column[column.length - 1];
      const lastRange = clampToDay(last.startTime, last.endTime, day);
      if (lastRange.endMin <= startMin) {
        column.push(event);
        placement[event.id] = { col: i, colCount: 0 };
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push([event]);
      placement[event.id] = { col: columns.length - 1, colCount: 0 };
    }
  });

  const groups = groupOverlaps(sorted, day);
  groups.forEach((group) => {
    const groupCols = Math.max(...group.map((id) => placement[id].col + 1));
    group.forEach((id) => {
      placement[id].colCount = groupCols;
    });
  });

  return sorted.map((event) => {
    const { startMin, endMin } = clampToDay(event.startTime, event.endTime, day);
    const top = minutesToPx(startMin);
    const height = minutesToPx(Math.max(15, endMin - startMin));
    const { col, colCount } = placement[event.id];
    const widthPercent = 100 / Math.max(1, colCount);
    const leftPercent = widthPercent * col;
    return { event, top, height, leftPercent, widthPercent };
  });
}

function groupOverlaps(events: AgentEvent[], day: Date): string[][] {
  const groups: string[][] = [];
  let currentGroup: string[] = [];
  let currentEnd = -1;
  events.forEach((event) => {
    const { startMin, endMin } = clampToDay(event.startTime, event.endTime, day);
    if (startMin < currentEnd) {
      currentGroup.push(event.id);
      currentEnd = Math.max(currentEnd, endMin);
    } else {
      if (currentGroup.length) groups.push(currentGroup);
      currentGroup = [event.id];
      currentEnd = endMin;
    }
  });
  if (currentGroup.length) groups.push(currentGroup);
  return groups;
}
