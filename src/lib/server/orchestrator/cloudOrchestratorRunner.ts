import { runWithUserContext } from "@/lib/server/context/userContext";
import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";
import { runRecoveryWorker } from "@/lib/server/worker/recoveryWorker";
import {
  reconcileRuntimeJobLeasesAndProjections,
} from "@/lib/server/worker/taskDispatchWorker";
import { executionSupervisor } from "@/lib/server/worker/executionSupervisor";
import { listUsersForOrchestratorTick } from "@/lib/server/orchestrator/listUsersWithPendingWork";
import { getOrchestratorConfig } from "@/lib/server/orchestrator/orchestratorConfig";
import { runOrchestratorUserFrame } from "@/lib/server/orchestrator/runOrchestratorUserFrame";
import { registerTunnelDispatchCallbacks } from "@/lib/server/worker/dispatchReadyTasksToMachines";
import { startTunnelHub } from "@/lib/server/tunnel/tunnelHub";

const ORCHESTRATOR_LEASE_OWNER = "cloud-orchestrator";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCloudOrchestratorLoop() {
  const config = getOrchestratorConfig();
  process.env.KIKI_ORCHESTRATOR_MODE = "cloud";

  startTunnelHub(config.tunnelPort);
  registerTunnelDispatchCallbacks();
  appendRuntimeDaemonLog(`云端编排器已启动（Tunnel :${config.tunnelPort}）`);

  setInterval(() => {
    for (const candidate of listUsersForOrchestratorTick()) {
      runWithUserContext(candidate.userId, () => {
        try {
          reconcileRuntimeJobLeasesAndProjections();
          executionSupervisor.reconcileJobOwnership();
        } catch (error) {
          appendRuntimeDaemonLog(
            `用户 ${candidate.userId} 对账失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    }
  }, config.reconcileIntervalMs);

  while (true) {
    const candidates = listUsersForOrchestratorTick();
    if (candidates.length === 0) {
      await sleep(config.schedulerIntervalMs);
      continue;
    }

    for (const candidate of candidates) {
      try {
        runWithUserContext(candidate.userId, () => runRecoveryWorker());
        const result = await runOrchestratorUserFrame({
          userId: candidate.userId,
          leaseOwner: ORCHESTRATOR_LEASE_OWNER,
          config,
        });
        appendRuntimeDaemonLog(
          `用户 ${result.userId}：新增任务 ${result.createdJobs}，下发 ${result.dispatched}${
            result.skippedOffline ? "（machine 离线，任务保留 queued）" : ""
          }`,
        );
      } catch (error) {
        appendRuntimeDaemonLog(
          `用户 ${candidate.userId} 编排帧失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await sleep(config.schedulerIntervalMs);
  }
}
