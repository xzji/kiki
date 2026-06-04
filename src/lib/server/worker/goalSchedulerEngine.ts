import { createGeneratedInstance } from "@/lib/goalFactory";
import { normalizeTaskId } from "@/lib/opaqueIds";
import {
  getRuntimeJobByTaskInstanceId,
  listOpenRuntimeJobsByTaskIds,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { startTaskAttempt } from "@/lib/server/taskExecution/startTaskAttempt";
import { isTaskTriggerDue } from "@/lib/taskTriggerTime";
import type { RuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import type { Goal, Task } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

const PRIORITY_WEIGHT: Record<NonNullable<Task["priority"]>, number> = {
  critical: 400,
  high: 300,
  medium: 200,
  low: 100,
};

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

function computePriorityScore(task: Task) {
  const priority = task.priority ?? "medium";
  const taskTypeScore = task.taskType === "one_shot" ? 30 : 10;
  const monitoringScore = task.executionMode === "monitoring" ? 10 : 0;
  return PRIORITY_WEIGHT[priority] + taskTypeScore + monitoringScore;
}

function getReadyTasks(goals: Goal[]) {
  const ready: ReadyTask[] = [];
  const now = new Date();
  const taskIds = goals.flatMap((goal) =>
    goal.subGoals.flatMap((subGoal) => subGoal.tasks.map((task) => task.id)),
  );
  const openTaskIds = new Set(
    listOpenRuntimeJobsByTaskIds(taskIds)
      .map((job) => (job.taskId ? normalizeTaskId(job.taskId) : null))
      .filter((taskId): taskId is string => Boolean(taskId)),
  );
  for (const goal of goals) {
    if (
      goal.workflow?.planDecision !== "confirmed" ||
      (goal.workflow.phase !== "executing" && goal.workflow.phase !== "monitoring")
    ) {
      continue;
    }
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        if (task.autoRunDisabled) continue;
        if (task.progress >= 100 && task.taskType === "one_shot") continue;
        if (openTaskIds.has(normalizeTaskId(task.id))) continue;
        if (!isTaskTriggerDue(task, now)) continue;
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
    let result: ReturnType<typeof startTaskAttempt>;
    try {
      result = startTaskAttempt({
        goal: item.goal,
        subGoal: latestSubGoal,
        task: item.task,
        instance,
        runtimeEnv,
        triggerSource: "scheduler",
        requestId: `goal-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    } catch {
      skipped += 1;
      return;
    }
    if (result.outcome === "queued") {
      createdJobs += 1;
      return;
    }
    if (result.outcome === "awaiting_user" || result.outcome === "already_running" || result.outcome === "blocked_config") {
      skipped += 1;
      return;
    }
  });

  return { createdJobs, skipped } satisfies SchedulerResult;
}
