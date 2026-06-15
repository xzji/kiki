import { createGeneratedInstance } from "@/lib/goalFactory";
import { normalizeTaskId } from "@/lib/opaqueIds";
import {
  getRuntimeJobByTaskInstanceId,
  listOpenRuntimeJobsByTaskIds,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { composeGoalsWithRuntimeJobs } from "@/lib/server/runtime/instanceComposition";
import { resolveSchedulerDependencyReadiness } from "@/lib/server/taskExecution/contextResolver";
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

type ReadyTaskSelection = {
  ready: ReadyTask[];
  skipped: number;
};

function computePriorityScore(task: Task) {
  const priority = task.priority ?? "medium";
  const taskTypeScore = task.taskType === "one_shot" ? 30 : 10;
  const monitoringScore = task.executionMode === "monitoring" ? 10 : 0;
  return PRIORITY_WEIGHT[priority] + taskTypeScore + monitoringScore;
}

function getReadyTasks(goals: Goal[]): ReadyTaskSelection {
  const ready: ReadyTask[] = [];
  let skipped = 0;
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
        const dependencyReadiness = resolveSchedulerDependencyReadiness({
          goal,
          subGoal,
          task,
        });
        if (dependencyReadiness.state !== "ready") {
          skipped += 1;
          continue;
        }
        ready.push({
          goal,
          subGoalId: subGoal.id,
          task,
          priorityScore: computePriorityScore(task),
        });
      }
    }
  }
  return {
    ready: ready.sort((left, right) => right.priorityScore - left.priorityScore),
    skipped,
  };
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

  // 调度判定必须以 runtime_jobs 为权威：raw 快照里的实例状态可能滞后（例如任务已
  // completed 但快照仍是 pending），会导致下游依赖被误判为未完成而永久卡住。这里与
  // UI / governance 同口径，先把 job 状态合并回 goals 再做就绪与依赖判定。
  const goals = composeGoalsWithRuntimeJobs(input.goals);

  const schedulerLimit = input.config.schedulerIntervalMs > 0 ? 50 : 0;
  const readyTaskSelection = schedulerLimit > 0 ? getReadyTasks(goals) : { ready: [], skipped: 0 };
  const readyTasks = readyTaskSelection.ready.slice(0, schedulerLimit);
  const nowIso = new Date().toISOString();
  let createdJobs = 0;
  let skipped = readyTaskSelection.skipped;

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
