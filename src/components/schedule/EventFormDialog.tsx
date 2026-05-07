"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { makeId } from "@/lib/utils";
import type { AgentEvent, AgentEventColor } from "@/types/schedule";

import { EVENT_COLORS } from "./colorTokens";

type Props = {
  open: boolean;
  initial?: AgentEvent | null;
  defaultStart?: Date;
  defaultEnd?: Date;
  onClose: () => void;
  onSubmit: (event: AgentEvent) => void;
};

const COLORS: AgentEventColor[] = ["blue", "green", "purple", "pink", "orange", "cyan"];

function toInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const d = date.getDate().toString().padStart(2, "0");
  const h = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${mm}`;
}

function toDateInput(date: Date): string {
  return toInputValue(date).slice(0, 10);
}

export function EventFormDialog({ open, initial, defaultStart, defaultEnd, onClose, onSubmit }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isAllDay, setIsAllDay] = useState(false);
  const [startValue, setStartValue] = useState("");
  const [endValue, setEndValue] = useState("");
  const [attendees, setAttendees] = useState("");
  const [color, setColor] = useState<AgentEventColor>("blue");
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setTitle(initial.title);
      setDescription(initial.description ?? "");
      setIsAllDay(initial.isAllDay);
      const startDate = new Date(initial.startTime);
      const endDate = new Date(initial.endTime);
      setStartValue(initial.isAllDay ? toDateInput(startDate) : toInputValue(startDate));
      setEndValue(initial.isAllDay ? toDateInput(endDate) : toInputValue(endDate));
      setAttendees(initial.attendees.map((a) => a.name).join(", "));
      setColor(initial.color ?? "blue");
      setLocation(initial.location ?? "");
    } else {
      const start = defaultStart ?? new Date();
      const end = defaultEnd ?? new Date(start.getTime() + 30 * 60 * 1000);
      setTitle("");
      setDescription("");
      setIsAllDay(false);
      setStartValue(toInputValue(start));
      setEndValue(toInputValue(end));
      setAttendees("");
      setColor("blue");
      setLocation("");
    }
    setError(null);
  }, [open, initial, defaultStart, defaultEnd]);

  if (!open) return null;

  const handleSave = () => {
    if (!title.trim()) {
      setError("请填写主题");
      return;
    }
    if (!startValue || !endValue) {
      setError("请填写起止时间");
      return;
    }
    const start = new Date(isAllDay ? `${startValue}T00:00:00` : startValue);
    const end = new Date(isAllDay ? `${endValue}T23:59:59` : endValue);
    if (end.getTime() <= start.getTime()) {
      setError("结束时间必须晚于开始时间");
      return;
    }

    const attendeeList = attendees
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((name) => ({ id: makeId("att"), name }));

    const event: AgentEvent = {
      id: initial?.id ?? makeId("evt"),
      title: title.trim(),
      description: description.trim() || undefined,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      isAllDay,
      attendees: attendeeList,
      color,
      location: location.trim() || undefined,
      status: initial?.status ?? "normal",
      createdByAgent: initial?.createdByAgent ?? false,
      agentActions: initial?.agentActions
    };

    onSubmit(event);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="w-[440px] max-w-[90vw] rounded-xl border border-[#E5E7EB] bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#E5E7EB] px-5 py-3">
          <div className="text-sm font-semibold text-[#1F2328]">{initial ? "编辑日程" : "新建日程"}</div>
          <button onClick={onClose} className="rounded p-1 text-[#6B7280] hover:bg-[#F5F6F8]" aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm">
          <Field label="主题">
            <input
              className="w-full rounded-lg border border-[#E5E7EB] px-3 py-2 outline-none focus:border-[#111]"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入主题"
            />
          </Field>
          <Field label="内容">
            <textarea
              className="min-h-[72px] w-full resize-none rounded-lg border border-[#E5E7EB] px-3 py-2 outline-none focus:border-[#111]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="补充说明"
            />
          </Field>
          <label className="flex items-center gap-2 text-xs text-[#475467]">
            <input
              type="checkbox"
              checked={isAllDay}
              onChange={(e) => {
                setIsAllDay(e.target.checked);
                setStartValue((prev) => (e.target.checked ? prev.slice(0, 10) : prev.length > 10 ? prev : `${prev}T09:00`));
                setEndValue((prev) => (e.target.checked ? prev.slice(0, 10) : prev.length > 10 ? prev : `${prev}T10:00`));
              }}
            />
            全天
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="开始">
              <input
                type={isAllDay ? "date" : "datetime-local"}
                className="w-full rounded-lg border border-[#E5E7EB] px-3 py-2 outline-none focus:border-[#111]"
                value={startValue}
                onChange={(e) => setStartValue(e.target.value)}
              />
            </Field>
            <Field label="结束">
              <input
                type={isAllDay ? "date" : "datetime-local"}
                className="w-full rounded-lg border border-[#E5E7EB] px-3 py-2 outline-none focus:border-[#111]"
                value={endValue}
                onChange={(e) => setEndValue(e.target.value)}
              />
            </Field>
          </div>
          <Field label="参与人（逗号分隔）">
            <input
              className="w-full rounded-lg border border-[#E5E7EB] px-3 py-2 outline-none focus:border-[#111]"
              value={attendees}
              onChange={(e) => setAttendees(e.target.value)}
              placeholder="Josh, Sky"
            />
          </Field>
          <Field label="分类色">
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setColor(c)}
                  className={cn(
                    "h-7 w-7 rounded-full border",
                    color === c ? "border-[#1F2328]" : "border-transparent"
                  )}
                  style={{ backgroundColor: EVENT_COLORS[c].bg }}
                  aria-label={c}
                >
                  <span className="block h-full w-full rounded-full" style={{ border: `2px solid ${EVENT_COLORS[c].bar}` }} />
                </button>
              ))}
            </div>
          </Field>
          <Field label="地点">
            <input
              className="w-full rounded-lg border border-[#E5E7EB] px-3 py-2 outline-none focus:border-[#111]"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="线上 / 书房"
            />
          </Field>
          {error ? <div className="text-xs text-[#E5484D]">{error}</div> : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#E5E7EB] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#E5E7EB] px-3 py-1.5 text-sm text-[#1F2328] hover:bg-[#F5F6F8]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-lg bg-[#111] px-4 py-1.5 text-sm text-white hover:bg-[#333]"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-[#6B7280]">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}
