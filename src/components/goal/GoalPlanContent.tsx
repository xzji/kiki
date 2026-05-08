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
import { useInboxStore } from "@/stores/inboxStore";
import type { Goal, Task, TaskInstanceStatus } from "@/types/dora";

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
    <button type="button" onClick={onGoalClick} className="font-medium text-[#1F2328] hover:text-[#111]">
      {goalTitle}
    </button>
  ) : disableLinks ? (
    <span className="font-medium text-[#1F2328]">{goalTitle}</span>
  ) : (
    <Link href={`/goals/${goalId}`} className="font-medium text-[#1F2328] hover:text-[#111]">
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
    <Link href={`/goals/${goalId}`} className="hover:text-[#111]">
      目标规划
    </Link>
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-1 text-right text-xs text-[#8C9198]",
        className,
      )}
    >
      {goalNode}
      <span>/</span>
      {goalPlanNode}
      {taskTitle ? (
        <>
          <span>/</span>
          <span className="font-medium text-[#1F2328]">{taskTitle}</span>
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
    router.push(`/goals/${goal.id}/tasks/${task.id}`);
  };

  return (
    <div className="max-w-[920px] pb-12">
      <GoalPlanBreadcrumb goalId={goal.id} goalTitle={goal.title} className="mb-4" />

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

          <div className="grid min-w-[260px] grid-cols-3 gap-3 border-t border-[#E5E7EB] pt-5 lg:min-w-[300px] lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <SummaryStat label="已完成" value={summary.completedCount} />
            <SummaryStat label="进行中" value={summary.inProgressCount} />
            <SummaryStat label="待开始" value={summary.pendingCount} muted />
          </div>
        </div>
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
  const latestStatus = task.instances[0]?.status;
  if (latestStatus === "completed" || task.progress >= 100) return "completed";
  if (
    latestStatus === "awaiting_user" ||
    latestStatus === "in_progress" ||
    latestStatus === "paused"
  ) {
    return "in_progress";
  }
  if (latestStatus === "pending") return task.progress > 0 ? "in_progress" : "pending";
  return task.progress > 0 ? "in_progress" : "pending";
}
