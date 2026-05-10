import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import {
  appendRuntimeDaemonLog,
  readRuntimeDaemonDeviceState,
  writeRuntimeDaemonDeviceState,
  writeRuntimeDaemonState,
} from "@/lib/daemon/daemonState";
import { syncGoalInstanceFromProgress } from "@/lib/server/runtime/goalStateSnapshot";
import { readGoalsSnapshot, upsertGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { getGoalTelemetryProgress, getTaskTelemetryLogs } from "@/lib/server/goalTelemetry";
import { runGoalTask } from "@/lib/server/goalTaskRunner";
import {
  claimQueuedRuntimeJobs,
  getRuntimeJobByRequestId,
  releaseExpiredRuntimeJobLeases,
  updateRuntimeJobExecution,
} from "@/lib/server/repositories/runtimeJobsRepository";

const DAEMON_VERSION = "0.1.0";

function ensureDeviceState(deviceId: string) {
  const current = readRuntimeDaemonDeviceState();
  if (current) return current;
  const next = {
    deviceId,
    installedAt: new Date().toISOString(),
    daemonVersion: DAEMON_VERSION,
  };
  writeRuntimeDaemonDeviceState(next);
  return next;
}

export async function runTaskDispatchWorker(leaseOwner: string) {
  releaseExpiredRuntimeJobLeases();
  const config = readRuntimeDaemonConfig();
  const device = ensureDeviceState(config.deviceId);
  const claimed = claimQueuedRuntimeJobs({
    leaseOwner,
    limit: 1,
  });
  if (claimed.length === 0) {
    writeRuntimeDaemonState({
      deviceId: device.deviceId,
      status: "idle",
      lastHeartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { processed: 0 };
  }

  for (const job of claimed) {
    writeRuntimeDaemonState({
      deviceId: device.deviceId,
      status: "running",
      lastHeartbeatAt: new Date().toISOString(),
      lastJobId: job.id,
      updatedAt: new Date().toISOString(),
    });
    appendRuntimeDaemonLog(`开始执行任务 ${job.id}`);
    try {
      await runGoalTask({
        requestId: job.requestId ?? `goal-task-${Date.now()}`,
        goal: job.payload.goal,
        subGoal: job.payload.subGoal,
        task: job.payload.task,
        instance: job.payload.instance,
        runtimeEnv: job.payload.runtimeEnv,
      });

      const latestProgress = getGoalTelemetryProgress(job.requestId ?? "");
      const latestLogs = job.taskInstanceId ? getTaskTelemetryLogs(job.taskInstanceId) : [];
      const nextGoals = syncGoalInstanceFromProgress(readGoalsSnapshot([]), {
        taskId: job.payload.task.id,
        instanceId: job.payload.instance.id,
        progress: latestProgress,
        logs: latestLogs,
      });
      upsertGoalsSnapshot(nextGoals);

      updateRuntimeJobExecution(job.id, {
        status: "completed",
        progress: latestProgress,
        logs: latestLogs,
        result:
          latestProgress?.resultPayload && typeof latestProgress.resultPayload === "object"
            ? latestProgress.resultPayload
            : null,
        finishedAt: new Date().toISOString(),
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
      });
      writeRuntimeDaemonState({
        deviceId: device.deviceId,
        status: "idle",
        lastHeartbeatAt: new Date().toISOString(),
        lastJobId: job.id,
        lastJobFinishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      appendRuntimeDaemonLog(`任务 ${job.id} 执行完成`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "后台任务执行失败";
      const failedJob = job.requestId ? getRuntimeJobByRequestId(job.requestId) : null;
      const latestProgress = job.requestId ? getGoalTelemetryProgress(job.requestId) : failedJob?.progress ?? null;
      const latestLogs = job.taskInstanceId ? getTaskTelemetryLogs(job.taskInstanceId) : [];
      const nextGoals = syncGoalInstanceFromProgress(readGoalsSnapshot([]), {
        taskId: job.payload.task.id,
        instanceId: job.payload.instance.id,
        progress: latestProgress,
        logs: latestLogs,
      });
      upsertGoalsSnapshot(nextGoals);
      updateRuntimeJobExecution(job.id, {
        status: "failed",
        progress: latestProgress,
        logs: latestLogs,
        lastError: message,
        finishedAt: new Date().toISOString(),
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
      });
      writeRuntimeDaemonState({
        deviceId: device.deviceId,
        status: "error",
        lastHeartbeatAt: new Date().toISOString(),
        lastJobId: job.id,
        lastError: message,
        updatedAt: new Date().toISOString(),
      });
      appendRuntimeDaemonLog(`任务 ${job.id} 执行失败: ${message}`);
    }
  }

  return { processed: claimed.length };
}
