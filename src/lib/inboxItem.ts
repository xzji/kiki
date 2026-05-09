import type { Goal, InboxItem, Task } from "@/types/kiki";

export function resolveInboxTaskContext(item: InboxItem, goals: Goal[]) {
  const goalId = item.goalId ?? extractGoalId(item.linkTo);
  const taskId = extractTaskId(item.linkTo);
  const instanceId = extractInstanceId(item.linkTo);

  if (!goalId || !taskId) return null;

  const goal = goals.find((entry) => entry.id === goalId) ?? null;
  if (!goal) return null;

  const task =
    goal.subGoals
      .flatMap((subGoal) => subGoal.tasks)
      .find((entry) => entry.id === taskId) ?? null;
  if (!task) return null;

  const instance = resolveTaskInstance(task, item.createdAt, instanceId);
  if (!instance) return null;

  return { goal, task, instance };
}

function resolveTaskInstance(task: Task, createdAt: string, instanceId?: string | null) {
  if (instanceId) {
    return task.instances.find((entry) => entry.id === instanceId) ?? null;
  }

  const exactMatch = task.instances.find((entry) => entry.createdAt === createdAt);
  if (exactMatch) return exactMatch;

  return (
    [...task.instances]
      .sort(
        (a, b) =>
          Math.abs(new Date(a.createdAt).getTime() - new Date(createdAt).getTime()) -
          Math.abs(new Date(b.createdAt).getTime() - new Date(createdAt).getTime()),
      )[0] ?? null
  );
}

function extractGoalId(linkTo: string) {
  return linkTo.match(/goals\/([^/]+)/)?.[1] ?? null;
}

function extractTaskId(linkTo: string) {
  return linkTo.match(/tasks\/([^/?]+)/)?.[1] ?? null;
}

function extractInstanceId(linkTo: string) {
  try {
    const url = new URL(linkTo, "http://localhost");
    return url.searchParams.get("instanceId");
  } catch {
    return null;
  }
}
