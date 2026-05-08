"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { TaskCreateDrawer } from "@/components/goal/TaskCreateDrawer";
import { TaskRow } from "@/components/goal/TaskRow";
import type { Goal, Task } from "@/types/dora";

export function SubGoalBlock({
  index,
  goal,
  subGoal,
  unreadByTask,
  highlighted = false,
  onOpenTask,
}: {
  index: number;
  goal: Goal;
  subGoal: Goal["subGoals"][number];
  unreadByTask: Record<string, number>;
  highlighted?: boolean;
  onOpenTask: (task: Task) => void;
}) {
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);

  const completedCount = subGoal.tasks.filter((task) => {
    const latestStatus = task.instances[0]?.status;
    return latestStatus === "completed" || task.progress >= 100;
  }).length;
  const progress = subGoal.tasks.length === 0 ? 0 : Math.round((completedCount / subGoal.tasks.length) * 100);

  return (
    <section
      className={`rounded-[18px] border bg-white px-6 py-5 ${
        highlighted ? "border-[#1F2328]" : "border-[#E5E7EB]"
      }`}
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#F5F6F8] text-[11px] font-semibold text-[#1F2328]">
              {index}
            </div>
            <h2 className="truncate text-[15px] font-semibold text-[#1F2328]">{stripPrefix(subGoal.title)}</h2>
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-[#E5E7EB]">
            <div className="h-full rounded-full bg-[#1F2328]" style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="shrink-0 text-[12px] font-medium tabular-nums text-[#8C9198]">
          {completedCount} / {subGoal.tasks.length}
        </div>
      </div>

      <div className="space-y-1.5">
        {subGoal.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            unreadCount={unreadByTask[task.id] ?? 0}
            onOpen={() => onOpenTask(task)}
          />
        ))}
        <button
          type="button"
          onClick={() => setTaskDrawerOpen(true)}
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[#D4D7DD] bg-transparent px-3 py-2.5 text-[13px] text-[#6B7280] hover:border-[#1F2328] hover:text-[#1F2328]"
        >
          <Plus className="h-3.5 w-3.5" />
          添加任务
        </button>
      </div>

      <TaskCreateDrawer
        open={taskDrawerOpen}
        goalId={goal.id}
        subGoalId={subGoal.id}
        onClose={() => setTaskDrawerOpen(false)}
      />
    </section>
  );
}

function stripPrefix(value: string) {
  return value.replace(/^子目标\d+：/, "");
}
