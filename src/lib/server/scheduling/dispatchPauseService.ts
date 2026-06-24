import { createIdempotencyKey } from "@/lib/opaqueIds";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readRuntimeDaemonConfig, writeRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import {
  cancelRuntimeJobByTaskRun,
  listRuntimeJobsByStatuses,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { cancelActiveTunnelDispatch } from "@/lib/server/scheduling/taskDispatcher";
import { readComposedGoalsSnapshot } from "@/lib/server/runtime/instanceComposition";
import { readGoalsSnapshot, readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import {
  transitionTaskInstanceProjection,
  updateGoalRuntimeJobExecution,
} from "@/lib/server/services/goalRuntimeService";
import { buildPausedJobResumePatch } from "@/lib/server/taskExecution/pauseResumeCheckpoint";
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

/**
 * 读取「以 runtime_jobs 为权威」的目标实例。
 *
 * 调用方必须传入 readComposedGoalsSnapshot 的结果而非裸读快照：goals 投影会滞后
 * （job 已 completed 但投影里实例仍是 pending/paused）。readComposedGoalsSnapshot
 * 用 runtime_jobs 的权威状态覆盖实例 status，与 scheduler / governance / feedback 等链路
 * 统一到同一读取入口。
 *
 * 这样 collectInstances 直接信任合成后的 instance.status 即可：completed job 会被合成为
 * status=completed，自然落在 ["pending","in_progress"] / ["paused"] 目标集之外，
 * 不会被 pause-all / resume-all 误纳入（避免把已完成的一次性任务重新拉起）。
 */
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

function persistPauseCheckpoint(job: NonNullable<ReturnType<typeof cancelRuntimeJobByTaskRun>>, reason: string) {
  const checkpoint = buildPausedJobResumePatch(job, { reason });
  updateGoalRuntimeJobExecution(job.id, {
    payload: {
      ...job.payload,
      resumeContext: checkpoint.resumeContext,
    },
    trajectory: checkpoint.trajectory,
    result: checkpoint.result,
  });
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

  // allow-raw-goals-snapshot: pause 单实例投影写路径，用 raw projection 作为 transition 基准。
  const goals = readGoalsSnapshot([]);
  transitionTaskInstanceProjection({
    goals,
    taskId: task.id,
    instanceId: instance.id,
    status: "paused",
    reason: GLOBAL_DISPATCH_PAUSE_REASON,
  });
  const job = cancelRuntimeJobByTaskRun({
    taskInstanceId: instance.id,
    requestId: instance.runner?.requestId,
    reason: GLOBAL_DISPATCH_PAUSE_REASON,
  });
  if (job) {
    persistPauseCheckpoint(job, GLOBAL_DISPATCH_PAUSE_REASON);
    cancelActiveTunnelDispatch(job.id, { reason: GLOBAL_DISPATCH_PAUSE_REASON });
  }
  return true;
}

export function pauseAllTaskExecution() {
  setDispatchPaused(true);
  const goals = readComposedGoalsSnapshot([]);
  const targets = collectInstances(goals, ["pending", "in_progress"]);
  let pausedCount = 0;
  for (const located of targets) {
    if (pauseInstance(located)) pausedCount += 1;
  }

  const openJobs = listRuntimeJobsByStatuses({ statuses: ["queued", "running"] });
  for (const job of openJobs) {
    const cancelledJob = cancelRuntimeJobByTaskRun({
      taskInstanceId: job.taskInstanceId,
      requestId: job.requestId,
      reason: GLOBAL_DISPATCH_PAUSE_REASON,
    });
    if (cancelledJob) {
      persistPauseCheckpoint(cancelledJob, GLOBAL_DISPATCH_PAUSE_REASON);
      cancelActiveTunnelDispatch(cancelledJob.id, { reason: GLOBAL_DISPATCH_PAUSE_REASON });
    }
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

  const goals = readComposedGoalsSnapshot([]);
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
