"use client";

import { Check, Circle, CircleDot, Dot, Ellipsis } from "lucide-react";
import { useMemo, useState } from "react";

import { TaskEditDrawer } from "@/components/goal/TaskEditDrawer";
import { cn } from "@/lib/utils";
import { useGoalStore } from "@/stores/goalStore";
import type { Task } from "@/types/kiki";

export function TaskRow({ task, unreadCount, onOpen }: { task: Task; unreadCount: number; onOpen: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const controlTaskExecution = useGoalStore((state) => state.controlTaskExecution);
  const deleteTask = useGoalStore((state) => state.deleteTask);
  const taskState = useMemo(() => getTaskDisplayState(task), [task]);
  const Icon = taskState === "completed" ? CircleDot : taskState === "in_progress" ? Dot : Circle;
  const statusLabel =
    taskState === "completed" ? "已完成" : taskState === "in_progress" ? "进行中" : taskState === "paused" ? "已暂停" : "待开始";
  const executionAction = getExecutionAction(task, taskState);

  return (
    <>
    <div
      role="button"
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setMenuOpen(false);
      }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
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
          <span className="relative flex w-[96px] shrink-0 items-center justify-end gap-1">
            {executionAction ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  controlTaskExecution(task.id, executionAction.action);
                }}
                className={cn(
                  "inline-flex shrink-0 items-center rounded-md border border-[#D0D7DE] bg-white px-2 py-1 text-xs text-[#6B7280] transition hover:border-[#111]",
                  hovered ? "opacity-100" : "pointer-events-none opacity-0",
                )}
              >
                {executionAction.label}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="更多任务操作"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((prev) => !prev);
              }}
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#D0D7DE] bg-white text-[#6B7280] transition hover:border-[#111] hover:text-[#1F2328]",
                hovered || menuOpen ? "opacity-100" : "pointer-events-none opacity-0",
              )}
            >
              <Ellipsis className="h-4 w-4" />
            </button>
            {menuOpen ? (
              <div
                onClick={(event) => event.stopPropagation()}
                className="absolute right-0 top-8 z-20 w-28 overflow-hidden rounded-lg border border-[#E5E7EB] bg-white py-1 text-[12px] text-[#1F2328]"
              >
                <button
                  type="button"
                  onClick={() => {
                    setEditOpen(true);
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left hover:bg-[#F8F9FB]"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => {
                    deleteTask(task.id);
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-[#D1242F] hover:bg-[#F8F9FB]"
                >
                  删除
                </button>
              </div>
            ) : null}
          </span>
        </div>
        {task.description ? (
          <p className="mt-1.5 text-[13px] leading-5 text-[#6B7280]">{task.description}</p>
        ) : null}
      </div>
    </div>
    <TaskEditDrawer task={task} open={editOpen} onClose={() => setEditOpen(false)} />
    </>
  );
}

function getTaskDisplayState(task: Task) {
  const latestStatus = task.instances[0]?.status;
  if (latestStatus === "completed" || task.progress >= 100) return "completed" as const;
  if (latestStatus === "paused") return "paused" as const;
  if (latestStatus === "awaiting_user" || latestStatus === "in_progress") return "in_progress" as const;
  if (latestStatus === "pending") return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
  return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
}

function getExecutionAction(task: Task, taskState: ReturnType<typeof getTaskDisplayState>) {
  if (taskState === "completed") return null;
  if (taskState === "in_progress") return { label: "停止", action: "pause" as const };
  if (taskState === "paused") return { label: "继续执行", action: "resume" as const };

  const latest = [...task.instances].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).find((instance) => instance.status !== "completed");
  if (!latest) return { label: "执行", action: "start" as const };
  if (latest.status === "pending") return { label: "执行", action: "start" as const };
  return null;
}

function stripPrefix(value: string) {
  return value.replace(/^任务\d+：/, "");
}
