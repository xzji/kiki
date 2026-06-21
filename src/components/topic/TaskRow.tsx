"use client";

import { Check, Circle, CircleDot, Dot, Ellipsis } from "lucide-react";
import { useMemo, useState } from "react";

import { TaskEditDrawer } from "@/components/topic/TaskEditDrawer";
import { deleteGoalTaskCommand } from "@/lib/api/goal-commands";
import { createIdempotencyKey, createOpaqueId } from "@/lib/opaqueIds";
import { runTaskExecutionAction } from "@/lib/taskExecution";
import { deriveTaskDisplayState, stripTaskPrefix, type TaskDisplayState } from "@/lib/taskInstance";
import { cn } from "@/lib/utils";
import { useGoalStore } from "@/stores/goalStore";
import type { Task } from "@/types/kiki";

export function TaskRow({
  goalId,
  task,
  unreadCount,
  onOpen,
  isPendingCreate = false,
  isPendingUpdate = false,
}: {
  goalId: string;
  task: Task;
  unreadCount: number;
  onOpen: () => void;
  isPendingCreate?: boolean;
  isPendingUpdate?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const goalProjectionRevision = useGoalStore((state) => state.goalProjectionRevision);
  const addPendingTaskDelete = useGoalStore((state) => state.addPendingTaskDelete);
  const removePendingTaskDelete = useGoalStore((state) => state.removePendingTaskDelete);
  const taskState = useMemo(() => deriveTaskDisplayState(task), [task]);
  const Icon = taskState === "completed" ? CircleDot : taskState === "in_progress" || taskState === "awaiting_user" ? Dot : Circle;
  const statusLabel =
    taskState === "completed"
      ? "已结束"
      : taskState === "awaiting_user"
        ? awaitingStatusLabel(task)
        : taskState === "in_progress"
          ? "进行中"
          : taskState === "paused"
            ? "已暂停"
            : taskState === "error"
              ? "执行失败"
              : "待开始";
  const isPendingChange = isPendingCreate || isPendingUpdate;
  const executionAction = isPendingChange ? null : getExecutionAction(task, taskState);

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
      onClick={() => {
        if (!isPendingChange) onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!isPendingChange) onOpen();
        }
      }}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl px-2 py-3 text-left transition md:px-3",
        isPendingChange ? "cursor-default opacity-70" : "hover:bg-[#F8F9FB]",
      )}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border",
          taskState === "completed"
            ? "border-[#1F2328] bg-[#1F2328] text-white"
            : taskState === "awaiting_user"
              ? "border-[#D9A441] text-[#8A6D3B]"
            : taskState === "error"
              ? "border-[#B42318] text-[#B42318]"
            : taskState === "in_progress"
              ? "border-[#1F2328] text-[#1F2328]"
              : "border-[#D0D7DE] text-transparent"
        )}
      >
        {taskState === "completed" ? (
          <Check className="h-3 w-3" />
        ) : (
          <Icon
            className={cn(
              "h-3.5 w-3.5",
              taskState === "awaiting_user"
                ? "fill-[#D9A441] text-[#D9A441]"
                : taskState === "error"
                  ? "fill-[#B42318] text-[#B42318]"
                : taskState === "in_progress"
                  ? "fill-[#1F2328] text-[#1F2328]"
                  : "text-[#D0D7DE]",
            )}
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2 md:gap-3">
          <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("min-w-0 text-sm font-medium md:truncate", taskState === "completed" ? "text-[#9AA0A6] line-through" : "text-[#1F2328]")}>
                {stripTaskPrefix(task.title)}
              </span>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-medium",
                  taskState === "completed"
                    ? "bg-[#E5E7EB] text-[#6B7280]"
                    : taskState === "awaiting_user"
                      ? "bg-[#FFF3CD] text-[#8A6D3B]"
                    : taskState === "error"
                      ? "bg-[#FDECEC] text-[#B42318]"
                    : taskState === "in_progress"
                      ? "bg-[#DDE1E7] text-[#1F2328]"
                      : "bg-[#F5F6F8] text-[#8C9198]"
                )}
              >
                {isPendingChange ? "保存中" : statusLabel}
              </span>
              {unreadCount > 0 ? <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-[#E5484D]" /> : null}
            </div>
          </div>
            <span className="relative flex shrink-0 items-center justify-end gap-1 md:w-[96px]">
            {executionAction ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void runTaskExecutionAction(task.id, executionAction.action).catch((error) => {
                    window.alert(error instanceof Error ? error.message : "任务执行失败");
                  });
                }}
                className={cn(
                  "inline-flex shrink-0 items-center rounded-md border border-[#D0D7DE] bg-white px-2 py-1 text-xs text-[#6B7280] transition hover:border-[#111]",
                    hovered ? "opacity-100" : "opacity-100 md:pointer-events-none md:opacity-0",
                )}
              >
                {executionAction.label}
              </button>
            ) : null}
            {!isPendingChange ? (
            <button
              type="button"
              aria-label="更多任务操作"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((prev) => !prev);
              }}
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#D0D7DE] bg-white text-[#6B7280] transition hover:border-[#111] hover:text-[#1F2328]",
                  hovered || menuOpen ? "opacity-100" : "opacity-100 md:pointer-events-none md:opacity-0",
              )}
            >
              <Ellipsis className="h-4 w-4" />
            </button>
            ) : null}
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
                    const overlayId = createOpaqueId("idem");
                    const idempotencyKey = createIdempotencyKey("goal.delete_task", goalId, task.id, overlayId);
                    addPendingTaskDelete({
                      id: overlayId,
                      goalId,
                      taskId: task.id,
                      idempotencyKey,
                      createdAt: new Date().toISOString(),
                    });
                    setMenuOpen(false);
                    void deleteGoalTaskCommand({
                      goalId,
                      taskId: task.id,
                      baseRevision: goalProjectionRevision,
                      idempotencyKey,
                    })
                      .then((result) => {
                        applyGoalsProjection(result.goals, result.revision);
                        removePendingTaskDelete(overlayId);
                      })
                      .catch((error) => {
                        removePendingTaskDelete(overlayId);
                        window.alert(error instanceof Error ? error.message : "任务删除失败");
                      });
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
    <TaskEditDrawer goalId={goalId} task={task} open={editOpen} onClose={() => setEditOpen(false)} />
    </>
  );
}

function getExecutionAction(task: Task, taskState: TaskDisplayState) {
  if (taskState === "completed") return { label: "重新执行", action: "rerun" as const };
  if (taskState === "awaiting_user") return null;
  if (taskState === "error") return { label: "重试", action: "rerun" as const };
  if (taskState === "in_progress") return { label: "停止", action: "pause" as const };
  if (taskState === "paused") return { label: "继续执行", action: "resume" as const };

  const latest = [...task.instances].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).find((instance) => instance.status !== "completed");
  if (!latest) return { label: "执行", action: "start" as const };
  if (latest.status === "pending") return { label: "执行", action: "start" as const };
  return null;
}

function awaitingStatusLabel(task: Task) {
  const latest = task.instances[0];
  const type = latest?.awaitingUser?.interactionRequirement?.type ?? latest?.result?.interactionRequirement?.type;
  if (type === "answer") return "待作答";
  if (type === "provide_context") return "待补充";
  if (type === "perform_offline_action") return "待线下完成";
  return "待确认";
}
