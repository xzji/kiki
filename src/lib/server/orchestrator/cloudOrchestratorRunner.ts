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
import type { Server as HttpServer } from "http";

const ORCHESTRATOR_LEASE_OWNER = "cloud-orchestrator";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCloudOrchestratorScheduler() {
  const config = getOrchestratorConfig();
  process.env.KIKI_ORCHESTRATOR_MODE = "cloud";

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

/** 本地开发：编排循环（Tunnel 走 HTTP 长轮询 API，无需独立端口） */
export async function runCloudOrchestratorLoop() {
  process.env.KIKI_ORCHESTRATOR_MODE = "cloud";

  registerTunnelDispatchCallbacks();
  appendRuntimeDaemonLog("云端编排器已启动（Tunnel 走 HTTP 长轮询）");

  await runCloudOrchestratorScheduler();
}

/** Railway 生产：Tunnel 走 HTTP 长轮询 API（/api/machine-tunnel/*），再跑编排循环 */
export function bootstrapCloudControlPlane(_server?: HttpServer) {
  void _server;
  process.env.KIKI_ORCHESTRATOR_MODE = "cloud";
  registerTunnelDispatchCallbacks();
  appendRuntimeDaemonLog("云端控制面已启动（Tunnel 走 HTTP 长轮询）");
  void runCloudOrchestratorScheduler().catch((error) => {
    console.error("[kiki-cloud-orchestrator] fatal error", error);
    process.exitCode = 1;
  });
}
