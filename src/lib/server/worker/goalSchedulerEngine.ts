import { createGeneratedInstance } from "@/mocks/goals";
import { createQueuedRuntimeJob, getRuntimeJobByTaskInstanceId } from "@/lib/server/repositories/runtimeJobsRepository";
import { addGeneratedInstanceToGoalsSnapshot } from "@/lib/server/runtime/goalStateSnapshot";
import { readGoalsSnapshot, upsertGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import type { RuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import type { Goal, Task, TaskInstanceStatus } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

const PRIORITY_WEIGHT: Record<NonNullable<Task["priority"]>, number> = {
  critical: 400,
  high: 300,
  medium: 200,
  low: 100,
};

const OPEN_INSTANCE_STATUSES = new Set<TaskInstanceStatus>([
  "pending",
  "in_progress",
  "awaiting_user",
  "paused",
]);

type SchedulerResult = {
  createdJobs: number;
  skipped: number;
};

type ReadyTask = {
  goal: Goal;
  subGoalId: string;
  task: Task;
  priorityScore: number;
};

function toTaskRuntimeStatus(task: Task) {
  const latestStatus = task.instances[0]?.status;
  if (latestStatus && OPEN_INSTANCE_STATUSES.has(latestStatus)) return latestStatus;
  if (task.progress >= 100) return "completed";
  return "pending";
}

function parseHourMinute(triggerRule: string) {
  const match = triggerRule.match(/(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function hasInstanceOnDay(task: Task, date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const label = `${month}-${day}`;
  return task.instances.some((instance) => instance.dateLabel === label);
}

function isTaskDue(task: Task, now: Date) {
  if (task.taskType === "one_shot") return task.instances.length === 0;
  if (hasInstanceOnDay(task, now)) return false;
  const time = parseHourMinute(task.triggerRule);
  if (!time) return true;
  const due = new Date(now);
  due.setHours(time.hour, time.minute, 0, 0);
  return now.getTime() >= due.getTime();
}

function dependenciesMet(goal: Goal, task: Task) {
  if (!task.dependencies?.length) return true;
  const taskMap = new Map(goal.subGoals.flatMap((subGoal) => subGoal.tasks).map((item) => [item.id, item]));
  return task.dependencies.every((dependencyId) => {
    const dependency = taskMap.get(dependencyId);
    if (!dependency) return false;
    if (dependency.progress >= 100) return true;
    return dependency.instances[0]?.status === "completed";
  });
}

function computePriorityScore(task: Task) {
  const priority = task.priority ?? "medium";
  const taskTypeScore = task.taskType === "one_shot" ? 30 : task.taskType === "monitoring" ? 20 : 10;
  const executionScore = task.executionKind === "confirm_action" ? 20 : task.executionKind === "draft_review" ? 15 : 0;
  return PRIORITY_WEIGHT[priority] + taskTypeScore + executionScore;
}

function getReadyTasks(goals: Goal[]) {
  const ready: ReadyTask[] = [];
  const now = new Date();
  for (const goal of goals) {
    if (
      goal.workflow?.planDecision !== "confirmed" ||
      (goal.workflow.phase !== "executing" && goal.workflow.phase !== "monitoring")
    ) {
      continue;
    }
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        if (task.progress >= 100 && task.taskType === "one_shot") continue;
        if (!dependenciesMet(goal, task)) continue;
        const runtimeStatus = toTaskRuntimeStatus(task);
        if (runtimeStatus !== "pending" && runtimeStatus !== "completed") continue;
        if (!isTaskDue(task, now)) continue;
        ready.push({
          goal,
          subGoalId: subGoal.id,
          task,
          priorityScore: computePriorityScore(task),
        });
      }
    }
  }
  return ready.sort((left, right) => right.priorityScore - left.priorityScore);
}

export function runGoalSchedulerEngine(input: {
  goals: Goal[];
  runtimeEnv: RuntimeEnvironment | null;
  config: RuntimeDaemonConfig;
}) {
  if (!input.runtimeEnv || input.runtimeEnv.type !== "local") {
    return { createdJobs: 0, skipped: 0 } satisfies SchedulerResult;
  }
  const runtimeEnv = input.runtimeEnv;

  const readyTasks = getReadyTasks(input.goals).slice(0, input.config.schedulerIntervalMs > 0 ? 50 : 0);
  const nowIso = new Date().toISOString();
  let createdJobs = 0;
  let skipped = 0;

  readyTasks.forEach((item) => {
    const instance = createGeneratedInstance(item.task, nowIso);
    const existing = getRuntimeJobByTaskInstanceId(instance.id);
    if (existing) {
      skipped += 1;
      return;
    }

    const latestSubGoal = item.goal.subGoals.find((subGoal) => subGoal.id === item.subGoalId);
    if (!latestSubGoal) {
      skipped += 1;
      return;
    }

    createQueuedRuntimeJob(
      {
        goal: item.goal,
        subGoal: latestSubGoal,
        task: item.task,
        instance,
        runtimeEnv,
      },
      { requestId: `goal-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    );
    const nextGoals = addGeneratedInstanceToGoalsSnapshot(readGoalsSnapshot(input.goals), item.task.id, nowIso);
    upsertGoalsSnapshot(nextGoals);
    createdJobs += 1;
  });

  return { createdJobs, skipped } satisfies SchedulerResult;
}
