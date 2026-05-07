"use client";

import type { AgentEvent } from "@/types/schedule";

import { DEFAULT_EVENT_COLOR, EVENT_COLORS, TIME_GUTTER_WIDTH } from "./colorTokens";
import { isEventOnDay } from "./timeGrid";

type Props = {
  days: Date[];
  events: AgentEvent[];
  onClickEvent: (event: AgentEvent, anchor: DOMRect) => void;
};

type PositionedAllDay = {
  event: AgentEvent;
  row: number;
  firstIndex: number;
  lastIndex: number;
};

const ROW_HEIGHT = 24;
const ROW_GAP = 4;
const VERTICAL_PADDING = 8;

export function AllDayBar({ days, events, onClickEvent }: Props) {
  const allDayEvents = events.filter((event) => event.isAllDay || spansMultipleDays(event));

  // 贪心分配每条事件所在的行，避免视觉重叠
  const positioned: PositionedAllDay[] = [];
  const rowsEndIndex: number[] = [];

  allDayEvents
    .slice()
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .forEach((event) => {
      const firstIndex = days.findIndex((day) => isEventOnDay(event.startTime, event.endTime, day));
      let lastIndex = -1;
      days.forEach((day, index) => {
        if (isEventOnDay(event.startTime, event.endTime, day)) {
          lastIndex = index;
        }
      });
      if (firstIndex === -1) return;
      let row = rowsEndIndex.findIndex((endIndex) => endIndex < firstIndex);
      if (row === -1) {
        row = rowsEndIndex.length;
        rowsEndIndex.push(lastIndex);
      } else {
        rowsEndIndex[row] = lastIndex;
      }
      positioned.push({ event, row, firstIndex, lastIndex });
    });

  const totalRows = Math.max(1, rowsEndIndex.length);
  const containerHeight = VERTICAL_PADDING * 2 + totalRows * ROW_HEIGHT + (totalRows - 1) * ROW_GAP;

  return (
    <div className="flex border-b border-[#E5E7EB] bg-white">
      <div
        style={{ width: TIME_GUTTER_WIDTH }}
        className="flex flex-none items-start justify-end border-r border-[#E5E7EB] px-2 py-2 text-[11px] text-[#6B7280]"
      >
        全天
      </div>
      <div className="relative flex-1" style={{ height: containerHeight }}>
        <div
          className="grid h-full"
          style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
        >
          {days.map((day, index) => {
            const weekday = day.getDay();
            const isWeekend = weekday === 0 || weekday === 6;
            return (
              <div
                key={day.toISOString()}
                className="border-l border-[#E5E7EB] first:border-l-0"
                style={{ backgroundColor: isWeekend ? "#F5F6F8" : undefined }}
                aria-hidden
                data-column-index={index}
              />
            );
          })}
        </div>
        <div className="absolute inset-0 px-1" style={{ paddingTop: VERTICAL_PADDING, paddingBottom: VERTICAL_PADDING }}>
          {positioned.map(({ event, row, firstIndex, lastIndex }) => {
            const start = new Date(event.startTime);
            const end = new Date(event.endTime);
            const widthPercent = ((lastIndex - firstIndex + 1) / days.length) * 100;
            const leftPercent = (firstIndex / days.length) * 100;
            const palette = EVENT_COLORS[event.color ?? DEFAULT_EVENT_COLOR];
            const cancelled = event.status === "cancelled";
            return (
              <button
                type="button"
                key={event.id}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  onClickEvent(event, rect);
                }}
                style={{
                  position: "absolute",
                  top: VERTICAL_PADDING + row * (ROW_HEIGHT + ROW_GAP),
                  height: ROW_HEIGHT,
                  width: `calc(${widthPercent}% - 4px)`,
                  left: `calc(${leftPercent}% + 2px)`,
                  backgroundColor: palette.bg,
                  color: palette.fg,
                  borderLeft: `3px solid ${palette.bar}`
                }}
                className={`truncate rounded-md px-2 text-left text-[12px] leading-[22px] ${cancelled ? "opacity-60 line-through" : ""}`}
              >
                <span className="font-semibold">{event.title}</span>
                <span className="ml-2 text-[11px] opacity-80">
                  {event.isAllDay ? "全天" : `${formatDate(start)} → ${formatDate(end)}`}
                </span>
              </button>
            );
          })}
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

function formatDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
