import { sleep } from "@/lib/utils";
import { getGoalById, getTaskById } from "@/stores/goalStore";

export async function getTask(goalId: string, taskId: string) {
  await sleep();
  const goal = getGoalById(goalId);
  if (!goal) return null;
  const found = getTaskById(taskId);
  return found && found.goal.id === goalId ? found.task : null;
}
