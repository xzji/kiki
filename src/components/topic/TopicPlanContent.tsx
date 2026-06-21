"use client";

import { Calendar, CircleDot, ListTodo, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { ChatHistoryView } from "@/components/topic/ChatHistoryView";
import { DigestTopicView } from "@/components/topic/DigestTopicView";
import {
  ReviewCyclePopover,
  topicGovernancePhaseLabel,
  topicGovernanceTone,
} from "@/components/topic/ReviewCyclePopover";
import { ThreadBlock } from "@/components/topic/ThreadBlock";
import { ThreadCreateDrawer } from "@/components/topic/ThreadCreateDrawer";
import { confirmGoalPlanCommand } from "@/lib/api/goal-commands";
import { generateTopicSagaPlan } from "@/lib/api/topics";
import { replaceGoalDraftInStores } from "@/lib/goalWorkflow";
import { createIdempotencyKey, createOpaqueId } from "@/lib/opaqueIds";
import { dependencySatisfied } from "@/lib/taskDependencies";
import { deriveTaskDisplayState, stripTaskPrefix } from "@/lib/taskInstance";
import { cn } from "@/lib/utils";
import { BASE_DATE, formatDateInput } from "@/lib/date";
import { topicDetailPath, topicTaskDetailPath } from "@/lib/routes";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type {
  Goal,
  GoalWorkflowPhase,
  Task,
  TaskExecutionPhase,
  TaskInstanceStatus,
} from "@/types/kiki";
import { SUPPORTED_RUNTIME_KINDS } from "@/types/runtime";
import type { TriggerIntervalUnit, TriggerSpec } from "@/types/trigger";

type WorkflowTaskState = "in_progress" | "paused" | "awaiting_user" | "pending" | "error" | "completed";

type TaskProgressItem = {
  taskId: string;
  threadTitle: string;
  title: string;
  state: Exclude<WorkflowTaskState, "completed">;
  statusLabel: string;
  blockedByUpstream: boolean;
  phaseText?: string;
  priorityRank: number;
  threadIndex: number;
  taskIndex: number;
};

type WorkflowProgressCounts = {
  completed: number;
  running: number;
  awaiting: number;
  pending: number;
  error: number;
  total: number;
};

type WorkflowProgress = {
  runningTasks: TaskProgressItem[];
  upcomingTasks: TaskProgressItem[];
  attentionTasks: TaskProgressItem[];
  counts: WorkflowProgressCounts;
};

export function TopicPlanBreadcrumb({
  goalId,
  goalTitle,
  taskTitle,
  className,
  onGoalClick,
  onGoalPlanClick,
  disableLinks = false,
}: {
  goalId: string;
  goalTitle: string;
  taskTitle?: string;
  className?: string;
  onGoalClick?: () => void;
  onGoalPlanClick?: () => void;
  disableLinks?: boolean;
}) {
  const goalNode = onGoalClick ? (
    <button type="button" onClick={onGoalClick} className="font-medium hover:text-[#111]">
      {goalTitle}
    </button>
  ) : disableLinks ? (
    <span className="font-medium">{goalTitle}</span>
  ) : (
    <Link href={topicDetailPath(goalId)} className="font-medium hover:text-[#111]">
      {goalTitle}
    </Link>
  );

  const goalPlanNode = taskTitle && onGoalPlanClick ? (
    <button type="button" onClick={onGoalPlanClick} className="font-medium text-[#1F2328] hover:text-[#111]">
      主题规划
    </button>
  ) : disableLinks ? (
    <span className="font-medium text-[#1F2328]">主题规划</span>
  ) : (
    <Link href={topicDetailPath(goalId)} className="font-medium text-[#1F2328] hover:text-[#111]">
      主题规划
    </Link>
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-1 text-right text-xs text-[#1F2328]",
        className,
      )}
    >
      {goalNode}
      <span>/</span>
      {goalPlanNode}
      {taskTitle ? (
        <>
          <span>/</span>
          <span className="font-medium">{taskTitle}</span>
        </>
      ) : null}
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getStoredRevisionFeedback(goal: Goal) {
  return readString(asRecord(goal.workflow?.collectedInfo)?.revisionFeedback);
}

function trimContext(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...` : value;
}

function buildPreviousPlanContext(goal: Goal) {
  const workflowInfo = [
    goal.workflow?.reasoning ? `规划理由：${goal.workflow.reasoning}` : undefined,
    goal.workflow?.notificationStrategy ? `提醒策略：${goal.workflow.notificationStrategy}` : undefined,
  ].filter(Boolean);
  const threads = goal.subGoals.map((subGoal, subGoalIndex) => {
    const tasks = subGoal.tasks.slice(0, 8).map((task, taskIndex) =>
      [
        `  ${taskIndex + 1}. ${task.title}`,
        task.description ? `     描述：${task.description}` : undefined,
        `     预期结果：${task.expectedOutcome}`,
      ].filter(Boolean).join("\n"),
    );
    return [
      `${subGoalIndex + 1}. ${subGoal.title}`,
      subGoal.description ? `   描述：${subGoal.description}` : undefined,
      tasks.join("\n"),
    ].filter(Boolean).join("\n");
  });
  return trimContext(
    [
      `主题：${goal.title}`,
      goal.summary ? `摘要：${goal.summary}` : undefined,
      ...workflowInfo,
      "当前线程与任务：",
      threads.join("\n\n"),
    ].filter(Boolean).join("\n"),
    6000,
  );
}

export function TopicPlanContent({
  goal,
  onOpenTask,
  focusSubGoalId,
}: {
  goal: Goal;
  onOpenTask?: (task: Task) => void;
  focusSubGoalId?: string | null;
}) {
  const router = useRouter();
  const inboxItems = useInboxStore((state) => state.items);
  const markTaskRead = useInboxStore((state) => state.markTaskRead);
  const getActiveRuntimeEnv = useRuntimeEnvStore((state) => state.getActiveEnvironment);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const goalProjectionRevision = useGoalStore((state) => state.goalProjectionRevision);
  const pendingSubGoalCreates = useGoalStore((state) => state.pendingSubGoalCreates);
  const pendingTaskCreates = useGoalStore((state) => state.pendingTaskCreates);
  const pendingTaskUpdates = useGoalStore((state) => state.pendingTaskUpdates);
  const pendingTaskDeletes = useGoalStore((state) => state.pendingTaskDeletes);
  const pendingGoalWorkflows = useGoalStore((state) => state.pendingGoalWorkflows);
  const addPendingGoalWorkflow = useGoalStore((state) => state.addPendingGoalWorkflow);
  const removePendingGoalWorkflow = useGoalStore((state) => state.removePendingGoalWorkflow);
  const [subGoalDrawerOpen, setSubGoalDrawerOpen] = useState(false);
  const [revisionSubmitting, setRevisionSubmitting] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const pendingTaskCreateIds = new Set(
    pendingTaskCreates
      .filter((item) => item.goalId === goal.id)
      .map((item) => item.task.id),
  );
  const pendingTaskUpdateIds = new Set(
    pendingTaskUpdates
      .filter((item) => item.goalId === goal.id)
      .map((item) => item.taskId),
  );
  const pendingTaskDeleteIds = new Set(
    pendingTaskDeletes
      .filter((item) => item.goalId === goal.id)
      .map((item) => item.taskId),
  );
  const pendingTaskUpdatesById = new Map(
    pendingTaskUpdates
      .filter((item) => item.goalId === goal.id)
      .map((item) => [item.taskId, item.task]),
  );
  const pendingSubGoals = pendingSubGoalCreates
    .filter((item) => item.goalId === goal.id)
    .filter((item) => !goal.subGoals.some((subGoal) => subGoal.id === item.subGoal.id))
    .map((item) => item.subGoal);
  const displaySubGoals = [...goal.subGoals, ...pendingSubGoals].map((subGoal) => {
    const pendingTasks = pendingTaskCreates
      .filter((item) => item.goalId === goal.id && item.subGoalId === subGoal.id)
      .filter((item) => !pendingTaskDeleteIds.has(item.task.id))
      .filter((item) => !subGoal.tasks.some((task) => task.id === item.task.id))
      .map((item) => item.task);
    return {
      ...subGoal,
      tasks: [
        ...subGoal.tasks
          .filter((task) => !pendingTaskDeleteIds.has(task.id))
          .map((task) => pendingTaskUpdatesById.get(task.id) ?? task),
        ...pendingTasks,
      ],
    };
  });
  const pendingGoalWorkflow = pendingGoalWorkflows.find((item) => item.goalId === goal.id);
  const displayWorkflow = pendingGoalWorkflow?.workflow ?? goal.workflow;
  const displayGoal = useMemo(
    () => ({ ...goal, workflow: displayWorkflow, subGoals: displaySubGoals }),
    [displaySubGoals, displayWorkflow, goal],
  );

  const unreadByTask = useMemo(() => {
    return inboxItems.reduce<Record<string, number>>((acc, item) => {
      const taskId = item.linkTo.match(/tasks\/([^?]+)/)?.[1];
      if (taskId) acc[taskId] = (acc[taskId] ?? 0) + item.unreadCount;
      return acc;
    }, {});
  }, [inboxItems]);

  const summary = useMemo(() => {
    const allTasks = displaySubGoals.flatMap((subGoal) => subGoal.tasks);
    const statusList = allTasks.map((task) => getTaskSummaryStatus(task));
    const completedCount = statusList.filter((status) => status === "completed").length;
    const awaitingCount = statusList.filter((status) => status === "awaiting_user").length;
    // 顶部卡片无独立的「已暂停 / 失败」位；deriveTaskDisplayState 会返回精确的 paused/error，
    // 这里将其归入「进行中」，避免这类任务从四个卡片中漏算导致合计小于总任务数（重构前 paused
    // 即按 in_progress 计、error 曾错误落入「待开始」，此处统一为进行中既保总和又不再误显示为待开始）。
    const inProgressCount = statusList.filter(
      (status) => status === "in_progress" || status === "paused" || status === "error",
    ).length;
    const pendingCount = statusList.filter((status) => status === "pending").length;
    const daysLeft = Math.max(
      0,
      Math.ceil(
        (new Date(goal.deadline).getTime() - BASE_DATE.getTime()) / (1000 * 60 * 60 * 24),
      ),
    );

    return {
      allTasks,
      completedCount,
      awaitingCount,
      inProgressCount,
      pendingCount,
      daysLeft,
    };
  }, [displaySubGoals, goal.deadline]);

  const workflowProgress = useMemo(() => buildWorkflowProgress(displaySubGoals), [displaySubGoals]);
  const hasActiveWork = workflowProgress.runningTasks.length > 0 || workflowProgress.attentionTasks.length > 0;
  const isExecutingPhase =
    displayWorkflow?.phase === "executing" ||
    displayWorkflow?.phase === "monitoring" ||
    displayWorkflow?.phase === "reviewing";
  const showWorkflowProgress = hasActiveWork || isExecutingPhase;

  if (goal.kind === "chat_history") {
    return <ChatHistoryView goal={goal} />;
  }

  if (goal.kind === "digest") {
    return <DigestTopicView goal={goal} />;
  }

  const handleOpenTask = (task: Task) => {
    markTaskRead(task.id);
    if (onOpenTask) {
      onOpenTask(task);
      return;
    }
    router.push(topicTaskDetailPath(goal.id, task.id));
  };

  const runRevisionPlan = async (feedback: string) => {
    const normalizedFeedback = feedback.trim();
    if (!normalizedFeedback || revisionSubmitting) return;
    const runtimeEnv = getActiveRuntimeEnv();
    if (!runtimeEnv || runtimeEnv.type !== "local") {
      window.alert("当前没有可用的本地 Runtime，请先到设置 -> 运行环境完成连接。");
      return;
    }
    if (!SUPPORTED_RUNTIME_KINDS.includes(runtimeEnv.runtimeKind || "claude")) {
      window.alert("当前目标规划暂不支持这个 Runtime。请在运行环境中切换到 Claude CLI 或 Pi CLI。");
      return;
    }
    const overlayId = createOpaqueId("idem");
    const requestId = `topic-saga-revision-${goal.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replaceIdempotencyKey = createIdempotencyKey("topic.replace_plan", goal.id, normalizedFeedback, overlayId);
    setRevisionSubmitting(true);
    setRevisionError(null);
    addPendingGoalWorkflow({
      id: overlayId,
      goalId: goal.id,
      idempotencyKey: replaceIdempotencyKey,
      createdAt: new Date().toISOString(),
      workflow: {
        ...(displayWorkflow ?? goal.workflow),
        phase: "decomposing",
        planDecision: "revision_requested",
        startedAt: displayWorkflow?.startedAt ?? goal.workflow?.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        collectedInfo: {
          ...(displayWorkflow?.collectedInfo ?? goal.workflow?.collectedInfo ?? {}),
          revisionFeedback: normalizedFeedback,
        },
      },
    });
    try {
      const result = await generateTopicSagaPlan({
        topicText: goal.title,
        runtimeEnv,
        conversationId: goal.conversationId,
        revisionFeedback: normalizedFeedback,
        previousPlanContext: buildPreviousPlanContext(goal),
        requestId,
      });
      if (result.kind === "awaiting_user") {
        const questions = result.questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
        window.alert(questions ? `Saga 需要补充信息：\n\n${questions}` : "Saga 需要补充信息后才能继续。");
        return;
      }
      await replaceGoalDraftInStores({
        goal,
        draft: result.draft,
        revisionFeedback: normalizedFeedback,
        baseRevision: goalProjectionRevision,
        idempotencyKey: replaceIdempotencyKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "规划重新生成失败";
      setRevisionError(message);
      window.alert(message);
    } finally {
      removePendingGoalWorkflow(overlayId);
      setRevisionSubmitting(false);
    }
  };

  const isPlanPending = displayWorkflow?.phase === "presenting_plan" && displayWorkflow.planDecision === "pending";
  const isRevisionStuck = displayWorkflow?.phase === "decomposing" && displayWorkflow.planDecision === "revision_requested";
  const canRevisePlan = isPlanPending || isRevisionStuck;

  return (
        <div className="w-full max-w-[920px] pb-12">
      <section className="mb-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-[#1F2328] sm:text-[28px]">
              {goal.title}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[#6B7280]">
              <ReviewCyclePopover
                kind="topic"
                entityId={goal.id}
                label={topicLoopLabel(goal.topicLoop)}
                phaseLabel={topicGovernancePhaseLabel(goal.topicPhase)}
                phaseTone={topicGovernanceTone(goal.topicPhase)}
                lastTickAt={goal.topicLastTickAt}
                nextTickAt={goal.topicNextTickAt}
                silentCount={goal.topicSilentCount}
                failureCount={goal.topicFailureCount}
              />
              <span className="inline-flex items-center gap-1.5">
                <CircleDot className="h-3.5 w-3.5" />
                {displaySubGoals.length} 个线程
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ListTodo className="h-3.5 w-3.5" />
                {summary.allTasks.length} 个任务
              </span>
            </div>
            {goal.deadline ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[#6B7280]">
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  截止 {formatDateInput(goal.deadline)}
                </span>
                <span className="rounded-md bg-[#E9EEF5] px-2.5 py-1 text-xs font-medium text-[#1F2328]">
                  剩余 {summary.daysLeft} 天
                </span>
              </div>
            ) : null}
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-2 border-t border-[#E5E7EB] pt-5 sm:grid-cols-4 lg:min-w-[360px] lg:gap-3 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <SummaryStat label="已结束" value={summary.completedCount} />
            <SummaryStat label="待确认" value={summary.awaitingCount} />
            <SummaryStat label="进行中" value={summary.inProgressCount} />
            <SummaryStat label="待开始" value={summary.pendingCount} muted />
          </div>
        </div>
        {displayWorkflow || showWorkflowProgress ? (
          <div className="mt-5 rounded-2xl border border-[#E5E7EB] bg-[#F8FAFC] px-4 py-3">
            {displayWorkflow ? (
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="text-[12px] text-[#6B7280]">主题工作流</div>
                  <div className="mt-1 text-sm font-medium text-[#1F2328]">
                    {phaseLabel(displayWorkflow.phase)}
                  </div>
                  {pendingGoalWorkflow || revisionSubmitting ? (
                    <div className="mt-1 text-[12px] leading-5 text-[#8C9198]">
                      {revisionSubmitting ? "重新生成规划中..." : "保存中..."}
                    </div>
                  ) : null}
                  {displayWorkflow.error ? (
                    <div className="mt-1 text-[12px] leading-5 text-[#B42318]">{displayWorkflow.error}</div>
                  ) : null}
                  {revisionError ? (
                    <div className="mt-1 text-[12px] leading-5 text-[#B42318]">{revisionError}</div>
                  ) : null}
                </div>
                {canRevisePlan ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const feedback = window.prompt(
                          "告诉 KiKi 你希望如何调整这份计划：",
                          isRevisionStuck ? getStoredRevisionFeedback(goal) ?? "" : "",
                        );
                        if (!feedback?.trim()) return;
                        void runRevisionPlan(feedback);
                      }}
                      disabled={revisionSubmitting}
                      className="rounded-lg border border-[#D0D7DE] bg-white px-3 py-2 text-[12px] font-medium text-[#1F2328] hover:border-[#111] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {revisionSubmitting ? "重新生成中..." : isRevisionStuck ? "重新生成规划" : "继续调整"}
                    </button>
                    {isPlanPending ? (
                      <button
                        type="button"
                        onClick={() => {
                          const overlayId = createOpaqueId("idem");
                          const idempotencyKey = createIdempotencyKey("goal.confirm_plan", goal.id, overlayId);
                          addPendingGoalWorkflow({
                            id: overlayId,
                            goalId: goal.id,
                            idempotencyKey,
                            createdAt: new Date().toISOString(),
                            workflow: {
                              ...displayWorkflow,
                              phase: "executing",
                              planDecision: "confirmed",
                              updatedAt: new Date().toISOString(),
                              confirmedAt: displayWorkflow.confirmedAt ?? new Date().toISOString(),
                            },
                          });
                          void confirmGoalPlanCommand({ goalId: goal.id, baseRevision: goalProjectionRevision, idempotencyKey }).then((result) => {
                            applyGoalsProjection(result.goals, result.revision);
                            removePendingGoalWorkflow(overlayId);
                          }).catch((error) => {
                            removePendingGoalWorkflow(overlayId);
                            window.alert(error instanceof Error ? error.message : "规划确认失败");
                          });
                        }}
                        disabled={revisionSubmitting}
                        className="rounded-lg bg-[#111] px-3 py-2 text-[12px] font-medium text-white hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        确认并启动
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div>
                <div className="text-[12px] text-[#6B7280]">主题工作流</div>
                <div className="mt-1 text-sm font-medium text-[#1F2328]">执行进展</div>
              </div>
            )}
            {showWorkflowProgress ? <WorkflowProgressPanel progress={workflowProgress} /> : null}
          </div>
        ) : null}
      </section>

      <div className="space-y-4">
        {displaySubGoals.map((subGoal, index) => (
          <ThreadBlock
            key={subGoal.id}
            index={index + 1}
            goal={displayGoal}
            subGoal={subGoal}
            unreadByTask={unreadByTask}
            isPendingCreate={pendingSubGoals.some((pendingSubGoal) => pendingSubGoal.id === subGoal.id)}
            pendingTaskCreateIds={pendingTaskCreateIds}
            pendingTaskUpdateIds={pendingTaskUpdateIds}
            highlighted={focusSubGoalId === subGoal.id}
            onOpenTask={handleOpenTask}
          />
        ))}
        <button
          type="button"
          onClick={() => setSubGoalDrawerOpen(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-[18px] border border-dashed border-[#D4D7DD] bg-transparent px-6 py-5 text-sm text-[#6B7280] hover:border-[#1F2328] hover:text-[#1F2328]"
        >
          <Plus className="h-4 w-4" />
          添加线程
        </button>
      </div>

      <ThreadCreateDrawer
        open={subGoalDrawerOpen}
        goalId={goal.id}
        onClose={() => setSubGoalDrawerOpen(false)}
      />
    </div>
  );
}

function phaseLabel(phase: GoalWorkflowPhase) {
  switch (phase) {
    case "collecting_info":
      return "正在收集主题信息";
    case "decomposing":
      return "正在拆解线程";
    case "generating_tasks":
      return "正在生成任务计划";
    case "reviewing_tasks":
      return "正在检查任务覆盖度";
    case "presenting_plan":
      return "待确认主题规划";
    case "executing":
      return "正在启动执行";
    case "monitoring":
      return "监控中，KiKi 会按任务触发规则推进";
    case "reviewing":
      return "正在复盘主题进展";
    case "paused":
      return "已暂停";
    case "completed":
      return "已结束";
    case "error":
      return "主题工作流出错";
    default:
      return "待启动";
  }
}

function topicLoopLabel(value?: TriggerSpec) {
  if (!value) return "每天";
  switch (value.kind) {
    case "realtime":
      return "实时";
    case "hourly":
      return "每小时";
    case "daily":
      return value.time ? `每天 ${value.time}` : "每天";
    case "weekly":
      return value.time ? `每周 ${value.time}` : "每周";
    case "monthly":
      return value.time ? `每月 ${value.time}` : "每月";
    case "one_shot":
      return "仅首次";
    case "immediate":
      return "立即";
    case "interval":
      return `每 ${value.value}${intervalUnitLabel(value.unit)}`;
    case "cron":
      return value.timezone ? `按固定时间（${value.timezone}）` : "按固定时间";
    case "phased":
      return "按指定时段";
    case "event":
      return "有新事件时";
    case "composed":
      return "组合规则";
    default:
      return "每天";
  }
}

function intervalUnitLabel(unit: TriggerIntervalUnit) {
  switch (unit) {
    case "ms":
      return "毫秒";
    case "s":
      return "秒";
    case "m":
      return "分钟";
    case "h":
      return "小时";
    case "d":
      return "天";
    default:
      return "";
  }
}

function SummaryStat({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  return (
    <div className="text-center">
      <div
        className={`text-[24px] font-semibold tracking-[-0.03em] ${
          muted ? "text-[#9AA0A6]" : "text-[#1F2328]"
        }`}
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] tracking-[0.08em] text-[#8C9198]">{label}</div>
    </div>
  );
}

function getTaskSummaryStatus(task: Task): TaskInstanceStatus | "pending" {
  return deriveTaskDisplayState(task);
}

function buildWorkflowProgress(subGoals: Goal["subGoals"]): WorkflowProgress {
  const taskMap = new Map(subGoals.flatMap((subGoal) => subGoal.tasks).map((task) => [task.id, task]));
  const runningTasks: TaskProgressItem[] = [];
  const upcomingTasks: TaskProgressItem[] = [];
  const attentionTasks: TaskProgressItem[] = [];
  const counts: WorkflowProgressCounts = {
    completed: 0,
    running: 0,
    awaiting: 0,
    pending: 0,
    error: 0,
    total: 0,
  };

  subGoals.forEach((subGoal, threadIndex) => {
    subGoal.tasks.forEach((task, taskIndex) => {
      const state = classifyTaskProgress(task);
      counts.total += 1;

      if (state === "completed") {
        counts.completed += 1;
        return;
      }

      if (state === "awaiting_user") counts.awaiting += 1;
      if (state === "pending") counts.pending += 1;
      if (state === "error") counts.error += 1;
      if (state === "in_progress" || state === "paused") counts.running += 1;

      const item: TaskProgressItem = {
        taskId: task.id,
        threadTitle: subGoal.title,
        title: stripTaskPrefix(task.title),
        state,
        statusLabel: workflowStatusLabel(task, state),
        blockedByUpstream: isBlockedByUpstream(task, taskMap),
        phaseText: workflowPhaseText(task, state),
        priorityRank: priorityRank(task),
        threadIndex,
        taskIndex,
      };

      if (state === "error") {
        attentionTasks.push(item);
      } else if (state === "pending") {
        upcomingTasks.push(item);
      } else {
        runningTasks.push(item);
      }
    });
  });

  upcomingTasks.sort((left, right) => {
    if (left.blockedByUpstream !== right.blockedByUpstream) {
      return left.blockedByUpstream ? 1 : -1;
    }
    if (left.priorityRank !== right.priorityRank) return left.priorityRank - right.priorityRank;
    if (left.threadIndex !== right.threadIndex) return left.threadIndex - right.threadIndex;
    return left.taskIndex - right.taskIndex;
  });

  return { runningTasks, upcomingTasks, attentionTasks, counts };
}

function classifyTaskProgress(task: Task): WorkflowTaskState {
  return deriveTaskDisplayState(task);
}

function isBlockedByUpstream(task: Task, taskMap: Map<string, Task>) {
  return (task.dependencies ?? []).some((dependencyId) => {
    const dependency = taskMap.get(dependencyId);
    return dependency ? !dependencySatisfied(dependency) : false;
  });
}

function priorityRank(task: Task) {
  switch (task.priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
    case undefined:
      return 2;
    case "low":
      return 3;
    default:
      return 2;
  }
}

function workflowStatusLabel(task: Task, state: Exclude<WorkflowTaskState, "completed">) {
  if (state === "awaiting_user") return awaitingStatusLabel(task);
  if (state === "paused") return "已暂停";
  if (state === "error") return "执行失败";
  if (state === "pending") return "待开始";
  return "进行中";
}

function awaitingStatusLabel(task: Task) {
  const latest = task.instances[0];
  const type = latest?.awaitingUser?.interactionRequirement?.type ?? latest?.result?.interactionRequirement?.type;
  if (type === "answer") return "待作答";
  if (type === "provide_context") return "待补充";
  if (type === "perform_offline_action") return "待线下完成";
  return "待确认";
}

function workflowPhaseText(task: Task, state: Exclude<WorkflowTaskState, "completed">) {
  const latest = task.instances[0];
  if (state === "awaiting_user") {
    return latest?.awaitingUser?.reason ?? latest?.execution?.waitingReason;
  }
  if (state === "error") {
    return latest?.execution?.errorMessage;
  }
  if (state === "paused") {
    return latest?.execution?.waitingReason ?? "等待继续执行";
  }
  if (state === "in_progress") {
    return executionPhaseLabel(latest?.execution?.phase);
  }
  return undefined;
}

function executionPhaseLabel(phase: TaskExecutionPhase | undefined) {
  switch (phase) {
    case "queued":
      return "排队中";
    case "preparing":
      return "准备执行";
    case "running":
      return "执行中";
    case "awaiting_user":
      return "等待用户确认";
    case "paused":
      return "已暂停";
    case "retrying":
      return "重试中";
    case "completed":
      return "已完成";
    case "failed":
      return "执行失败";
    case "cancelled":
      return "已取消";
    default:
      return undefined;
  }
}

function WorkflowProgressPanel({ progress }: { progress: WorkflowProgress }) {
  const visibleUpcoming = progress.upcomingTasks.slice(0, 5);
  const hiddenUpcomingCount = Math.max(0, progress.upcomingTasks.length - visibleUpcoming.length);

  return (
    <div className="mt-4 border-t border-[#E5E7EB] pt-4">
      {progress.attentionTasks.length > 0 ? (
        <div className="rounded-xl border border-[#F2C7C3] bg-[#FFF7F6] px-3 py-2">
          <div className="mb-2 text-[12px] font-medium text-[#B42318]">需关注</div>
          <div className="space-y-2">
            {progress.attentionTasks.map((item) => (
              <WorkflowTaskLine key={item.taskId} item={item} tone="error" />
            ))}
          </div>
        </div>
      ) : null}

      <div className={`${progress.attentionTasks.length > 0 ? "mt-4 " : ""}grid gap-4 md:grid-cols-2`}>
        <WorkflowTaskGroup
          title="正在执行"
          emptyText="暂无正在执行的任务"
          items={progress.runningTasks}
          tone="active"
        />
        <WorkflowTaskGroup
          title="接下来计划执行"
          emptyText="已无待开始任务"
          items={visibleUpcoming}
          tone="pending"
          footer={hiddenUpcomingCount > 0 ? `还有 ${hiddenUpcomingCount} 个待开始任务` : undefined}
        />
      </div>
    </div>
  );
}

function WorkflowTaskGroup({
  title,
  emptyText,
  items,
  tone,
  footer,
}: {
  title: string;
  emptyText: string;
  items: TaskProgressItem[];
  tone: "active" | "pending";
  footer?: string;
}) {
  return (
    <div>
      <div className="mb-2 text-[12px] font-medium text-[#6B7280]">{title}</div>
      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((item) => (
            <WorkflowTaskLine key={item.taskId} item={item} tone={tone} />
          ))}
          {footer ? <div className="text-[12px] leading-5 text-[#8C9198]">{footer}</div> : null}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-[#D4D7DD] px-3 py-3 text-[12px] text-[#8C9198]">
          {emptyText}
        </div>
      )}
    </div>
  );
}

function WorkflowTaskLine({
  item,
  tone,
}: {
  item: TaskProgressItem;
  tone: "active" | "pending" | "error";
}) {
  return (
    <div className="rounded-xl bg-white px-3 py-2 shadow-[0_0_0_1px_rgba(31,35,40,0.04)]">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-1.5 h-2 w-2 shrink-0 rounded-full",
            tone === "error" ? "bg-[#B42318]" : tone === "active" ? "bg-[#1F2328]" : "bg-[#D0D7DE]",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-medium text-[#1F2328]">{item.title}</span>
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                tone === "error"
                  ? "bg-[#FDECEC] text-[#B42318]"
                  : tone === "active"
                    ? "bg-[#DDE1E7] text-[#1F2328]"
                    : "bg-[#F5F6F8] text-[#8C9198]",
              )}
            >
              {item.statusLabel}
            </span>
            {item.blockedByUpstream ? (
              <span className="rounded-md bg-[#FFF3CD] px-1.5 py-0.5 text-[11px] font-medium text-[#8A6D3B]">
                等待上游
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[12px] leading-5 text-[#8C9198]">
            {item.threadTitle}
            {item.phaseText ? ` · ${item.phaseText}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
