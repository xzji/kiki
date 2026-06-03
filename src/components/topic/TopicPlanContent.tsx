"use client";

import { Calendar, CircleDot, ListTodo, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { ChatHistoryView } from "@/components/topic/ChatHistoryView";
import { DigestTopicView } from "@/components/topic/DigestTopicView";
import { ThreadBlock } from "@/components/topic/ThreadBlock";
import { ThreadCreateDrawer } from "@/components/topic/ThreadCreateDrawer";
import { confirmGoalPlanCommand, requestGoalPlanRevisionCommand } from "@/lib/api/goal-commands";
import { createIdempotencyKey, createOpaqueId } from "@/lib/opaqueIds";
import { cn } from "@/lib/utils";
import { BASE_DATE, formatDateInput } from "@/lib/date";
import { topicDetailPath, topicTaskDetailPath } from "@/lib/routes";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import type { Goal, GoalWorkflowPhase, Task, TaskInstanceStatus } from "@/types/kiki";

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
  const displayGoal = { ...goal, workflow: displayWorkflow, subGoals: displaySubGoals };

  const unreadByTask = useMemo(() => {
    return inboxItems.reduce<Record<string, number>>((acc, item) => {
      const taskId = item.linkTo.match(/tasks\/([^?]+)/)?.[1];
      if (taskId) acc[taskId] = (acc[taskId] ?? 0) + item.unreadCount;
      return acc;
    }, {});
  }, [inboxItems]);

  const summary = useMemo(() => {
    const allTasks = displaySubGoals.flatMap((subGoal) => subGoal.tasks);
    const statusList = allTasks.map(getTaskSummaryStatus);
    const completedCount = statusList.filter((status) => status === "completed").length;
    const awaitingCount = statusList.filter((status) => status === "awaiting_user").length;
    const inProgressCount = statusList.filter((status) => status === "in_progress").length;
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

  return (
    <div className="max-w-[920px] pb-12">
      <section className="mb-8 rounded-[20px] border border-[#E5E7EB] bg-white p-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-[#1F2328]">
              {goal.title}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[#6B7280]">
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

          <div className="grid min-w-[260px] grid-cols-4 gap-3 border-t border-[#E5E7EB] pt-5 lg:min-w-[360px] lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <SummaryStat label="已结束" value={summary.completedCount} />
            <SummaryStat label="待确认" value={summary.awaitingCount} />
            <SummaryStat label="进行中" value={summary.inProgressCount} />
            <SummaryStat label="待开始" value={summary.pendingCount} muted />
          </div>
        </div>
        {displayWorkflow ? (
          <div className="mt-5 rounded-2xl border border-[#E5E7EB] bg-[#F8FAFC] px-4 py-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-[12px] text-[#6B7280]">主题工作流</div>
                <div className="mt-1 text-sm font-medium text-[#1F2328]">
                  {phaseLabel(displayWorkflow.phase)}
                </div>
                {pendingGoalWorkflow ? (
                  <div className="mt-1 text-[12px] leading-5 text-[#8C9198]">保存中...</div>
                ) : null}
                {displayWorkflow.error ? (
                  <div className="mt-1 text-[12px] leading-5 text-[#B42318]">{displayWorkflow.error}</div>
                ) : null}
              </div>
              {displayWorkflow.phase === "presenting_plan" && displayWorkflow.planDecision === "pending" ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const feedback = window.prompt("告诉 KiKi 你希望如何调整这份计划：");
                      if (!feedback?.trim()) return;
                      const overlayId = createOpaqueId("idem");
                      const idempotencyKey = createIdempotencyKey("goal.request_plan_revision", goal.id, feedback.trim(), overlayId);
                      addPendingGoalWorkflow({
                        id: overlayId,
                        goalId: goal.id,
                        idempotencyKey,
                        createdAt: new Date().toISOString(),
                        workflow: {
                          ...displayWorkflow,
                          phase: "decomposing",
                          planDecision: "revision_requested",
                          updatedAt: new Date().toISOString(),
                          collectedInfo: {
                            ...(displayWorkflow.collectedInfo ?? {}),
                            revisionFeedback: feedback.trim(),
                          },
                        },
                      });
                      void requestGoalPlanRevisionCommand({
                        goalId: goal.id,
                        feedback: feedback.trim(),
                        baseRevision: goalProjectionRevision,
                        idempotencyKey,
                      }).then((result) => {
                        applyGoalsProjection(result.goals, result.revision);
                        removePendingGoalWorkflow(overlayId);
                      }).catch((error) => {
                        removePendingGoalWorkflow(overlayId);
                        window.alert(error instanceof Error ? error.message : "规划调整提交失败");
                      });
                    }}
                    className="rounded-lg border border-[#D0D7DE] bg-white px-3 py-2 text-[12px] font-medium text-[#1F2328] hover:border-[#111]"
                  >
                    继续调整
                  </button>
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
                    className="rounded-lg bg-[#111] px-3 py-2 text-[12px] font-medium text-white hover:bg-[#333]"
                  >
                    确认并启动
                  </button>
                </div>
              ) : null}
            </div>
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
  const latest = task.instances[0];
  const latestStatus = latest?.status;
  if (latestStatus === "awaiting_user" || latest?.awaitingUser) return "awaiting_user";
  if (latestStatus === "completed" || task.progress >= 100) return "completed";
  if (
    latestStatus === "in_progress" ||
    latestStatus === "paused"
  ) {
    return "in_progress";
  }
  if (latestStatus === "pending") return task.progress > 0 ? "in_progress" : "pending";
  return task.progress > 0 ? "in_progress" : "pending";
}
