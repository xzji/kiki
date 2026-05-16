"use client";

import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { TaskAgentPromptDrawer } from "@/components/goal/TaskAgentPromptDrawer";
import { TaskEditDrawer } from "@/components/goal/TaskEditDrawer";
import { AwaitingUserResumePanel, SubmittedInteractionPanel } from "@/components/task/AwaitingUserResumePanel";
import { GenericAgentResultView } from "@/components/task/GenericAgentResultView";
import { canStopTaskInstance, runTaskExecutionAction } from "@/lib/taskExecution";
import { fetchTaskRunProgress } from "@/lib/api/taskRuns";
import { formatToolOperationText, summarizeToolOperation } from "@/lib/execution/summarizeToolOperation";
import { cn } from "@/lib/utils";
import { useGoalStore } from "@/stores/goalStore";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Goal, Task, TaskExecutionStep, TaskInstance } from "@/types/kiki";

const TASK_TYPE_LABEL: Record<Task["taskType"], string> = {
  daily_repeat: "每日重复",
  one_shot: "一次性",
  monitoring: "监控追踪",
};

const EXECUTION_LABEL: Record<Task["executionKind"], string> = {
  flashcard: "记忆闪卡",
  listening_qa: "听力问答",
  reading_digest: "阅读摘要",
  confirm_action: "确认执行",
  draft_review: "草稿审阅",
  freeform_chat: "补充对话",
  generic_result: "Agent 任务",
};

const PRESENTATION_LABEL = {
  summary_card: "摘要卡片",
  visual_report: "可视化报告",
  comparison_table: "对比表",
  checklist: "检查清单",
  timeline: "时间线",
  document: "结构化文档",
  dashboard: "数据看板",
  handoff_package: "交付包",
} as const;

const SECTION_COPY = {
  pending: {
    title: "待执行",
    description: "等待触发或等待再次开始的任务卡片。",
    empty: "暂无待执行任务卡片",
  },
  running: {
    title: "执行中",
    description: "可展开查看持续滚动的执行信息流。",
    empty: "暂无执行中的任务卡片",
  },
  completed: {
    title: "已完成",
    description: "可展开查看完整执行信息流与最终结果。",
    empty: "暂无已完成任务卡片",
  },
} as const;

type SectionKey = keyof typeof SECTION_COPY;

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isVisibleExecutionStep(step: TaskExecutionStep) {
  return (
    step.toolName !== "debug.stream_event" &&
    !step.title.trim().startsWith("[debug]") &&
    !step.detail?.trim().startsWith("[debug]")
  );
}

function isAssistantProcessStep(step: TaskExecutionStep) {
  return step.type === "assistant" && !step.toolName && step.title === "Agent 过程输出（非最终结果）";
}

function appendAssistantProcessText(previous: string, next: string) {
  if (!previous) return next;
  if (!next) return previous;
  return /[。！？.!?]\s*$/.test(previous) ? `${previous}\n${next}` : `${previous}${next}`;
}

function mergeAssistantProcessSteps(steps: TaskExecutionStep[]) {
  const merged: TaskExecutionStep[] = [];
  for (const step of steps) {
    const previous = merged.at(-1);
    if (previous && isAssistantProcessStep(previous) && isAssistantProcessStep(step)) {
      merged[merged.length - 1] = {
        ...previous,
        status: step.status,
        detail: appendAssistantProcessText(previous.detail?.trim() ?? "", step.detail?.trim() ?? ""),
        finishedAt: step.finishedAt ?? previous.finishedAt,
      };
      continue;
    }
    merged.push(step);
  }
  return merged;
}

function trajectoryToTimeline(trajectory: ExecutionTrajectoryStep[] | undefined): TaskExecutionStep[] | undefined {
  if (!trajectory?.length) return undefined;
  return trajectory.map((step) => ({
    id: step.id,
    title: step.title,
    type:
      step.type === "tool_call" || step.type === "tool_result"
        ? "tool"
        : step.type === "assistant"
          ? "assistant"
          : step.type === "result"
            ? "result"
            : "phase",
    status: step.status,
    detail: step.thought ?? summarizeToolOperation(step.toolCall?.name, step.toolCall?.input),
    toolName: step.toolCall?.name,
    startedAt: step.startedAt,
    finishedAt: step.endedAt,
  }));
}

function applyWaitingReasonToSteps(steps: TaskExecutionStep[], waitingReason: string | undefined) {
  if (!waitingReason?.trim()) return steps;
  const nextSteps = [...steps];
  for (let index = nextSteps.length - 1; index >= 0; index -= 1) {
    const step = nextSteps[index];
    if (step.toolName) continue;
    if (step.status !== "pending" && step.status !== "running") continue;
    if (!/等待 Agent 开始执行|调度器已生成任务实例|任务已创建/.test(step.title)) continue;
    nextSteps[index] = {
      ...step,
      detail: waitingReason.trim(),
    };
    return nextSteps;
  }
  return nextSteps.concat({
    id: `waiting-reason-${nextSteps.at(-1)?.id ?? "step"}`,
    title: "等待 Agent 开始执行",
    type: "phase",
    status: "pending",
    detail: waitingReason.trim(),
    startedAt: nextSteps.at(-1)?.startedAt ?? new Date().toISOString(),
  });
}

export function TaskDetailBody({
  goal,
  task,
}: {
  goal: Goal;
  task: Task;
}) {
  const [metaOpen, setMetaOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [expandedInstanceId, setExpandedInstanceId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [sectionOpen, setSectionOpen] = useState<Record<SectionKey, boolean>>({
    pending: pendingLength(task) > 0,
    running: runningLength(task) > 0,
    completed: completedLength(task) > 0,
  });
  const deleteTask = useGoalStore((state) => state.deleteTask);
  const syncTaskInstanceRun = useGoalStore((state) => state.syncTaskInstanceRun);
  const promptContext = useMemo(() => {
    for (const subGoal of goal.subGoals) {
      if (subGoal.tasks.some((item) => item.id === task.id)) {
        return { goal, subGoal };
      }
    }
    return null;
  }, [goal, task.id]);
  const [promptDrawerOpen, setPromptDrawerOpen] = useState(false);

  const taskState = getTaskDisplayState(task);
  const statusLabel =
    taskState === "completed"
      ? "已完成"
      : taskState === "awaiting_user"
        ? awaitingTaskStatusLabel(task)
        : taskState === "in_progress"
          ? "进行中"
          : taskState === "error"
            ? "执行失败"
            : taskState === "paused"
              ? "已暂停"
              : "待开始";
  const executionAction = getExecutionAction();
  const cleanTitle = task.title.replace(/^任务\d+：/, "");

  const sortedInstances = useMemo(
    () => [...task.instances].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
    [task.instances],
  );
  const pendingInstances = useMemo(
    () => sortedInstances.filter((item) => item.status === "pending" || item.status === "paused"),
    [sortedInstances],
  );
  const runningInstances = useMemo(
    () => sortedInstances.filter((item) => item.status === "in_progress" || item.status === "awaiting_user" || item.awaitingUser),
    [sortedInstances],
  );
  const completedInstances = useMemo(
    () => sortedInstances.filter((item) => isArchivedExecutionInstance(item)),
    [sortedInstances],
  );

  useEffect(() => {
    setSectionOpen((prev) => ({
      pending: pendingInstances.length === 0 ? false : prev.pending,
      running: runningInstances.length === 0 ? false : prev.running,
      completed: completedInstances.length === 0 ? false : prev.completed,
    }));
  }, [pendingInstances.length, runningInstances.length, completedInstances.length]);

  useEffect(() => {
    setSectionOpen((prev) => ({
      pending: pendingInstances.length > 0 && !prev.pending ? true : prev.pending,
      running: runningInstances.length > 0 && !prev.running ? true : prev.running,
      completed: completedInstances.length > 0 && !prev.completed ? true : prev.completed,
    }));
  }, [pendingInstances.length, runningInstances.length, completedInstances.length]);

  useEffect(() => {
    if (expandedInstanceId && !task.instances.some((item) => item.id === expandedInstanceId)) {
      setExpandedInstanceId(null);
    }
  }, [expandedInstanceId, task.instances]);

  useEffect(() => {
    if (runningInstances.length === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        await Promise.all(
          runningInstances.map(async (instance) => {
            const state = await fetchTaskRunProgress({
              requestId: instance.runner?.requestId,
              taskInstanceId: instance.id,
              signal: controller.signal,
            });
            if (cancelled || controller.signal.aborted) return;
            syncTaskInstanceRun({
              taskId: task.id,
              instanceId: instance.id,
              progress: state.progress,
              logs: state.logs,
              trajectory: state.trajectory,
              waitingReason: state.waitingReason,
            });
          }),
        );
        if (!cancelled && !controller.signal.aborted) {
          setRefreshTick((value) => value + 1);
        }
      } catch (error) {
        if (isAbortError(error)) return;
        console.error("[TaskDetailBody] 轮询任务进度失败", error);
      }
    }, 1000);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [refreshTick, runningInstances, syncTaskInstanceRun, task.id]);

  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-[#1F2328]">{cleanTitle}</h2>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
          <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium", taskStatusClassName(taskState))}>
            {statusLabel}
          </span>
          <span>{EXECUTION_LABEL[task.resultViewKind ?? task.executionKind]}</span>
          <span className="text-[#D0D7DE]">/</span>
          <span>{task.triggerRule}</span>
        </div>
        <div className="relative ml-auto flex items-center justify-end gap-1">
          {executionAction ? (
            <button
              type="button"
              onClick={() => {
                void runTaskExecutionAction(task.id, executionAction.action).catch((error) => {
                  window.alert(error instanceof Error ? error.message : "任务执行失败");
                });
              }}
              className="rounded-md border border-[#D0D7DE] bg-white px-2 py-1 text-[12px] text-[#1F2328] hover:border-[#111]"
            >
              {executionAction.label}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setMetaOpen((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-md border border-[#D0D7DE] bg-white px-2 py-1 text-[12px] text-[#1F2328] hover:border-[#111]"
          >
            详细信息
            {metaOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-[#6B7280]" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-[#6B7280]" />
            )}
          </button>
          <button
            type="button"
            aria-label="更多任务操作"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#D0D7DE] bg-white text-[#6B7280] hover:border-[#111] hover:text-[#1F2328]"
          >
            <Ellipsis className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-8 z-20 w-28 overflow-hidden rounded-lg border border-[#E5E7EB] bg-white py-1 text-[12px] text-[#1F2328]">
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
        </div>
      </div>

      <section>
        {metaOpen ? (
          <div className="mt-5 border-t border-[#E5E7EB] pt-4">
            <div className="grid grid-cols-[88px_1fr] gap-x-4 gap-y-3 text-[13px]">
              <MetaLabel>任务类型</MetaLabel>
              <MetaValue>{TASK_TYPE_LABEL[task.taskType]}</MetaValue>

              <MetaLabel>执行周期</MetaLabel>
              <MetaValue>
                {task.taskType === "daily_repeat"
                  ? "每日"
                  : task.taskType === "one_shot"
                    ? "一次性"
                    : "长期"}
              </MetaValue>

              <MetaLabel>触发时间</MetaLabel>
              <MetaValue>{task.triggerRule}</MetaValue>

              <MetaLabel>交付物</MetaLabel>
              <MetaValue>{task.expectedOutcome || "—"}</MetaValue>

              <MetaLabel>交付形式</MetaLabel>
              <MetaValue>{formatDeliverablePresentation(task)}</MetaValue>

              <MetaLabel>执行方式</MetaLabel>
              <MetaValue>{EXECUTION_LABEL[task.resultViewKind ?? task.executionKind]}</MetaValue>

              {task.deadline ? (
                <>
                  <MetaLabel>截止时间</MetaLabel>
                  <MetaValue>{new Date(task.deadline).toISOString().slice(0, 10)}</MetaValue>
                </>
              ) : null}
            </div>

            {task.description ? (
              <div className="mt-4 border-t border-[#E5E7EB] pt-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-[12px] text-[#8C9198]">任务内容</div>
                  {promptContext ? (
                    <button
                      type="button"
                      onClick={() => setPromptDrawerOpen(true)}
                      className="text-[12px] text-[#3B82F6] hover:underline"
                    >
                      📄 Agent 完整任务内容（md）
                    </button>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap text-[13px] leading-6 text-[#1F2328]">{task.description}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="mt-8 space-y-8">
        <InstanceSection
          title={SECTION_COPY.pending.title}
          description={SECTION_COPY.pending.description}
          instances={pendingInstances}
          task={task}
          expandedInstanceId={expandedInstanceId}
          onToggle={setExpandedInstanceId}
          open={sectionOpen.pending}
          onToggleOpen={() => {
            if (pendingInstances.length === 0) return;
            setSectionOpen((prev) => ({ ...prev, pending: !prev.pending }));
          }}
        />
        <InstanceSection
          title={SECTION_COPY.running.title}
          description={SECTION_COPY.running.description}
          instances={runningInstances}
          task={task}
          expandedInstanceId={expandedInstanceId}
          onToggle={setExpandedInstanceId}
          open={sectionOpen.running}
          onToggleOpen={() => {
            if (runningInstances.length === 0) return;
            setSectionOpen((prev) => ({ ...prev, running: !prev.running }));
          }}
        />
        <InstanceSection
          title={SECTION_COPY.completed.title}
          description={SECTION_COPY.completed.description}
          instances={completedInstances}
          task={task}
          expandedInstanceId={expandedInstanceId}
          onToggle={setExpandedInstanceId}
          open={sectionOpen.completed}
          onToggleOpen={() => {
            if (completedInstances.length === 0) return;
            setSectionOpen((prev) => ({ ...prev, completed: !prev.completed }));
          }}
        />
      </div>

      <TaskEditDrawer task={task} open={editOpen} onClose={() => setEditOpen(false)} />
      <TaskAgentPromptDrawer
        open={promptDrawerOpen}
        onClose={() => setPromptDrawerOpen(false)}
        goal={promptContext?.goal ?? null}
        subGoal={promptContext?.subGoal ?? null}
        task={task}
      />
    </div>
  );
}

function InstanceSection({
  title,
  description,
  instances,
  task,
  expandedInstanceId,
  onToggle,
  open,
  onToggleOpen,
}: {
  title: string;
  description: string;
  instances: TaskInstance[];
  task: Task;
  expandedInstanceId: string | null;
  onToggle: (instanceId: string | null) => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const hasInstances = instances.length > 0;

  return (
    <section>
      <button
        type="button"
        onClick={onToggleOpen}
        disabled={!hasInstances}
        className={cn(
          "mb-3 flex w-full items-start justify-between gap-3 text-left",
          hasInstances ? "cursor-pointer" : "cursor-default",
        )}
      >
        <div>
          <h3 className="text-[14px] font-medium text-[#1F2328]">
            {title}
            <span className="ml-2 text-[12px] text-[#8C9198]">({instances.length})</span>
          </h3>
          <div className="mt-1 text-[12px] text-[#8C9198]">{description}</div>
        </div>
        <span className="mt-0.5 text-[#8C9198]">
          {open && hasInstances ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>
      {open && hasInstances ? (
        <div className="space-y-3">
          {instances.map((instance) => (
            <InstanceCard
              key={instance.id}
              task={task}
              instance={instance}
              expanded={expandedInstanceId === instance.id}
              onToggle={() => onToggle(expandedInstanceId === instance.id ? null : instance.id)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function pendingLength(task: Task) {
  return task.instances.filter((item) => item.status === "pending" || item.status === "paused").length;
}

function runningLength(task: Task) {
  return task.instances.filter((item) => item.status === "in_progress" || item.status === "awaiting_user" || item.awaitingUser).length;
}

function completedLength(task: Task) {
  return task.instances.filter((item) => isArchivedExecutionInstance(item)).length;
}

function isArchivedExecutionInstance(instance: TaskInstance) {
  return (instance.status === "completed" && !instance.awaitingUser) || instance.status === "error";
}

function formatDeliverablePresentation(task: Task) {
  const expectedResult = task.expectedResult;
  const presentation = expectedResult?.presentation;
  const presentationLabel = presentation ? PRESENTATION_LABEL[presentation] : "结构化产物";
  const primaryFormat = expectedResult?.primaryFormat ?? "structured_blocks";
  const exportFormats = expectedResult?.exportableFormats?.length
    ? `，可导出 ${expectedResult.exportableFormats.join(" / ")}`
    : "";
  return `${presentationLabel}（${primaryFormat}${exportFormats}）`;
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0秒";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function calculateCumulativeExecutionMs(steps: TaskExecutionStep[]) {
  const now = Date.now();
  const ranges = steps
    .map((step) => {
      const start = new Date(step.startedAt).getTime();
      const end = new Date(step.finishedAt ?? now).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
      return { start, end };
    })
    .filter((item): item is { start: number; end: number } => Boolean(item))
    .sort((left, right) => left.start - right.start);

  if (ranges.length === 0) return 0;

  let total = 0;
  let currentStart = ranges[0].start;
  let currentEnd = ranges[0].end;

  for (let index = 1; index < ranges.length; index += 1) {
    const next = ranges[index];
    if (next.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, next.end);
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = next.start;
    currentEnd = next.end;
  }

  return total + (currentEnd - currentStart);
}

function InstanceCard({
  task,
  instance,
  expanded,
  onToggle,
}: {
  task: Task;
  instance: TaskInstance;
  expanded: boolean;
  onToggle: () => void;
}) {
  const canExpand =
    instance.status === "in_progress" ||
    instance.status === "awaiting_user" ||
    instance.status === "completed" ||
    instance.status === "error" ||
    Boolean(instance.timeline?.length || instance.trajectory?.length || instance.result);
  const resultLine = isArchivedExecutionInstance(instance) ? getInstanceResultLine(task, instance) : "";
  const canStop = canStopTaskInstance(instance);
  const executionSteps = applyWaitingReasonToSteps(
    trajectoryToTimeline(instance.trajectory) ?? instance.timeline ?? [],
    instance.execution?.waitingReason,
  );
  const executionDuration = formatDuration(calculateCumulativeExecutionMs(executionSteps));

  return (
    <div className="overflow-hidden rounded-[16px] border border-[#E5E7EB] bg-white">
      <button
        type="button"
        onClick={canExpand ? onToggle : undefined}
        disabled={!canExpand}
        className={cn("w-full px-4 py-4 text-left", canExpand && "transition-colors hover:bg-[#FCFCFD]")}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
              <span>{instance.dateLabel}</span>
              <span className={cn("rounded-md px-2 py-0.5 text-[11px]", instanceStatusClassName(instance.status))}>
                {instanceStatusLabel(instance)}
              </span>
              {instance.execution?.lastUpdatedAt ? (
                <span>最近更新 {new Date(instance.execution.lastUpdatedAt).toLocaleString("zh-CN")}</span>
              ) : null}
            </div>
            <p className="mt-2 text-[14px] leading-6 text-[#1F2328]">{instance.intro}</p>
            {resultLine ? (
              <div
                className={cn(
                  "mt-3 flex items-start gap-2 rounded-xl border px-3 py-3",
                  instance.status === "error"
                    ? "border-[#FECACA] bg-[#FEF2F2]"
                    : "border-[#E5E7EB] bg-[#F8F9FB]",
                )}
              >
                <div className="shrink-0 text-[11px] text-[#8C9198]">
                  {instance.status === "error" ? "失败原因" : "执行结果"}
                </div>
                <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-[#1F2328]">
                  {resultLine}
                </div>
                {instance.status === "error" ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void runTaskExecutionAction(task.id, "rerun", {
                        instanceId: instance.id,
                      }).catch((error) => {
                        window.alert(error instanceof Error ? error.message : "任务执行失败");
                      });
                    }}
                    className="shrink-0 rounded-md border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] text-[#1F2328] hover:border-[#111]"
                  >
                    重试本次
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {canExpand ? (
            <div className="flex shrink-0 items-center gap-2 text-[12px] text-[#6B7280]">
              {canStop ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void runTaskExecutionAction(task.id, "pause", {
                      instanceId: instance.id,
                    }).catch((error) => {
                      window.alert(error instanceof Error ? error.message : "任务停止失败");
                    });
                  }}
                  className="rounded-md border border-[#FECACA] bg-white px-3 py-1.5 text-[12px] text-[#B42318] hover:border-[#B42318]"
                >
                  停止
                </button>
              ) : null}
              <span>{expanded ? "收起详情" : "展开详情"}</span>
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </div>
          ) : null}
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-[#E5E7EB] bg-[#FAFAFB] px-4 py-4">
          <div className="space-y-4">
            {canStop ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    void runTaskExecutionAction(task.id, "pause", {
                      instanceId: instance.id,
                    }).catch((error) => {
                      window.alert(error instanceof Error ? error.message : "任务停止失败");
                    });
                  }}
                  className="rounded-md border border-[#FECACA] bg-white px-3 py-1.5 text-[12px] text-[#B42318] hover:border-[#B42318]"
                >
                  停止执行
                </button>
              </div>
            ) : null}
            {instance.status === "paused" ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    void runTaskExecutionAction(task.id, "resume", {
                      instanceId: instance.id,
                    }).catch((error) => {
                      window.alert(error instanceof Error ? error.message : "任务执行失败");
                    });
                  }}
                  className="rounded-md border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] text-[#1F2328] hover:border-[#111]"
                >
                  继续执行本次
                </button>
              </div>
            ) : null}
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] font-medium text-[#6B7280]">
                <span>执行过程</span>
                <span className="text-[#8C9198]">累计执行时长 {executionDuration}</span>
              </div>
              <ExecutionMessageStream steps={executionSteps} />
            </div>
            {instance.status === "completed" || instance.status === "awaiting_user" || instance.status === "error" ? (
              <div className="min-w-0">
                <div className="mb-2 text-[12px] font-medium text-[#6B7280]">
                  {instance.status === "error" ? "执行结果 / 失败原因" : "执行结果"}
                </div>
                <InstanceResultPanel task={task} instance={instance} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InstanceResultPanel({ task, instance }: { task: Task; instance: TaskInstance }) {
  const resultLine = getInstanceResultLine(task, instance);
  const failed = instance.status === "error";
  const genericSummary =
    instance.result?.summary ??
    (instance.payload.kind === "generic_result" ? instance.payload.summary : undefined) ??
    instance.intro;
  const genericMessage =
    instance.result?.finalMessage ??
    (instance.payload.kind === "generic_result" ? instance.payload.details : undefined);
  const genericArtifacts =
    instance.result?.artifacts ??
    (instance.payload.kind === "generic_result" ? instance.payload.artifacts : undefined);
  const structuredOutput = instance.result?.structuredOutput;
  const taskResult = instance.result?.taskResult;
  const resultSummary = genericSummary && genericSummary !== resultLine ? genericSummary : "";
  const extraPayloadLines = getPayloadSummaryLines(instance).slice(resultLine ? 1 : 0);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[#E5E7EB] bg-white p-4">
        <div className="text-[12px] text-[#8C9198]">{failed ? "失败原因" : "结果内容"}</div>
        <div className={cn("mt-2 whitespace-pre-wrap text-[14px] leading-7", failed ? "text-[#B42318]" : "text-[#1F2328]")}>
          {resultLine || "该任务暂未产出最终结果。"}
        </div>
        {resultSummary ? (
          <div className="mt-4 border-t border-[#EEF1F4] pt-4">
            <div className="text-[12px] text-[#8C9198]">结果摘要</div>
            <div className="mt-2 whitespace-pre-wrap text-[14px] leading-7 text-[#1F2328]">
              {resultSummary}
            </div>
          </div>
        ) : null}
      </div>
      {(genericMessage && genericMessage !== resultLine) || genericArtifacts?.length || taskResult ? (
        <GenericAgentResultView
          summary={genericSummary}
          finalMessage={genericMessage}
          taskResult={taskResult}
          artifacts={genericArtifacts}
          structuredOutput={structuredOutput}
          notification={instance.notification}
          hideSummaryCard
        />
      ) : null}
      {structuredOutput ? (
        <div className="rounded-xl border border-[#E5E7EB] bg-white p-4">
          <div className="text-[12px] text-[#8C9198]">结构化输出</div>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-[#F8F9FB] p-3 text-[12px] leading-6 text-[#374151]">
            {JSON.stringify(structuredOutput, null, 2)}
          </pre>
        </div>
      ) : null}
      {task.resultViewKind !== "generic_result" || instance.payload.kind !== "generic_result" ? (
        <PayloadSummaryCard lines={extraPayloadLines} />
      ) : null}
      {instance.awaitingUser ? (
        <AwaitingUserResumePanel task={task} instance={instance} />
      ) : instance.result?.interactionSubmission ? (
        <SubmittedInteractionPanel instance={instance} />
      ) : null}
    </div>
  );
}

function ExecutionMessageStream({ steps }: { steps: TaskExecutionStep[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const visibleSteps = useMemo(() => mergeAssistantProcessSteps(steps.filter(isVisibleExecutionStep)), [steps]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [visibleSteps]);

  if (visibleSteps.length === 0) {
    return (
      <div className="rounded-2xl bg-[#F7F7F8] px-4 py-6 text-sm text-[#8C9198]">
        暂无执行消息。
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="max-h-[420px] space-y-2 overflow-y-auto rounded-2xl bg-[#F7F7F8] p-3"
    >
      {visibleSteps.map((step) => (
        <ExecutionFeedItem key={step.id} step={step} />
      ))}
    </div>
  );
}

function ExecutionFeedItem({ step }: { step: TaskExecutionStep }) {
  const timestamp = new Date(step.startedAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const message =
    step.type === "tool" || step.toolName
      ? formatToolOperationText(step.title, step.detail?.trim())
      : step.detail?.trim() || step.title;
  if (step.type === "tool" || step.toolName) {
    return (
      <div className="rounded-full bg-[#EAEAEA] px-3 py-2 text-[12px] leading-5 text-[#5B6168]">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white text-[10px] text-[#8C9198]">
            {toolGlyph(step)}
          </span>
          <span className="min-w-0 flex-1 truncate">{message}</span>
          <span className="shrink-0 text-[11px] text-[#9AA0A6]">{timestamp}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-1 py-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#9AA0A6]">
        <span className={cn("rounded-md px-2 py-0.5", streamStatusClassName(step.status))}>
          {streamStatusLabel(step.status)}
        </span>
        <span>{timestamp}</span>
      </div>
      <div className="mt-1 whitespace-pre-wrap text-[14px] leading-7 text-[#3B4046]">{message}</div>
    </div>
  );
}

function PayloadSummaryCard({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;

  return (
    <div className="rounded-xl border border-[#E5E7EB] bg-white p-4">
      <div className="text-[12px] text-[#8C9198]">更多结果</div>
      <div className="mt-2 space-y-2">
        {lines.map((line, index) => (
          <div key={`payload-line-${index}`} className="rounded-lg bg-[#F8F9FB] px-3 py-2 text-[13px] leading-6 text-[#1F2328]">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function getPayloadSummaryLines(instance: TaskInstance) {
  switch (instance.payload.kind) {
    case "flashcard":
      return [`共生成 ${instance.payload.cards.length} 张记忆卡片，可继续进入训练。`];
    case "listening_qa":
      return [`共准备 ${instance.payload.questions.length} 道听力问答，音频地址：${instance.payload.audioUrl}`];
    case "reading_digest":
      return instance.payload.articles.slice(0, 3).map((article) => `${article.title}：${article.summary}`);
    case "confirm_action":
      return [instance.payload.summary, `可选操作：${instance.payload.options.join(" / ")}`];
    case "draft_review":
      return instance.payload.drafts.slice(0, 3).map((draft) => `${draft.subject} -> ${draft.recipient}`);
    case "freeform_chat":
      return [instance.payload.seed];
    case "generic_result":
    default:
      return [];
  }
}

function getInstanceResultLine(task: Task, instance: TaskInstance) {
  if (instance.status === "error") {
    return (
      instance.execution?.errorMessage ||
      instance.result?.summary ||
      instance.result?.finalMessage ||
      (instance.payload.kind === "generic_result" ? instance.payload.summary ?? instance.payload.details : undefined) ||
      "任务执行失败，但未返回具体失败原因。"
    );
  }
  const submittedInteraction = Boolean(instance.result?.interactionSubmission && !instance.awaitingUser);
  const directResult =
    (submittedInteraction ? undefined : instance.notification?.resultSummary.headline) ??
    instance.result?.summary ??
    instance.result?.finalMessage ??
    (instance.payload.kind === "generic_result" ? instance.payload.summary ?? instance.payload.details : undefined);
  if (directResult) return directResult;

  const payloadLines = getPayloadSummaryLines(instance);
  if (payloadLines.length > 0) return payloadLines[0];
  if (instance.status === "completed") return `${task.title.replace(/^任务\d+：/, "")} 已执行完成。`;
  return "";
}

function streamStatusClassName(status: TaskExecutionStep["status"]) {
  if (status === "completed") return "bg-[#E8F5E9] text-[#25663A]";
  if (status === "running") return "bg-[#DDE1E7] text-[#1F2328]";
  if (status === "awaiting_user") return "bg-[#FFF3CD] text-[#8A6D3B]";
  if (status === "failed") return "bg-[#FDECEC] text-[#B42318]";
  return "bg-[#F5F6F8] text-[#8C9198]";
}

function streamStatusLabel(status: TaskExecutionStep["status"]) {
  if (status === "completed") return "已完成";
  if (status === "running") return "进行中";
  if (status === "awaiting_user") return "待确认";
  if (status === "failed") return "失败";
  return "排队中";
}

function toolGlyph(step: TaskExecutionStep) {
  if (step.status === "failed") return "!";
  const toolName = step.toolName?.toLowerCase() || "";
  if (toolName.includes("web")) return "W";
  if (toolName.includes("search") || toolName.includes("grep") || toolName.includes("glob")) return "Q";
  if (toolName.includes("read")) return "R";
  if (toolName.includes("write") || toolName.includes("edit") || toolName.includes("patch")) return "E";
  if (toolName.includes("command") || toolName.includes("bash")) return "C";
  return "·";
}

function MetaLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] leading-6 text-[#8C9198]">{children}</div>;
}

function MetaValue({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] leading-6 text-[#1F2328]">{children}</div>;
}

function getTaskDisplayState(task: Task) {
  const latest = task.instances[0];
  const latestStatus = latest?.status;
  if (latestStatus === "awaiting_user" || latest?.awaitingUser) return "awaiting_user" as const;
  if (latestStatus === "completed" || task.progress >= 100) return "completed" as const;
  if (latestStatus === "paused") return "paused" as const;
  if (latestStatus === "in_progress") return "in_progress" as const;
  if (latestStatus === "error") return "error" as const;
  if (latestStatus === "pending") return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
  return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
}

function getExecutionAction() {
  return { label: "发起执行", action: "start" as const };
}

function taskStatusClassName(state: ReturnType<typeof getTaskDisplayState>) {
  if (state === "completed") return "bg-[#E5E7EB] text-[#6B7280]";
  if (state === "awaiting_user") return "bg-[#FFF3CD] text-[#8A6D3B]";
  if (state === "in_progress") return "bg-[#DDE1E7] text-[#1F2328]";
  if (state === "error") return "bg-[#FDECEC] text-[#B42318]";
  if (state === "paused") return "bg-[#E5E7EB] text-[#6B7280]";
  return "bg-[#F5F6F8] text-[#8C9198]";
}

function instanceStatusClassName(status: Task["instances"][number]["status"]) {
  if (status === "completed") return "bg-[#E8F5E9] text-[#25663A]";
  if (status === "in_progress") return "bg-[#DDE1E7] text-[#1F2328]";
  if (status === "awaiting_user") return "bg-[#FFF3CD] text-[#8A6D3B]";
  if (status === "error") return "bg-[#FDECEC] text-[#B42318]";
  if (status === "paused") return "bg-[#E5E7EB] text-[#6B7280]";
  return "bg-[#F5F6F8] text-[#8C9198]";
}

function instanceStatusLabel(instance: Task["instances"][number]) {
  const status = instance.status;
  if (status === "completed") return "已完成";
  if (status === "in_progress") return "进行中";
  if (status === "error") return "执行失败";
  if (status === "paused") return "已暂停";
  if (status === "awaiting_user") {
    const type = instance.awaitingUser?.interactionRequirement?.type ?? instance.result?.interactionRequirement?.type;
    if (type === "answer") return "待作答";
    if (type === "provide_context") return "待补充";
    if (type === "perform_offline_action") return "待线下完成";
    if (type === "agent_revision_required") return "等待 Agent 补齐";
    if (type === "deliverable_gap") return "未通过验收";
    return "待确认";
  }
  return "待处理";
}

function awaitingTaskStatusLabel(task: Task) {
  const latest = task.instances[0];
  if (!latest) return "待确认";
  return instanceStatusLabel(latest);
}
