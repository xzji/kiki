import { hasOptionalResultFeedback } from "@/lib/taskResult/optionalFeedback";
import type { Goal, Task } from "@/types/kiki";

export type TaskDependencyView = {
  id: string;
  taskId: string;
  title: string;
  displayTitle: string;
  expectedOutcome: string;
  statusLabel: string;
  reason: string;
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
        taskId: dependencyId,
        title: "",
        displayTitle: "未知任务",
        expectedOutcome: "",
        statusLabel: "依赖失效",
        reason: `依赖配置引用了 ${dependencyId}，但当前目标里没有这个任务。`,
        satisfied: false,
        missing: true,
      };
    }
    return {
      id: dependencyId,
      taskId: dependencyId,
      title: dependency.title.replace(/^任务\d+：/, ""),
      displayTitle: dependency.title.replace(/^任务\d+：/, ""),
      expectedOutcome: dependency.expectedOutcome,
      statusLabel: dependencyStatusLabel(dependency),
      reason: dependencyStatusReason(dependency),
      satisfied: dependencySatisfied(dependency),
      missing: false,
    };
  });
}

export function dependencySatisfied(task: Task) {
  if (task.progress >= 100) return true;
  const latest = task.instances[0];
  if (!latest) return false;
  return latest.status === "completed" || hasOptionalResultFeedback(latest);
}

function dependencyStatusLabel(task: Task) {
  if (task.progress >= 100) return "已结束";
  const latest = task.instances[0];
  if (!latest) return "待处理";
  if (hasOptionalResultFeedback(latest)) return "已结束";
  if (latest.status === "completed") return "已结束";
  if (latest.status === "awaiting_user") return "待补充";
  if (latest.status === "in_progress") return "进行中";
  if (latest.status === "paused") return "已暂停";
  if (latest.status === "error") return "执行失败";
  return "待处理";
}

function dependencyStatusReason(task: Task) {
  if (dependencySatisfied(task)) return "上游任务已有可用产出，可作为当前任务输入。";
  const latest = task.instances[0];
  if (!latest) return "需要先执行该上游任务，产出结果后当前任务才能继续。";
  if (latest.status === "awaiting_user") {
    return latest.awaitingUser?.reason || "上游任务正在等待补充信息，需先处理该任务。";
  }
  if (latest.status === "in_progress") return "上游任务仍在执行，需等待它结束并产生产出。";
  if (latest.status === "paused") return "上游任务已暂停，需先继续或重新执行该任务。";
  if (latest.status === "error") {
    return latest.execution?.errorMessage || "上游任务执行失败，需先修复或重试该任务。";
  }
  return "需要先完成该上游任务，产出结果后当前任务才能继续。";
}
