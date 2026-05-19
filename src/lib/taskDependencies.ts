import { hasOptionalResultFeedback } from "@/lib/taskResult/optionalFeedback";
import type { Goal, Task } from "@/types/kiki";

export type TaskDependencyView = {
  id: string;
  title: string;
  statusLabel: string;
  satisfied: boolean;
  missing: boolean;
};

export function getTaskDependencyViews(goal: Goal, task: Task): TaskDependencyView[] {
  const taskMap = new Map(goal.subGoals.flatMap((subGoal) => subGoal.tasks).map((item) => [item.id, item]));
  return (task.dependencies ?? []).map((dependencyId) => {
    const dependency = taskMap.get(dependencyId);
    if (!dependency) {
      return {
        id: dependencyId,
        title: dependencyId,
        statusLabel: "未找到",
        satisfied: false,
        missing: true,
      };
    }
    return {
      id: dependencyId,
      title: dependency.title.replace(/^任务\d+：/, ""),
      statusLabel: dependencyStatusLabel(dependency),
      satisfied: dependencySatisfied(dependency),
      missing: false,
    };
  });
}

function dependencySatisfied(task: Task) {
  if (task.progress >= 100) return true;
  const latest = task.instances[0];
  if (!latest) return false;
  return latest.status === "completed" || hasOptionalResultFeedback(latest);
}

function dependencyStatusLabel(task: Task) {
  if (task.progress >= 100) return "已完成";
  const latest = task.instances[0];
  if (!latest) return "待处理";
  if (hasOptionalResultFeedback(latest)) return "已完成";
  if (latest.status === "completed") return "已完成";
  if (latest.status === "awaiting_user") return "待补充";
  if (latest.status === "in_progress") return "进行中";
  if (latest.status === "paused") return "已暂停";
  if (latest.status === "error") return "执行失败";
  return "待处理";
}
