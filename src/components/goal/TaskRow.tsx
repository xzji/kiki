"use client";

import { Circle, CircleDot, Dot, Pencil } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import type { Task } from "@/types/dora";

export function TaskRow({ task, unreadCount, onOpen, onEdit }: { task: Task; unreadCount: number; onOpen: () => void; onEdit: () => void }) {
  const [hovered, setHovered] = useState(false);
  const latestStatus = useMemo(() => task.instances[0]?.status ?? "pending", [task.instances]);
  const Icon = latestStatus === "completed" ? CircleDot : latestStatus === "in_progress" ? Dot : Circle;

  return (
    <button
      type="button"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onOpen}
      className="flex w-full items-start gap-3 rounded-xl px-2 py-3 text-left transition hover:bg-white/60"
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", latestStatus === "completed" ? "fill-[#111] text-[#111]" : "text-[#9AA4B2]")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[#111]">{task.title}</span>
            {unreadCount > 0 ? <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[#E5484D]" /> : null}
          </div>
          {hovered ? (
            <span
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
              className="inline-flex items-center gap-1 rounded-md border border-[#D0D7DE] px-2 py-1 text-xs text-[#6B7280] hover:bg-white"
            >
              <Pencil className="h-3 w-3" />编辑
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs leading-5 text-[#6B7280]">{task.description}</p>
      </div>
    </button>
  );
}
