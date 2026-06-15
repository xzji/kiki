"use client";

import {
  Activity,
  AlertCircle,
  ChevronRight,
  ChevronsRight,
  Pause,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  fetchRuntimeStateSnapshot,
  setRuntimeDaemonMaxConcurrentTasks,
} from "@/lib/api/runtime-daemon";
import { cancelGoalInstance } from "@/lib/api/goal-commands";
import {
  groupTaskMonitorRows,
  selectTaskMonitorRows,
  TASK_MONITOR_GROUP_LABEL,
  TASK_MONITOR_GROUP_ORDER,
  type TaskMonitorGroup,
  type TaskMonitorRow,
} from "@/lib/taskMonitor";
import { runTaskExecutionAction } from "@/lib/taskExecution";
import { cn } from "@/lib/utils";
import { useAssistantStore } from "@/stores/assistantStore";
import { useEasterEggSettingsStore } from "@/stores/easterEggSettingsStore";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useTaskMonitorStore } from "@/stores/taskMonitorStore";
import { useTaskDrawerStore } from "@/stores/taskDrawerStore";

const ASSISTANT_WIDTH = 400;
const DETAIL_MIN_WIDTH = 640;
const DETAIL_WIDTH_RATIO = 0.6;

const groupBadgeClass: Record<TaskMonitorGroup, string> = {
  queued: "bg-[#F5F6F8] text-[#6B7280]",
  running: "bg-[#E6F4EA] text-[#137333]",
  paused: "bg-[#FFF4CC] text-[#7A5A00]",
  done: "bg-[#EEF2FF] text-[#4F46E5]",
};

const statusDotClass: Record<TaskMonitorGroup, string> = {
  queued: "bg-[#9CA3AF]",
  running: "bg-[#1A7F37]",
  paused: "bg-[#9A6A24]",
  done: "bg-[#4F46E5]",
};

function rowBadgeClass(row: TaskMonitorRow) {
  if (row.group === "done" && row.result === "fail") return "bg-[#FDECEC] text-[#B42318]";
  return groupBadgeClass[row.group];
}

export function TaskMonitorDrawer() {
  const goals = useGoalStore(selectVisibleGoals);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const assistantOpen = useAssistantStore((state) => state.isOpen);
  const open = useTaskMonitorStore((state) => state.open);
  const width = useTaskMonitorStore((state) => state.width);
  const closeMonitor = useTaskMonitorStore((state) => state.closeMonitor);
  const setWidth = useTaskMonitorStore((state) => state.setWidth);
  const collapsedSections = useTaskMonitorStore((state) => state.collapsedSections);
  const toggleSection = useTaskMonitorStore((state) => state.toggleSection);
  const activeTaskId = useTaskDrawerStore((state) => state.activeTaskId);
  const activeInstanceId = useTaskDrawerStore((state) => state.activeInstanceId);
  const openTaskDrawer = useTaskDrawerStore((state) => state.open);
  const closeTaskDrawer = useTaskDrawerStore((state) => state.close);
  const maxConcurrentTasks = useEasterEggSettingsStore((state) => state.settings.maxConcurrentTasks);
  const updateNumericSetting = useEasterEggSettingsStore((state) => state.updateNumericSetting);

  const [detailWidth, setDetailWidth] = useState(DETAIL_MIN_WIDTH);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const wasOpenRef = useRef(false);

  const rows = useMemo(() => selectTaskMonitorRows(goals), [goals]);
  const groups = useMemo(() => groupTaskMonitorRows(rows), [rows]);
  const taskRunningCount = groups.running.filter((row) => row.kind === "task").length;
  const detailOpen = Boolean(activeTaskId);
  const assistantOffset = assistantOpen ? ASSISTANT_WIDTH : 0;
  const rightOffset = detailOpen ? detailWidth + assistantOffset : assistantOffset;
  const concurrencyRatio = maxConcurrentTasks > 0 ? Math.min(100, (taskRunningCount / maxConcurrentTasks) * 100) : 0;

  useEffect(() => {
    const update = () => {
      if (typeof window === "undefined") return;
      setDetailWidth(Math.max(window.innerWidth * DETAIL_WIDTH_RATIO, DETAIL_MIN_WIDTH));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      closeTaskDrawer();
    }
    wasOpenRef.current = open;
  }, [closeTaskDrawer, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (detailOpen) closeTaskDrawer();
      else closeMonitor();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeMonitor, closeTaskDrawer, detailOpen, open]);

  if (!open) return null;

  const syncGoals = async () => {
    try {
      const snapshot = await fetchRuntimeStateSnapshot();
      applyGoalsProjection(snapshot.goals, snapshot.meta?.revisions?.goals);
    } catch (error) {
      console.warn("同步任务执行快照失败", error);
    }
  };

  const runAction = async (row: TaskMonitorRow, action: "start" | "pause" | "resume" | "rerun" | "stop") => {
    if (row.kind !== "task" || !row.instanceId || !row.taskId) return;
    const instanceId = row.instanceId;
    const taskId = row.taskId;
    const actionKey = `${action}:${instanceId}`;
    setPendingAction(actionKey);
    setErrorMessage(null);
    try {
      if (action === "stop" || action === "pause") {
        await cancelGoalInstance({
          instanceId,
          reason: action === "pause" ? "用户暂停任务执行" : "用户停止任务执行",
        });
      } else {
        await runTaskExecutionAction(taskId, action, { instanceId });
      }
      await syncGoals();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "任务操作失败");
    } finally {
      setPendingAction((current) => (current === actionKey ? null : current));
    }
  };

  const changeConcurrency = async (nextValue: number) => {
    const clamped = Math.min(Math.max(nextValue, 1), 10);
    if (clamped === maxConcurrentTasks) return;
    // 先更新本地 store 让 UI 立即响应，再把权威值同步给服务端 daemon 配置。
    updateNumericSetting("maxConcurrentTasks", clamped);
    try {
      await setRuntimeDaemonMaxConcurrentTasks(clamped);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "并发上限设置失败");
    }
  };

  const onDragStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: MouseEvent) => {
      setWidth(startWidth + (startX - moveEvent.clientX));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <>
      <button
        type="button"
        aria-label={detailOpen ? "关闭任务详情" : "关闭任务执行情况"}
        onClick={() => {
          if (detailOpen) closeTaskDrawer();
          else closeMonitor();
        }}
        className="fixed inset-0 z-20 bg-transparent"
      />
      <aside
        aria-label="任务执行情况"
        className="fixed inset-y-0 z-30 flex flex-col border-l border-[#E5E7EB] bg-white shadow-[-2px_0_0_rgba(0,0,0,0.02)] transition-[right] duration-200"
        style={{ width, right: rightOffset }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          title="拖拽调整宽度"
          onMouseDown={onDragStart}
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-[#D0D7DE]"
        />
        <div className="flex h-12 flex-none items-center gap-3 border-b border-[#E5E7EB] px-4">
          <Activity className="h-4 w-4 text-[#6B7280]" />
          <h2 className="min-w-0 flex-1 text-[13px] font-semibold text-[#1F2328]">任务执行情况</h2>
          <button
            type="button"
            aria-label="收起任务执行情况"
            onClick={closeMonitor}
            className="rounded-md p-1.5 text-[#6B7280] hover:bg-[#F5F6F8]"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-[#E5E7EB] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-medium text-[#1F2328]">最多同时执行</div>
              <div className="mt-0.5 text-[12px] text-[#8C9198]">超出上限的任务进入等待队列</div>
            </div>
            <div className="inline-flex items-center overflow-hidden rounded-lg border border-[#D0D7DE] bg-white">
              <button
                type="button"
                disabled={maxConcurrentTasks <= 1}
                onClick={() => void changeConcurrency(maxConcurrentTasks - 1)}
                className="h-8 w-8 text-[16px] text-[#1F2328] hover:bg-[#F5F6F8] disabled:cursor-not-allowed disabled:text-[#D0D7DE]"
              >
                -
              </button>
              <span className="min-w-8 border-x border-[#D0D7DE] px-2 text-center text-[13px] font-semibold">
                {maxConcurrentTasks}
              </span>
              <button
                type="button"
                disabled={maxConcurrentTasks >= 10}
                onClick={() => void changeConcurrency(maxConcurrentTasks + 1)}
                className="h-8 w-8 text-[16px] text-[#1F2328] hover:bg-[#F5F6F8] disabled:cursor-not-allowed disabled:text-[#D0D7DE]"
              >
                +
              </button>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#EEF0F3]">
              <div
                className={cn("h-full rounded-full", taskRunningCount >= maxConcurrentTasks ? "bg-[#F2C94C]" : "bg-[#1A7F37]")}
                style={{ width: `${concurrencyRatio}%` }}
              />
            </div>
            <span className="shrink-0 text-[12px] text-[#6B7280]">
              {taskRunningCount} / {maxConcurrentTasks} 执行中
            </span>
          </div>
        </div>

        {errorMessage ? (
          <div className="mx-4 mt-4 flex items-start gap-2 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-[12px] leading-5 text-[#B42318]">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{errorMessage}</span>
            <button type="button" onClick={() => setErrorMessage(null)} className="shrink-0 text-[#6B7280]">
              关闭
            </button>
          </div>
        ) : null}

        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
          {TASK_MONITOR_GROUP_ORDER.map((group) => {
            const items = groups[group];
            if (items.length === 0) return null;
            const collapsed = Boolean(collapsedSections[group]);
            return (
              <section key={group}>
                <button
                  type="button"
                  onClick={() => toggleSection(group)}
                  className="mb-3 flex w-full items-center gap-2 text-left"
                >
                  <ChevronRight
                    className={cn("h-4 w-4 text-[#8C9198] transition-transform", !collapsed && "rotate-90")}
                  />
                  <span className="text-[13px] font-semibold text-[#6B7280]">{TASK_MONITOR_GROUP_LABEL[group]}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-semibold", groupBadgeClass[group])}>
                    {items.length}
                  </span>
                </button>
                {!collapsed ? (
                  <div className="space-y-3">
                    {items.map((row) => (
                      <TaskMonitorCard
                        key={row.rowKey}
                        row={row}
                        active={row.kind === "task" && activeInstanceId === row.instanceId}
                        maxConcurrentTasks={maxConcurrentTasks}
                        runningCount={taskRunningCount}
                        pendingAction={pendingAction}
                        onOpen={
                          row.kind === "task" && row.taskId
                            ? () => openTaskDrawer(row.goalId, row.taskId as string, row.instanceId)
                            : undefined
                        }
                        onAction={runAction}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
          {rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#D0D7DE] px-4 py-8 text-center text-[13px] text-[#8C9198]">
              暂无任务执行记录
            </div>
          ) : null}
        </div>

      </aside>
    </>
  );
}

function TaskMonitorCard({
  row,
  active,
  maxConcurrentTasks,
  runningCount,
  pendingAction,
  onOpen,
  onAction,
}: {
  row: TaskMonitorRow;
  active: boolean;
  maxConcurrentTasks: number;
  runningCount: number;
  pendingAction: string | null;
  onOpen?: () => void;
  onAction: (row: TaskMonitorRow, action: "start" | "pause" | "resume" | "rerun" | "stop") => void;
}) {
  const full = runningCount >= maxConcurrentTasks;
  const busy = Boolean(row.instanceId && pendingAction?.endsWith(`:${row.instanceId}`));
  // 监控行的 group 已由 runtime_jobs 实时状态校正，优先据此判定可否暂停/停止，
  // 避免 goals 快照滞后导致正在执行的任务无法操作。
  const canStop = row.group === "running" || row.group === "paused";
  const isTask = row.kind === "task";
  const clickable = isTask && Boolean(onOpen);

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={(event) => {
        if (!clickable || !onOpen) return;
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "rounded-xl border bg-white p-4 transition",
        clickable ? "cursor-pointer hover:border-[#111]" : "cursor-default",
        active ? "border-[#111]" : "border-[#E5E7EB]",
      )}
    >
      <div className="flex items-start gap-3">
        {row.group !== "done" ? (
          <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", statusDotClass[row.group])} />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-[#1F2328]">{row.taskTitle}</div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-[#8C9198]">
            <span className="truncate">{row.goalTitle}</span>
            <span>·</span>
            <span>{sourceChipLabel(row)}</span>
            <span>·</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", rowBadgeClass(row))}>
              {row.statusLabel}
            </span>
          </div>
        </div>
        {isTask ? <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-[#8C9198]" /> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {isTask && row.group === "running" ? (
          <>
            <ActionButton
              disabled={busy || !canStop}
              onClick={() => onAction(row, "pause")}
              icon={<Pause className="h-3.5 w-3.5" />}
            >
              暂停
            </ActionButton>
            <ActionButton
              danger
              disabled={busy || !canStop}
              onClick={() => onAction(row, "stop")}
              icon={<Square className="h-3.5 w-3.5" />}
            >
              停止
            </ActionButton>
          </>
        ) : null}

        {isTask && row.group === "queued" ? (
          <>
            <ActionButton
              primary
              disabled={busy || full}
              onClick={() => onAction(row, "start")}
              icon={<Play className="h-3.5 w-3.5 fill-current" />}
            >
              {full ? "排队中" : "立即开始"}
            </ActionButton>
            <ActionButton
              danger
              disabled={busy}
              onClick={() => onAction(row, "stop")}
              icon={<Square className="h-3.5 w-3.5" />}
            >
              移除
            </ActionButton>
          </>
        ) : null}

        {isTask && row.group === "paused" ? (
          <>
            <ActionButton
              primary
              disabled={busy || full}
              onClick={() => onAction(row, "resume")}
              icon={<Play className="h-3.5 w-3.5 fill-current" />}
            >
              {full ? "排队中" : "继续"}
            </ActionButton>
            <ActionButton
              danger
              disabled={busy}
              onClick={() => onAction(row, "stop")}
              icon={<Square className="h-3.5 w-3.5" />}
            >
              停止
            </ActionButton>
          </>
        ) : null}

        {isTask && row.group === "done" ? (
          <ActionButton
            disabled={busy}
            onClick={() => onAction(row, "rerun")}
            icon={<RotateCcw className="h-3.5 w-3.5" />}
          >
            重新执行
          </ActionButton>
        ) : null}

        {!isTask ? (
          <span className="text-[11px] text-[#8C9198]">系统自动执行</span>
        ) : null}

        <span className="ml-auto text-[11px] text-[#8C9198]">{timeLabel(row)}</span>
      </div>
    </div>
  );
}

function sourceChipLabel(row: TaskMonitorRow) {
  if (row.kind === "task") return taskTypeLabel(row.taskType);
  return row.sourceLabel;
}

function ActionButton({
  children,
  icon,
  primary,
  danger,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45",
        primary
          ? "border-[#1F2328] bg-[#1F2328] text-white hover:bg-black"
          : danger
            ? "border-[#FECACA] bg-white text-[#B42318] hover:border-[#B42318]"
            : "border-[#D0D7DE] bg-white text-[#1F2328] hover:border-[#111]",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function taskTypeLabel(value: TaskMonitorRow["taskType"]) {
  return value === "repeat" ? "循环" : "单次";
}

function timeLabel(row: TaskMonitorRow) {
  if (row.group === "queued") return `等待 ${relativeTime(row.createdAt)}`;
  if (row.group === "done") {
    const doneAt = row.finishedAt ?? row.createdAt;
    return `${relativeTime(doneAt)}完成`;
  }
  const startedAt = row.startedAt ?? row.createdAt;
  return `已执行 ${durationSince(startedAt)}`;
}

function relativeTime(input: string) {
  const date = new Date(input);
  const diffMs = Date.now() - +date;
  if (!Number.isFinite(diffMs)) return "";
  const absMs = Math.abs(diffMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (absMs < minute) return "刚刚";
  if (absMs < hour) return `${Math.round(absMs / minute)}分钟前`;
  if (absMs < day) return `${Math.round(absMs / hour)}小时前`;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function durationSince(input: string) {
  const diffMs = Math.max(0, Date.now() - +new Date(input));
  if (!Number.isFinite(diffMs)) return "-";
  const totalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${`${seconds}`.padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
