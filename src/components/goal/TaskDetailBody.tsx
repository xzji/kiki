"use client";

import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { TaskAgentPromptDrawer } from "@/components/goal/TaskAgentPromptDrawer";
import { TaskEditDrawer } from "@/components/goal/TaskEditDrawer";
import { AwaitingUserResumePanel, SubmittedInteractionPanel } from "@/components/task/AwaitingUserResumePanel";
import { GenericAgentResultView } from "@/components/task/GenericAgentResultView";
import { TaskExecutionTimeline } from "@/components/task/TaskExecutionTimeline";
import { deleteGoalTaskCommand } from "@/lib/api/goal-commands";
import { createIdempotencyKey, createOpaqueId } from "@/lib/opaqueIds";
import { getTaskDependencyViews } from "@/lib/taskDependencies";
import { canStopTaskInstance, runTaskExecutionAction } from "@/lib/taskExecution";
import { fetchTaskRunProgress } from "@/lib/api/taskRuns";
import { summarizeToolOperation } from "@/lib/execution/summarizeToolOperation";
import { buildAwaitingDisplayModel } from "@/lib/taskInstance/awaitingDisplayModel";
import { hasOptionalResultFeedback } from "@/lib/taskResult/optionalFeedback";
import { cn } from "@/lib/utils";
import { useGoalStore } from "@/stores/goalStore";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { AgentRunPlan } from "@/types/agentOrchestration";
import { normalizeTaskResultViewKind } from "@/types/kiki";
import type { Goal, InteractionSubmission, Task, TaskExecutionStep, TaskInstance } from "@/types/kiki";

const TASK_TYPE_LABEL: Record<Task["taskType"], string> = {
  repeat: "重复任务",
  one_shot: "一次性任务",
};

function formatTaskTriggerMoment(task: Task) {
  const triggerRule = task.triggerRule.trim();
  if (task.executionMode !== "event_triggered") return triggerRule;
  if (!triggerRule) return "满足触发条件执行";
  if (triggerRule.startsWith("满足触发条件执行")) return triggerRule;
  return `满足触发条件执行：${triggerRule}`;
}

const EXECUTION_LABEL: Record<Task["executionKind"], string> = {
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
    title: "已结束",
    description: "可展开查看完整执行信息流与最终结果。",
    empty: "暂无已结束任务卡片",
  },
} as const;

type SectionKey = keyof typeof SECTION_COPY;

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function shouldDeferConcreteResultUntilUserInput(instance: TaskInstance) {
  const requirement = instance.awaitingUser?.interactionRequirement ?? instance.result?.interactionRequirement;
  if (!instance.awaitingUser || !requirement) return false;
  if (hasOptionalResultFeedback(instance)) return false;
  if (requirement.type === "confirm" && requirement.timing === "after_agent_output") return false;
  return (
    requirement.type === "answer" ||
    requirement.type === "provide_context" ||
    requirement.type === "perform_offline_action" ||
    requirement.timing === "before_execution" ||
    requirement.timing === "during_execution" ||
    requirement.timing === "core_task_step"
  );
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
    agentRole: step.agentRole,
    detail: step.thought ?? summarizeToolOperation(step.toolCall?.name, step.toolCall?.input),
    toolName: step.toolCall?.name,
    toolInput: step.toolCall?.input,
    handoff: step.handoff,
    startedAt: step.startedAt,
    finishedAt: step.endedAt,
  }));
}

function isAgentRunPlan(value: unknown): value is AgentRunPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AgentRunPlan>;
  return candidate.schemaVersion === 1 && Array.isArray(candidate.roles);
}

function getAgentRunPlan(instance: TaskInstance) {
  const metaPlan = instance.result?.taskResult?.meta?.agentRunPlan;
  if (isAgentRunPlan(metaPlan)) return metaPlan;
  const structuredPlan = instance.result?.structuredOutput?.agentRunPlan;
  if (isAgentRunPlan(structuredPlan)) return structuredPlan;
  return undefined;
}

function formatInteractionTime(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function getSubmittedInteractionText(submission: InteractionSubmission | undefined) {
  if (!submission) return undefined;
  const fieldLines = Object.entries(submission.fields ?? {})
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}：${value}`);
  if (fieldLines.length) return fieldLines.join("\n");
  return submission.feedback || submission.action;
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
  task: canonicalTask,
  onDeleted,
}: {
  goal: Goal;
  task: Task;
  onDeleted?: () => void;
}) {
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const goalProjectionRevision = useGoalStore((state) => state.goalProjectionRevision);
  const pendingTaskUpdates = useGoalStore((state) => state.pendingTaskUpdates);
  const pendingTaskDeletes = useGoalStore((state) => state.pendingTaskDeletes);
  const addPendingTaskDelete = useGoalStore((state) => state.addPendingTaskDelete);
  const removePendingTaskDelete = useGoalStore((state) => state.removePendingTaskDelete);
  const applyInstanceProgressProjection = useGoalStore((state) => state.applyInstanceProgressProjection);
  const pendingTaskUpdate = pendingTaskUpdates.find((item) => item.goalId === goal.id && item.taskId === canonicalTask.id);
  const pendingTaskDelete = pendingTaskDeletes.find((item) => item.goalId === goal.id && item.taskId === canonicalTask.id);
  const task = pendingTaskUpdate?.task ?? canonicalTask;
  const isPendingChange = Boolean(pendingTaskUpdate || pendingTaskDelete);
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
  const dependencyViews = useMemo(() => getTaskDependencyViews(goal, task), [goal, task]);
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
      ? "已结束"
      : taskState === "awaiting_user"
        ? awaitingTaskStatusLabel(task)
        : taskState === "in_progress"
          ? "进行中"
          : taskState === "error"
            ? "执行失败"
            : taskState === "paused"
              ? "已暂停"
              : "待开始";
  const executionAction = isPendingChange ? null : getExecutionAction(task, taskState);
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
            applyInstanceProgressProjection({
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
  }, [applyInstanceProgressProjection, refreshTick, runningInstances, task.id]);

  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-[#1F2328]">{cleanTitle}</h2>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
          <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium", taskStatusClassName(taskState))}>
            {pendingTaskDelete ? "删除中" : pendingTaskUpdate ? "保存中" : statusLabel}
          </span>
          <span>{EXECUTION_LABEL[normalizeTaskResultViewKind(task.resultViewKind ?? task.executionKind)]}</span>
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
          {!isPendingChange ? (
          <button
            type="button"
            aria-label="更多任务操作"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#D0D7DE] bg-white text-[#6B7280] hover:border-[#111] hover:text-[#1F2328]"
          >
            <Ellipsis className="h-4 w-4" />
          </button>
          ) : null}
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
                  const overlayId = createOpaqueId("idem");
                  const idempotencyKey = createIdempotencyKey("goal.delete_task", goal.id, task.id, overlayId);
                  addPendingTaskDelete({
                    id: overlayId,
                    goalId: goal.id,
                    taskId: task.id,
                    idempotencyKey,
                    createdAt: new Date().toISOString(),
                  });
                  setMenuOpen(false);
                  void deleteGoalTaskCommand({
                    goalId: goal.id,
                    taskId: task.id,
                    baseRevision: goalProjectionRevision,
                    idempotencyKey,
                  })
                    .then((result) => {
                      applyGoalsProjection(result.goals, result.revision);
                      removePendingTaskDelete(overlayId);
                      onDeleted?.();
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
        </div>
      </div>

      <section>
        {metaOpen ? (
          <div className="mt-5 border-t border-[#E5E7EB] pt-4">
            <div className="grid grid-cols-[88px_1fr] gap-x-4 gap-y-3 text-[13px]">
              <MetaLabel>任务类型</MetaLabel>
              <MetaValue>{TASK_TYPE_LABEL[task.taskType]}</MetaValue>

              <MetaLabel>触发时机</MetaLabel>
              <MetaValue>{formatTaskTriggerMoment(task)}</MetaValue>

              <MetaLabel>交付物</MetaLabel>
              <MetaValue>{task.expectedOutcome || "—"}</MetaValue>

              <MetaLabel>交付形式</MetaLabel>
              <MetaValue>{formatDeliverablePresentation(task)}</MetaValue>

              <MetaLabel>执行方式</MetaLabel>
              <MetaValue>{EXECUTION_LABEL[normalizeTaskResultViewKind(task.resultViewKind ?? task.executionKind)]}</MetaValue>

              {dependencyViews.length ? (
                <>
                  <MetaLabel>依赖任务</MetaLabel>
                  <MetaValue>
                    <div className="space-y-3">
                      {dependencyViews.map((dependency) => (
                        <div key={dependency.id} className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span>{dependency.displayTitle}</span>
                            <span className="font-mono text-[11px] text-[#8C9198]">
                              {dependency.missing ? `引用 ID：${dependency.taskId}` : `任务 ID：${dependency.taskId}`}
                            </span>
                            <span
                              className={cn(
                                "rounded-md px-2 py-0.5 text-[11px]",
                                dependency.missing
                                  ? "bg-[#FDECEC] text-[#B42318]"
                                  : dependency.satisfied
                                    ? "bg-[#E8F5E9] text-[#25663A]"
                                    : "bg-[#F5F6F8] text-[#6B7280]",
                              )}
                            >
                              {dependency.statusLabel}
                            </span>
                          </div>
                          <div className="text-[12px] leading-5 text-[#6B7280]">
                            需要信息：{dependency.expectedOutcome || "依赖任务本身不存在，无法读取预期产出。"}
                          </div>
                          <div className={cn("text-[12px] leading-5", dependency.missing ? "text-[#B42318]" : "text-[#6B7280]")}>
                            当前原因：{dependency.reason}
                          </div>
                        </div>
                      ))}
                    </div>
                  </MetaValue>
                </>
              ) : null}

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

      <TaskEditDrawer goalId={goal.id} task={task} open={editOpen} onClose={() => setEditOpen(false)} />
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
  const canStop = !hasOptionalResultFeedback(instance) && canStopTaskInstance(instance);
  const executionSteps = applyWaitingReasonToSteps(
    trajectoryToTimeline(instance.trajectory) ?? instance.timeline ?? [],
    instance.execution?.waitingReason,
  );
  const agentRunPlan = getAgentRunPlan(instance);
  const hasFinalResult = instance.status === "completed" || instance.status === "error";
  const showInlineDetails = hasFinalResult;
  const showOuterToggle = canExpand && !showInlineDetails;
  const detailOpen = expanded || showInlineDetails;
  const [resultOpen, setResultOpen] = useState(hasFinalResult);
  const [processOpen, setProcessOpen] = useState(!hasFinalResult);

  useEffect(() => {
    setResultOpen(hasFinalResult);
    setProcessOpen(!hasFinalResult);
  }, [hasFinalResult, instance.id]);

  return (
    <div className="overflow-hidden rounded-[16px] border border-[#E5E7EB] bg-white">
      <button
        type="button"
        onClick={showOuterToggle ? onToggle : undefined}
        disabled={!canExpand && !showInlineDetails}
        className={cn("w-full px-4 py-4 text-left", showOuterToggle && "transition-colors hover:bg-[#FCFCFD]")}
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
          {showOuterToggle ? (
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

      {detailOpen ? (
        <div className="border-t border-[#E5E7EB] bg-[#FAFAFB] px-4 py-4">
          <div className="space-y-4">
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
            {instance.status === "completed" || instance.status === "error" ? (
              <InstanceDetailSection
                title="执行结果"
                description={instance.status === "error" ? "失败原因与可重试信息" : "最终结论与产出物"}
                open={resultOpen}
                onToggle={() => setResultOpen((value) => !value)}
              >
                <InstanceResultPanel task={task} instance={instance} />
              </InstanceDetailSection>
            ) : null}
            <InstanceDetailSection
              title="执行过程"
              description={
                agentRunPlan?.mode === "role_collaboration"
                  ? `${agentRunPlan.strategy} · 多 Agent 协同`
                  : "single_agent · KiKi"
              }
              meta={executionSteps.length ? `${executionSteps.length} 条` : undefined}
              open={processOpen}
              onToggle={() => setProcessOpen((value) => !value)}
            >
              <TaskExecutionTimeline
                steps={executionSteps}
                agentRunPlan={agentRunPlan}
                interactionTurn={
                  instance.awaitingUser && !hasOptionalResultFeedback(instance) ? (
                    <AwaitingUserResumePanel task={task} instance={instance} />
                  ) : instance.result?.interactionSubmission ? (
                    <SubmittedInteractionPanel instance={instance} />
                  ) : undefined
                }
                userSubmissionText={getSubmittedInteractionText(instance.result?.interactionSubmission)}
                interactionTime={formatInteractionTime(
                  instance.result?.interactionSubmission?.submittedAt ?? instance.execution?.lastUpdatedAt,
                )}
              />
            </InstanceDetailSection>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InstanceDetailSection({
  title,
  description,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string;
  description: string;
  meta?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl bg-white px-4 py-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2 text-[15px] font-bold text-[#1F2328]">
            {title}
            {meta ? <span className="text-[12px] font-normal text-[#8C9198]">{meta}</span> : null}
          </span>
          <span className="mt-0.5 block text-[12px] text-[#8C9198]">{description}</span>
        </span>
        <span className="mt-0.5 shrink-0 text-[#8C9198]">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>
      {open ? <div className="mt-4 min-w-0">{children}</div> : null}
    </section>
  );
}

function InstanceResultPanel({ task, instance }: { task: Task; instance: TaskInstance }) {
  if (shouldDeferConcreteResultUntilUserInput(instance)) {
    return null;
  }

  const awaitingDisplay = buildAwaitingDisplayModel(task, instance, "detail");
  const resultLine = getInstanceResultLine(task, instance);
  const failed = instance.status === "error";
  const genericSummary =
    instance.result?.summary ??
    instance.payload.summary ??
    instance.intro;
  const genericMessage =
    instance.result?.finalMessage ??
    instance.payload.details;
  const genericArtifacts =
    instance.result?.artifacts ??
    instance.payload.artifacts;
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
          hidePendingUserPlaceholder={awaitingDisplay.hidePendingTaskResultBlocks}
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
      {extraPayloadLines.length > 0 ? (
        <PayloadSummaryCard lines={extraPayloadLines} />
      ) : null}
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

function getPayloadSummaryLines(_instance: TaskInstance) {
  void _instance;
  return [] as string[];
}

function getInstanceResultLine(task: Task, instance: TaskInstance) {
  if (instance.status === "error") {
    return (
      instance.execution?.errorMessage ||
      instance.result?.summary ||
      instance.result?.finalMessage ||
      instance.payload.summary ||
      instance.payload.details ||
      "任务执行失败，但未返回具体失败原因。"
    );
  }
  const submittedInteraction = Boolean(instance.result?.interactionSubmission && !instance.awaitingUser);
  const directResult =
    (submittedInteraction ? undefined : instance.notification?.resultSummary.headline) ??
    instance.result?.summary ??
    instance.result?.finalMessage ??
    instance.payload.summary ??
    instance.payload.details;
  if (directResult) return directResult;

  const payloadLines = getPayloadSummaryLines(instance);
  if (payloadLines.length > 0) return payloadLines[0];
  if (instance.status === "completed") return `${task.title.replace(/^任务\d+：/, "")} 已执行完成。`;
  return "";
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
  if (latest && hasOptionalResultFeedback(latest)) return "completed" as const;
  if (latestStatus === "awaiting_user" || latest?.awaitingUser) return "awaiting_user" as const;
  if (latestStatus === "completed" || task.progress >= 100) return "completed" as const;
  if (latestStatus === "paused") return "paused" as const;
  if (latestStatus === "in_progress") return "in_progress" as const;
  if (latestStatus === "error") return "error" as const;
  if (latestStatus === "pending") return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
  return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
}

function getExecutionAction(task: Task, taskState: ReturnType<typeof getTaskDisplayState>) {
  if (taskState === "completed") return { label: "重新执行", action: "rerun" as const };
  if (taskState === "awaiting_user") return null;
  if (taskState === "in_progress") return { label: "停止", action: "pause" as const };
  if (taskState === "paused") return { label: "继续执行", action: "resume" as const };

  const latest = [...task.instances].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).find((instance) => instance.status !== "completed");
  if (!latest) return { label: "发起执行", action: "start" as const };
  if (latest.status === "pending") return { label: "发起执行", action: "start" as const };
  return null;
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
  if (hasOptionalResultFeedback(instance)) return "已结束";
  if (status === "completed") return "已结束";
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
