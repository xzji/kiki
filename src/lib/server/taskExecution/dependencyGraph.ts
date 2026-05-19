import type { Goal, Task } from "@/types/kiki";

export function buildTaskGraph(goal: Goal) {
  const taskMap = new Map<string, Task>();
  const dependencies = new Map<string, string[]>();

  for (const subGoal of goal.subGoals) {
    for (const task of subGoal.tasks) {
      taskMap.set(task.id, task);
      dependencies.set(task.id, task.dependencies ?? []);
    }
  }

  return { taskMap, dependencies };
}

export function detectCycleFromTask(goal: Goal, taskId: string) {
  const { dependencies } = buildTaskGraph(goal);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (currentTaskId: string): string[] | null => {
    if (visiting.has(currentTaskId)) {
      const startIndex = stack.indexOf(currentTaskId);
      return [...stack.slice(Math.max(0, startIndex)), currentTaskId];
    }
    if (visited.has(currentTaskId)) return null;

    visiting.add(currentTaskId);
    stack.push(currentTaskId);

    for (const dependencyId of dependencies.get(currentTaskId) ?? []) {
      const cycle = visit(dependencyId);
      if (cycle) return cycle;
    }

    stack.pop();
    visiting.delete(currentTaskId);
    visited.add(currentTaskId);
    return null;
  };

  return visit(taskId);
}
