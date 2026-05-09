"use client";

import { GoalPlanBreadcrumb } from "@/components/goal/GoalPlanContent";
import { TaskDetailBody } from "@/components/goal/TaskDetailBody";
import { ExecutionShell } from "@/components/task/ExecutionShell";
import { useGoalStore } from "@/stores/goalStore";

export default function TaskDetailPage({
  params,
  searchParams,
}: {
  params: { goalId: string; taskId: string };
  searchParams?: { view?: string; instanceId?: string };
}) {
  const goals = useGoalStore((state) => state.goals);
  const goal = goals.find((item) => item.id === params.goalId);
  const task = goal?.subGoals.flatMap((subGoal) => subGoal.tasks).find((item) => item.id === params.taskId);
  const view = searchParams?.view ?? "list";

  if (!goal || !task) {
    return (
      <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-6 text-sm text-[#6B7280]">
        未找到任务。
      </div>
    );
  }

  const instance =
    task.instances.find((item) => item.id === searchParams?.instanceId) ?? task.instances[0];

  if (view === "exec" && instance) {
    return <ExecutionShell goal={goal} task={task} instance={instance} />;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-2 py-2">
      <GoalPlanBreadcrumb
        goalId={goal.id}
        goalTitle={goal.title}
        taskTitle={task.title.replace(/^任务\d+：/, "")}
        className="mb-4"
      />
      <TaskDetailBody goal={goal} task={task} showProgressBar={false} />
    </div>
  );
}
