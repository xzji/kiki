import { sleep } from "@/lib/utils";
import { getGoalById, useGoalStore } from "@/stores/goalStore";

export async function getGoals() {
  await sleep();
  return useGoalStore.getState().goals;
}

export async function getGoal(goalId: string) {
  await sleep();
  return getGoalById(goalId) ?? null;
}
