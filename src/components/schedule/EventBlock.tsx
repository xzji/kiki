"use client";

import { cn } from "@/lib/utils";
import type { AgentEvent } from "@/types/schedule";

import { DEFAULT_EVENT_COLOR, EVENT_COLORS } from "./colorTokens";
import { formatRangeLabel } from "./timeGrid";

type Props = {
  event: AgentEvent;
  onClick: (event: AgentEvent, anchor: DOMRect) => void;
  compact?: boolean;
  style?: React.CSSProperties;
};

export function EventBlock({ event, onClick, compact = false, style }: Props) {
  const palette = EVENT_COLORS[event.color ?? DEFAULT_EVENT_COLOR];
  const cancelled = event.status === "cancelled";
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  const timeLabel = event.isAllDay ? "全天" : formatRangeLabel(start, end);

  return (
    <button
      type="button"
      style={{
        ...style,
        backgroundColor: palette.bg,
        color: palette.fg,
        borderLeft: `3px solid ${palette.bar}`
      }}
      onClick={(e) => {
        e.stopPropagation();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onClick(event, rect);
      }}
      className={cn(
        "group pointer-events-auto absolute left-0 right-0 overflow-hidden rounded-md px-2 py-1 text-left text-[12px] leading-4 transition hover:brightness-[0.97]",
        cancelled && "border border-dashed opacity-60"
      )}
    >
      <div className={cn("truncate font-semibold", cancelled && "line-through")}>{event.title}</div>
      <div className="truncate text-[11px] opacity-80">{timeLabel}</div>
      {!compact && event.location ? (
        <div className="truncate text-[11px] opacity-70">{event.location}</div>
      ) : null}
    </button>
  );
}
