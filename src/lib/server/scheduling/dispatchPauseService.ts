import { createIdempotencyKey } from "@/lib/opaqueIds";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readRuntimeDaemonConfig, writeRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import {
  cancelRuntimeJobByTaskRun,
  listRuntimeJobsByStatuses,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { readGoalsSnapshot, readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { transitionTaskInstanceProjection } from "@/lib/server/services/goalRuntimeService";
import { startTaskAttempt } from "@/lib/server/taskExecution/startTaskAttempt";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

export const GLOBAL_DISPATCH_PAUSE_REASON = "用户暂停全部任务执行";

type LocatedInstance = {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
};

export function isDispatchPaused() {
  return readRuntimeDaemonConfig().dispatchPaused;
}

export function setDispatchPaused(paused: boolean) {
  const config = readRuntimeDaemonConfig();
  writeRuntimeDaemonConfig({ ...config, dispatchPaused: paused });
}

function selectLocalRuntimeEnv(): RuntimeEnvironment | null {
  const runtimeEnvironments = readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS);
  return (
    runtimeEnvironments.find((environment) => environment.isDefault && environment.type === "local") ??
    runtimeEnvironments.find((environment) => environment.type === "local") ??
    null
  );
}

function collectInstances(goals: Goal[], statuses: TaskInstance["status"][]): LocatedInstance[] {
  const result: LocatedInstance[] = [];
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          if (statuses.includes(instance.status)) {
            result.push({ goal, subGoal, task, instance });
          }
        }
      }
    }
  }
  return result;
}

function pauseInstance(located: LocatedInstance) {
  const { goal, task, instance } = located;
  const previousStatus = instance.status;
  if (previousStatus !== "pending" && previousStatus !== "in_progress") return false;

  appendGoalEventOnce({
    goalId: goal.id,
    taskId: task.id,
    instanceId: instance.id,
    kind: "instance.status_changed",
    producedBy: "user",
    idempotencyKey: createIdempotencyKey(
      "instance.status_changed.global_pause",
      instance.id,
      previousStatus,
      "paused",
    ),
    payload: {
      previousStatus,
      nextStatus: "paused",
      reason: GLOBAL_DISPATCH_PAUSE_REASON,
    },
  });
  appendGoalEventOnce({
    goalId: goal.id,
    taskId: task.id,
    instanceId: instance.id,
    kind: "instance.user_command",
    producedBy: "user",
    idempotencyKey: createIdempotencyKey("instance.user_command.global_pause", instance.id),
    payload: {
      command: "pause",
      reason: GLOBAL_DISPATCH_PAUSE_REASON,
    },
  });

  const goals = readGoalsSnapshot([]);
  transitionTaskInstanceProjection({
    goals,
    taskId: task.id,
    instanceId: instance.id,
    status: "paused",
    reason: GLOBAL_DISPATCH_PAUSE_REASON,
  });
  cancelRuntimeJobByTaskRun({
    taskInstanceId: instance.id,
    requestId: instance.runner?.requestId,
    reason: GLOBAL_DISPATCH_PAUSE_REASON,
  });
  return true;
}

export function pauseAllTaskExecution() {
  setDispatchPaused(true);
  const goals = readGoalsSnapshot([]);
  const targets = collectInstances(goals, ["pending", "in_progress"]);
  let pausedCount = 0;
  for (const located of targets) {
    if (pauseInstance(located)) pausedCount += 1;
  }

  const openJobs = listRuntimeJobsByStatuses({ statuses: ["queued", "running"] });
  for (const job of openJobs) {
    cancelRuntimeJobByTaskRun({
      taskInstanceId: job.taskInstanceId,
      requestId: job.requestId,
      reason: GLOBAL_DISPATCH_PAUSE_REASON,
    });
  }

  return { pausedCount, dispatchPaused: true };
}

export function resumeAllTaskExecution() {
  setDispatchPaused(false);
  const runtimeEnv = selectLocalRuntimeEnv();
  if (!runtimeEnv || runtimeEnv.type !== "local") {
    return { resumedCount: 0, skippedCount: 0, dispatchPaused: false, reason: "当前没有可用的本地 Runtime" };
  }
  if (runtimeEnv.health?.status === "offline") {
    return { resumedCount: 0, skippedCount: 0, dispatchPaused: false, reason: "当前本地 Runtime 离线" };
  }

  const goals = readGoalsSnapshot([]);
  const targets = collectInstances(goals, ["paused"]);
  let resumedCount = 0;
  let skippedCount = 0;

  for (const located of targets) {
    const requestId = `goal-task-resume-all-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = startTaskAttempt({
        goal: located.goal,
        subGoal: located.subGoal,
        task: located.task,
        instance: located.instance,
        runtimeEnv,
        triggerSource: "user",
        requestId,
      });
      if (result.outcome === "queued" || result.outcome === "awaiting_user" || result.outcome === "already_running") {
        resumedCount += 1;
      } else {
        skippedCount += 1;
      }
    } catch {
      skippedCount += 1;
    }
  }

  return { resumedCount, skippedCount, dispatchPaused: false };
}
