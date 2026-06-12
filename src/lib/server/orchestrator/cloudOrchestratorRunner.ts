import { runWithUserContext } from "@/lib/server/context/userContext";
import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";
import { runRecoveryWorker } from "@/lib/server/scheduling/recoveryWorker";
import {
  reconcileRuntimeJobLeasesAndProjections,
} from "@/lib/server/scheduling/taskDispatchWorker";
import { listUsersForOrchestratorTick } from "@/lib/server/orchestrator/listUsersWithPendingWork";
import { getOrchestratorConfig } from "@/lib/server/orchestrator/orchestratorConfig";
import { runOrchestratorUserFrame } from "@/lib/server/orchestrator/runOrchestratorUserFrame";
import { registerTunnelDispatchCallbacks } from "@/lib/server/scheduling/taskDispatcher";
import { initializeMachineTunnelWsServer } from "@/lib/server/tunnel/machineTunnelWsServer";
import { describeSchedulingTimezone } from "@/lib/runtime/schedulingTimezone";
import {
  NAMESPACE,
  logScheduling,
  logTickSummary,
} from "@/lib/server/observability/schedulingLog";
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
          // 云端只做 DB 层 lease 对账（lease 过期回收 + 状态投影）；
          // 进程内 supervisor 仅在执行层（本地 daemon）有意义，云端不持有任何子进程。
          reconcileRuntimeJobLeasesAndProjections();
        } catch (error) {
          logScheduling(
            NAMESPACE.task.reconcileLease,
            `user=${candidate.userId} error ${error instanceof Error ? error.message : String(error)}`,
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
        logTickSummary(NAMESPACE.task.scheduler, {
          created: result.createdJobs,
          dispatched: result.dispatched,
          extra: {
            user: result.userId,
            ...(result.skippedOffline ? { skippedOffline: true } : {}),
          },
        });
      } catch (error) {
        logScheduling(
          NAMESPACE.task.scheduler,
          `user=${candidate.userId} frame error ${error instanceof Error ? error.message : String(error)}`,
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
  {
    const tzInfo = describeSchedulingTimezone();
    appendRuntimeDaemonLog(
      `tz applied=${tzInfo.applied} requested=${tzInfo.requested ?? "<unset>"} intl=${tzInfo.intlResolved}`,
    );
  }

  await runCloudOrchestratorScheduler();
}

/** Railway 生产：优先挂载 WS Tunnel，保留 HTTP 长轮询 API（/api/machine-tunnel/*）兜底，再跑编排循环 */
export function bootstrapCloudControlPlane(server?: HttpServer) {
  process.env.KIKI_ORCHESTRATOR_MODE = "cloud";
  if (server) initializeMachineTunnelWsServer(server);
  registerTunnelDispatchCallbacks();
  appendRuntimeDaemonLog("云端控制面已启动（Tunnel 优先 WS，HTTP 长轮询兜底）");
  {
    const tzInfo = describeSchedulingTimezone();
    appendRuntimeDaemonLog(
      `tz applied=${tzInfo.applied} requested=${tzInfo.requested ?? "<unset>"} intl=${tzInfo.intlResolved}`,
    );
  }
  void runCloudOrchestratorScheduler().catch((error) => {
    console.error("[kiki-cloud-orchestrator] fatal error", error);
    process.exitCode = 1;
  });
}
