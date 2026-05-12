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
  renewRuntimeJobLease,
  updateRuntimeJobExecution,
} from "@/lib/server/repositories/runtimeJobsRepository";

const DAEMON_VERSION = "0.1.0";
const LEASE_RENEW_INTERVAL_MS = 30 * 1000;
const LEASE_RENEW_DURATION_MS = 2 * 60 * 1000;

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
    let renewTimer: NodeJS.Timeout | null = null;
    try {
      renewTimer = setInterval(() => {
        try {
          const renewResult = renewRuntimeJobLease(job.id, {
            leaseOwner,
            leaseMs: LEASE_RENEW_DURATION_MS,
          });
          if (!renewResult.renewed) {
            appendRuntimeDaemonLog(`任务 ${job.id} 续租失败：lease 已被其他 owner 占用或任务已不在 running 状态`);
            return;
          }
          const now = new Date().toISOString();
          writeRuntimeDaemonState({
            deviceId: device.deviceId,
            status: "running",
            lastHeartbeatAt: now,
            lastJobId: job.id,
            updatedAt: now,
          });
        } catch (renewError) {
          const message = renewError instanceof Error ? renewError.message : String(renewError);
          appendRuntimeDaemonLog(`任务 ${job.id} 续租异常: ${message}`);
        }
      }, LEASE_RENEW_INTERVAL_MS);
      await runGoalTask({
        requestId: job.requestId ?? `goal-task-${Date.now()}`,
        goal: job.payload.goal,
        subGoal: job.payload.subGoal,
        task: job.payload.task,
        instance: job.payload.instance,
        runtimeEnv: job.payload.runtimeEnv,
        resumeContext: job.payload.resumeContext,
        initialTrajectory: job.trajectory,
      });

      const latestProgress = getGoalTelemetryProgress(job.requestId ?? "");
      const latestLogs = job.taskInstanceId ? getTaskTelemetryLogs(job.taskInstanceId) : [];
      const latestTrajectory = Array.isArray(latestProgress?.resultPayload?.trajectory)
        ? job.trajectory.concat(latestProgress.resultPayload.trajectory as typeof job.trajectory).filter((step, index, all) =>
            all.findIndex((item) => item.id === step.id) === index,
          )
        : job.trajectory;
      const latestBlocker = latestProgress?.resultPayload?.blocker ?? null;
      const nextStatus =
        latestProgress?.status === "failed"
          ? "failed"
          : latestProgress?.resultPayload?.awaitingUser || latestBlocker
            ? "awaiting_user"
            : "completed";
      const nextGoals = syncGoalInstanceFromProgress(readGoalsSnapshot([]), {
        taskId: job.payload.task.id,
        instanceId: job.payload.instance.id,
        progress: latestProgress,
        logs: latestLogs,
        trajectory: latestTrajectory,
      });
      upsertGoalsSnapshot(nextGoals);

      updateRuntimeJobExecution(job.id, {
        status: nextStatus,
        progress: latestProgress,
        logs: latestLogs,
        trajectory: latestTrajectory,
        blocker: latestBlocker as typeof job.blocker,
        result:
          latestProgress?.resultPayload && typeof latestProgress.resultPayload === "object"
            ? latestProgress.resultPayload
            : null,
        lastError: nextStatus === "failed" ? latestProgress?.error || "任务未达到完成标准" : undefined,
        finishedAt: latestBlocker ? undefined : new Date().toISOString(),
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
      appendRuntimeDaemonLog(
        nextStatus === "failed"
          ? `任务 ${job.id} 执行失败: ${latestProgress?.error || "任务未达到完成标准"}`
          : latestBlocker
            ? `任务 ${job.id} 等待用户确认`
            : `任务 ${job.id} 执行完成`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "后台任务执行失败";
      const failedJob = job.requestId ? getRuntimeJobByRequestId(job.requestId) : null;
      const latestProgress = job.requestId ? getGoalTelemetryProgress(job.requestId) : failedJob?.progress ?? null;
      const latestLogs = job.taskInstanceId ? getTaskTelemetryLogs(job.taskInstanceId) : [];
      const latestTrajectory = Array.isArray(latestProgress?.resultPayload?.trajectory)
        ? job.trajectory.concat(latestProgress.resultPayload.trajectory as typeof job.trajectory).filter((step, index, all) =>
            all.findIndex((item) => item.id === step.id) === index,
          )
        : job.trajectory;
      const nextGoals = syncGoalInstanceFromProgress(readGoalsSnapshot([]), {
        taskId: job.payload.task.id,
        instanceId: job.payload.instance.id,
        progress: latestProgress,
        logs: latestLogs,
        trajectory: latestTrajectory,
      });
      upsertGoalsSnapshot(nextGoals);
      updateRuntimeJobExecution(job.id, {
        status: "failed",
        progress: latestProgress,
        logs: latestLogs,
        trajectory: latestTrajectory,
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
    } finally {
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
    }
  }

  return { processed: claimed.length };
}
