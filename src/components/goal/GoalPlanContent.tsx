"use client";

import { Calendar, CircleDot, ListTodo, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { ChatHistoryView } from "@/components/goal/ChatHistoryView";
import { DigestGoalView } from "@/components/goal/DigestGoalView";
import { SubGoalBlock } from "@/components/goal/SubGoalBlock";
import { SubGoalCreateDrawer } from "@/components/goal/SubGoalCreateDrawer";
import { cn } from "@/lib/utils";
import { BASE_DATE, formatDateInput } from "@/lib/date";
import { goalDetailPath, taskDetailPath } from "@/lib/routes";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import type { Goal, GoalWorkflowPhase, Task, TaskInstanceStatus } from "@/types/kiki";

export function GoalPlanBreadcrumb({
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
    <Link href={goalDetailPath(goalId)} className="font-medium hover:text-[#111]">
      {goalTitle}
    </Link>
  );

  const goalPlanNode = taskTitle && onGoalPlanClick ? (
    <button type="button" onClick={onGoalPlanClick} className="hover:text-[#111]">
      目标规划
    </button>
  ) : disableLinks ? (
    <span>目标规划</span>
  ) : (
    <Link href={goalDetailPath(goalId)} className="hover:text-[#111]">
      目标规划
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

export function GoalPlanContent({
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
  const confirmGoalPlan = useGoalStore((state) => state.confirmGoalPlan);
  const requestGoalPlanRevision = useGoalStore((state) => state.requestGoalPlanRevision);
  const [subGoalDrawerOpen, setSubGoalDrawerOpen] = useState(false);

  const unreadByTask = useMemo(() => {
    return inboxItems.reduce<Record<string, number>>((acc, item) => {
      const taskId = item.linkTo.match(/tasks\/([^?]+)/)?.[1];
      if (taskId) acc[taskId] = (acc[taskId] ?? 0) + item.unreadCount;
      return acc;
    }, {});
  }, [inboxItems]);

  const summary = useMemo(() => {
    const allTasks = goal.subGoals.flatMap((subGoal) => subGoal.tasks);
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
  }, [goal]);

  if (goal.kind === "chat_history") {
    return <ChatHistoryView goal={goal} />;
  }

  if (goal.kind === "digest") {
    return <DigestGoalView goal={goal} />;
  }

  const handleOpenTask = (task: Task) => {
    if (onOpenTask) {
      onOpenTask(task);
      return;
    }
    router.push(taskDetailPath(goal.id, task.id));
  };

  return (
    <div className="max-w-[920px] pb-12">
      <section className="mb-8 rounded-[20px] border border-[#E5E7EB] bg-white p-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 items-center gap-5">
            <ProgressRing value={goal.progress} />
            <div className="min-w-0 flex-1">
              <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-[#1F2328]">
                {goal.title}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[#6B7280]">
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  截止 {formatDateInput(goal.deadline)}
                </span>
                <span className="rounded-md bg-[#E9EEF5] px-2.5 py-1 text-xs font-medium text-[#1F2328]">
                  剩余 {summary.daysLeft} 天
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CircleDot className="h-3.5 w-3.5" />
                  {goal.subGoals.length} 个子目标
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <ListTodo className="h-3.5 w-3.5" />
                  {summary.allTasks.length} 个任务
                </span>
              </div>
            </div>
          </div>

          <div className="grid min-w-[260px] grid-cols-4 gap-3 border-t border-[#E5E7EB] pt-5 lg:min-w-[360px] lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <SummaryStat label="已完成" value={summary.completedCount} />
            <SummaryStat label="待确认" value={summary.awaitingCount} />
            <SummaryStat label="进行中" value={summary.inProgressCount} />
            <SummaryStat label="待开始" value={summary.pendingCount} muted />
          </div>
        </div>
        {goal.workflow ? (
          <div className="mt-5 rounded-2xl border border-[#E5E7EB] bg-[#F8FAFC] px-4 py-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-[12px] text-[#6B7280]">目标工作流</div>
                <div className="mt-1 text-sm font-medium text-[#1F2328]">
                  {phaseLabel(goal.workflow.phase)}
                </div>
                {goal.workflow.error ? (
                  <div className="mt-1 text-[12px] leading-5 text-[#B42318]">{goal.workflow.error}</div>
                ) : null}
              </div>
              {goal.workflow.phase === "presenting_plan" && goal.workflow.planDecision === "pending" ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const feedback = window.prompt("告诉 KiKi 你希望如何调整这份计划：");
                      if (!feedback?.trim()) return;
                      requestGoalPlanRevision(goal.id, feedback.trim());
                    }}
                    className="rounded-lg border border-[#D0D7DE] bg-white px-3 py-2 text-[12px] font-medium text-[#1F2328] hover:border-[#111]"
                  >
                    继续调整
                  </button>
                  <button
                    type="button"
                    onClick={() => confirmGoalPlan(goal.id)}
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
        {goal.subGoals.map((subGoal, index) => (
          <SubGoalBlock
            key={subGoal.id}
            index={index + 1}
            goal={goal}
            subGoal={subGoal}
            unreadByTask={unreadByTask}
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
          添加子目标
        </button>
      </div>

      <SubGoalCreateDrawer
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
      return "正在收集目标信息";
    case "decomposing":
      return "正在拆解子目标";
    case "generating_tasks":
      return "正在生成任务计划";
    case "reviewing_tasks":
      return "正在检查任务覆盖度";
    case "presenting_plan":
      return "待确认目标规划";
    case "executing":
      return "正在启动执行";
    case "monitoring":
      return "监控中，KiKi 会按任务触发规则推进";
    case "reviewing":
      return "正在复盘目标进展";
    case "paused":
      return "已暂停";
    case "completed":
      return "已完成";
    case "error":
      return "目标工作流出错";
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

function ProgressRing({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg width="96" height="96" className="-rotate-90">
        <circle cx="48" cy="48" r={radius} fill="none" stroke="#E5E7EB" strokeWidth="6" />
        <circle
          cx="48"
          cy="48"
          r={radius}
          fill="none"
          stroke="#1F2328"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-[22px] font-semibold tracking-[-0.03em] text-[#1F2328]">
        {clamped}%
      </div>
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
