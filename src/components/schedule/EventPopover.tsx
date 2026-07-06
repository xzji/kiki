"use client";

import { Pencil, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AgentEvent } from "@/types/schedule";

import { DEFAULT_EVENT_COLOR, EVENT_COLORS } from "./colorTokens";
import { formatDayTitle, formatRangeLabel } from "./timeGrid";

type Props = {
  event: AgentEvent;
  anchor: DOMRect | null;
  onClose: () => void;
  onEdit: (event: AgentEvent) => void;
  onDelete: (event: AgentEvent) => void;
};

const POPOVER_WIDTH = 340;
const POPOVER_HEIGHT = 300;

export function EventPopover({ event, anchor, onClose, onEdit, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; fallback: boolean }>({ top: 0, left: 0, fallback: true });

  useEffect(() => {
    setConfirming(false);
    if (!anchor || typeof window === "undefined") {
      setPosition({ top: 0, left: 0, fallback: true });
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.right + 8;
    let top = anchor.top;
    if (left + POPOVER_WIDTH > vw - 16) {
      left = Math.max(16, anchor.left - POPOVER_WIDTH - 8);
    }
    if (top + POPOVER_HEIGHT > vh - 16) {
      top = Math.max(16, vh - POPOVER_HEIGHT - 16);
    }
    const intersectsComposer = top + POPOVER_HEIGHT > vh - 160 && left > 260;
    const intersectsDevPanel = top + POPOVER_HEIGHT > vh - 260 && left + POPOVER_WIDTH > vw - 320;
    if (intersectsComposer || intersectsDevPanel) {
      setPosition({ top: 0, left: 0, fallback: true });
    } else {
      setPosition({ top, left, fallback: false });
    }
  }, [anchor]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // ESC first dismisses the inline delete confirmation, then the popover.
      if (confirming) {
        setConfirming(false);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [confirming, onClose]);

  const palette = EVENT_COLORS[event.color ?? DEFAULT_EVENT_COLOR];
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  const dateText = formatDayTitle(start);
  const timeText = event.isAllDay ? "全天" : formatRangeLabel(start, end);

  const style = useMemo(() => {
    if (position.fallback) {
      return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
    }
    return { top: position.top, left: position.left };
  }, [position]);

  const card = (
    <div
        role="dialog"
        aria-modal="true"
        aria-label={`日程详情：${event.title}`}
        className="fixed z-40 w-[calc(100vw-24px)] rounded-xl border border-line bg-white md:w-[340px]"
        style={style}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between px-4 pt-4">
        <div>
          <div className="text-xs text-ink-soft">{dateText}</div>
          <div className="mt-1 text-[22px] font-semibold text-ink">{timeText}</div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onEdit(event)} aria-label="编辑" className="rounded p-1 text-ink-soft hover:bg-surface">
            <Pencil className="h-4 w-4" />
          </button>
          <button onClick={() => setConfirming(true)} aria-label="删除" className="rounded p-1 text-ink-soft hover:bg-surface">
            <Trash2 className="h-4 w-4" />
          </button>
          <button onClick={onClose} aria-label="关闭" className="rounded p-1 text-ink-soft hover:bg-surface">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mt-3 px-4">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-2 rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ backgroundColor: palette.bg, color: palette.fg }}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: palette.bar }} />
            {event.color ?? DEFAULT_EVENT_COLOR}
          </span>
          {event.createdByAgent ? (
            <span className="rounded-full bg-brand-bg px-2 py-0.5 text-[11px] text-brand">Agent 创建</span>
          ) : null}
          {event.status === "cancelled" ? (
            <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[11px] text-danger-strong">已取消</span>
          ) : null}
        </div>
        <div className="mt-3 text-base font-semibold text-ink">{event.title}</div>
        {event.attendees.length > 0 ? (
          <div className="mt-3 flex items-center gap-2">
            <div className="flex -space-x-2">
              {event.attendees.slice(0, 4).map((attendee) => (
                <span
                  key={attendee.id}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white bg-brand-surface text-[11px] font-medium text-brand"
                  title={attendee.name}
                >
                  {attendee.name.slice(0, 2)}
                </span>
              ))}
            </div>
            <span className="text-xs text-ink-soft">{event.attendees.length} 位参与人</span>
          </div>
        ) : null}
        {event.location ? (
          <div className="mt-3 text-xs text-ink-strong">
            <span className="text-ink-soft">地点：</span>
            {event.location}
          </div>
        ) : null}
        {event.description ? (
          <p className="mt-3 text-xs leading-5 text-ink-strong">{event.description}</p>
        ) : null}
      </div>
      {event.agentActions && event.agentActions.length > 0 ? (
        <div className="mt-4 flex gap-2 border-t border-line px-4 py-3">
          {event.agentActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                onClose();
              }}
              className={
                action.type === "primary"
                  ? "flex-1 rounded-lg bg-[#111] px-3 py-2 text-xs text-white hover:bg-[#333]"
                  : "flex-1 rounded-lg border border-line px-3 py-2 text-xs text-ink hover:bg-surface"
              }
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-4 flex gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={() => onEdit(event)}
            className="flex-1 rounded-lg bg-[#111] px-3 py-2 text-xs text-white hover:bg-[#333]"
          >
            编辑日程
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-line px-3 py-2 text-xs text-ink hover:bg-surface"
          >
            关闭
          </button>
        </div>
      )}
      {confirming ? (
        <div className="border-t border-line bg-danger-bg px-4 py-3">
          <div className="mb-2 text-xs text-danger-strong">确认删除这条日程？该操作不可撤销。</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onDelete(event)}
              className="flex-1 rounded-lg bg-badge px-3 py-2 text-xs text-white"
            >
              确认删除
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="flex-1 rounded-lg border border-line bg-white px-3 py-2 text-xs text-ink"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="fixed inset-0 z-30" onClick={onClose}>
      {card}
    </div>
  );
}
