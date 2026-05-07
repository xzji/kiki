"use client";

import { Check, Circle, CircleDot, Dot, Pencil } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import type { Task } from "@/types/dora";

export function TaskRow({ task, unreadCount, onOpen, onEdit }: { task: Task; unreadCount: number; onOpen: () => void; onEdit: () => void }) {
  const [hovered, setHovered] = useState(false);
  const taskState = useMemo(() => getTaskDisplayState(task), [task]);
  const Icon = taskState === "completed" ? CircleDot : taskState === "in_progress" ? Dot : Circle;
  const statusLabel = taskState === "completed" ? "已完成" : taskState === "in_progress" ? "进行中" : "待开始";

  return (
    <button
      type="button"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onOpen}
      className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-[#F8F9FB]"
    >
      <span
        className={cn(
          "mt-0.5 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border",
          taskState === "completed"
            ? "border-[#1F2328] bg-[#1F2328] text-white"
            : taskState === "in_progress"
              ? "border-[#1F2328] text-[#1F2328]"
              : "border-[#D0D7DE] text-transparent"
        )}
      >
        {taskState === "completed" ? (
          <Check className="h-3 w-3" />
        ) : (
          <Icon className={cn("h-3.5 w-3.5", taskState === "in_progress" ? "fill-[#1F2328] text-[#1F2328]" : "text-[#D0D7DE]")} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn("truncate text-sm font-medium", taskState === "completed" ? "text-[#9AA0A6] line-through" : "text-[#1F2328]")}>
                {stripPrefix(task.title)}
              </span>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-medium",
                  taskState === "completed"
                    ? "bg-[#E5E7EB] text-[#6B7280]"
                    : taskState === "in_progress"
                      ? "bg-[#DDE1E7] text-[#1F2328]"
                      : "bg-[#F5F6F8] text-[#8C9198]"
                )}
              >
                {statusLabel}
              </span>
              {unreadCount > 0 ? <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-[#E5484D]" /> : null}
            </div>
          </div>
          {hovered ? (
            <span
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#D0D7DE] bg-white px-2 py-1 text-xs text-[#6B7280] hover:border-[#111]"
            >
              <Pencil className="h-3 w-3" />编辑
            </span>
          ) : null}
        </div>
        {task.description ? (
          <p className="mt-1.5 text-[13px] leading-5 text-[#6B7280]">{task.description}</p>
        ) : null}
      </div>
    </button>
  );
}

function getTaskDisplayState(task: Task) {
  const latestStatus = task.instances[0]?.status;
  if (latestStatus === "completed" || task.progress >= 100) return "completed" as const;
  if (latestStatus === "awaiting_user" || latestStatus === "in_progress") return "in_progress" as const;
  if (latestStatus === "pending") return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
  return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
}

function stripPrefix(value: string) {
  return value.replace(/^任务\d+：/, "");
}
