"use client";

import { useMemo, useState } from "react";

import { SubGoalBlock } from "@/components/goal/SubGoalBlock";
import { TaskEditDrawer } from "@/components/goal/TaskEditDrawer";
import { formatDateInput } from "@/lib/date";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import type { Task } from "@/types/dora";

export default function GoalDetailPage({ params }: { params: { goalId: string } }) {
  const goals = useGoalStore((state) => state.goals);
  const inboxItems = useInboxStore((state) => state.items);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  const goal = goals.find((item) => item.id === params.goalId);
  const unreadByTask = useMemo(() => {
    return inboxItems.reduce<Record<string, number>>((acc, item) => {
      const taskId = item.linkTo.match(/tasks\/([^?]+)/)?.[1];
      if (taskId) acc[taskId] = (acc[taskId] ?? 0) + item.unreadCount;
      return acc;
    }, {});
  }, [inboxItems]);

  if (!goal) {
    return <div className="rounded-xl border border-[#E5E7EB] bg-white p-6 text-sm text-[#6B7280]">未找到该目标。</div>;
  }

  return (
    <div className="rounded-[20px] border border-[#D8DDE4] bg-[#F5F6F8] px-8 py-7">
      <div className="mb-8 flex items-end justify-between gap-6 border-b border-[#D8DDE4] pb-6">
        <div>
          <h1 className="text-[28px] font-semibold text-[#111]">{goal.title}</h1>
          <p className="mt-2 text-sm text-[#6B7280]">截止日期：{formatDateInput(goal.deadline)}<span className="mx-2">·</span>完成进度：{goal.progress}%</p>
        </div>
      </div>
      {goal.subGoals.map((subGoal) => (
        <SubGoalBlock key={subGoal.id} goal={goal} subGoal={subGoal} unreadByTask={unreadByTask} onEditTask={setEditingTask} />
      ))}
      <TaskEditDrawer task={editingTask} open={Boolean(editingTask)} onClose={() => setEditingTask(null)} />
    </div>
  );
}
