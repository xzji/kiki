import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { appendRuntimeDaemonLog, writeRuntimeDaemonState } from "@/lib/daemon/daemonState";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readGoalsSnapshot, readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { runGoalSchedulerEngine } from "@/lib/server/worker/goalSchedulerEngine";
import { runRecoveryWorker } from "@/lib/server/worker/recoveryWorker";
import { runTaskDispatchWorker } from "@/lib/server/worker/taskDispatchWorker";
import { initialGoals } from "@/mocks/goals";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runRuntimeDaemonLoop() {
  const config = readRuntimeDaemonConfig();
  appendRuntimeDaemonLog("KiKi Runtime Daemon 已启动");
  runRecoveryWorker();

  while (true) {
    const runtimeEnvironments = readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS);
    const runtimeEnv =
      runtimeEnvironments.find((environment) => environment.isDefault && environment.type === "local") ??
      runtimeEnvironments.find((environment) => environment.type === "local") ??
      null;
    const goals = readGoalsSnapshot(initialGoals);

    const schedulerResult = runGoalSchedulerEngine({
      goals,
      runtimeEnv,
      config,
    });

    await runTaskDispatchWorker(config.deviceId);
    writeRuntimeDaemonState({
      deviceId: config.deviceId,
      status: "idle",
      lastHeartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    appendRuntimeDaemonLog(
      `本轮调度结束，新增队列任务 ${schedulerResult.createdJobs} 个，跳过 ${schedulerResult.skipped} 个`,
    );
    await sleep(config.schedulerIntervalMs);
  }
}
