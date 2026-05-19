import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { appendRuntimeDaemonLog, readRuntimeDaemonState, writeRuntimeDaemonState } from "@/lib/daemon/daemonState";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readGoalsSnapshot, readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { runGoalSchedulerEngine } from "@/lib/server/worker/goalSchedulerEngine";
import { runGoalDaemonSideEffects } from "@/lib/server/worker/goalNotificationWorker";
import { runRecoveryWorker } from "@/lib/server/worker/recoveryWorker";
import { runTaskDispatchWorker } from "@/lib/server/worker/taskDispatchWorker";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runRuntimeDaemonLoop() {
  const config = readRuntimeDaemonConfig();
  appendRuntimeDaemonLog("KiKi Runtime Daemon 已启动");
  runRecoveryWorker();
  setInterval(() => {
    const now = new Date().toISOString();
    const current = readRuntimeDaemonState();
    writeRuntimeDaemonState({
      deviceId: current?.deviceId ?? config.deviceId,
      status: current?.status ?? "idle",
      lastHeartbeatAt: now,
      lastJobId: current?.lastJobId,
      lastJobFinishedAt: current?.lastJobFinishedAt,
      lastError: current?.lastError,
      updatedAt: now,
    });
  }, config.heartbeatIntervalMs);

  while (true) {
    const runtimeEnvironments = readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS);
    const runtimeEnv =
      runtimeEnvironments.find((environment) => environment.isDefault && environment.type === "local") ??
      runtimeEnvironments.find((environment) => environment.type === "local") ??
      null;
    const goals = readGoalsSnapshot([]);

    const schedulerResult = runGoalSchedulerEngine({
      goals,
      runtimeEnv,
      config,
    });
    const sideEffectsResult = runGoalDaemonSideEffects(readGoalsSnapshot(goals));

    await runTaskDispatchWorker(config.deviceId);
    writeRuntimeDaemonState({
      deviceId: config.deviceId,
      status: "idle",
      lastHeartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    appendRuntimeDaemonLog(
      `本轮调度结束，新增队列任务 ${schedulerResult.createdJobs} 个，跳过 ${schedulerResult.skipped} 个，派生日程 ${sideEffectsResult.schedule.synthesized} 个，投递通知 ${sideEffectsResult.notifications.delivered} 个，暂停超时 ${sideEffectsResult.watchdog.paused} 个`,
    );
    await sleep(config.schedulerIntervalMs);
  }
}
