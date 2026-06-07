import { getCurrentUserId, runWithUserContext } from "@/lib/server/context/userContext";
import {
  projectRuntimeJobStatusProjection,
  updateGoalRuntimeJobExecution,
} from "@/lib/server/services/goalRuntimeService";
import { orchestratorConcurrencyBudget } from "@/lib/server/orchestrator/concurrencyBudget";
import { getOrchestratorConfig } from "@/lib/server/orchestrator/orchestratorConfig";
import {
  getTunnelHub,
  setMachineDisconnectListener,
  setTunnelExecuteResultListener,
} from "@/lib/server/tunnel/tunnelHub";
import {
  claimQueuedRuntimeJobs,
  renewRuntimeJobLease,
  type RuntimeJobRecord,
} from "@/lib/server/repositories/runtimeJobsRepository";

const LEASE_RENEW_INTERVAL_MS = 30_000;
const LEASE_RENEW_DURATION_MS = 2 * 60 * 1000;

type ActiveTunnelDispatch = {
  job: RuntimeJobRecord;
  leaseOwner: string;
  userId: string;
  machineId: string;
  renewTimer: NodeJS.Timeout;
};

const inFlightTunnelJobs = new Set<string>();
const activeTunnelDispatches = new Map<string, ActiveTunnelDispatch>();

function finishTunnelDispatch(jobId: string) {
  const active = activeTunnelDispatches.get(jobId);
  if (!active) return;
  clearInterval(active.renewTimer);
  activeTunnelDispatches.delete(jobId);
  inFlightTunnelJobs.delete(jobId);
  orchestratorConcurrencyBudget.release(active.userId, 1);
}

function requeueTunnelJob(active: ActiveTunnelDispatch, reason: string) {
  runWithUserContext(active.userId, () => {
    updateGoalRuntimeJobExecution(active.job.id, {
      status: "queued",
      lastError: reason,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    projectRuntimeJobStatusProjection({
      job: active.job,
      status: "queued",
      reason,
    });
  });
}

function completeTunnelJob(input: { jobId: string; ok: boolean; error?: string }) {
  const active = activeTunnelDispatches.get(input.jobId);
  if (!active) return;

  runWithUserContext(active.userId, () => {
    updateGoalRuntimeJobExecution(active.job.id, {
      status: input.ok ? "completed" : "failed",
      lastError: input.ok ? undefined : input.error ?? "本地 machine 执行失败",
      finishedAt: new Date().toISOString(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    if (!input.ok) {
      projectRuntimeJobStatusProjection({
        job: active.job,
        status: "failed",
        reason: input.error ?? "本地 machine 执行失败",
      });
    }
  });
  finishTunnelDispatch(input.jobId);
}

function handleMachineDisconnected(machineId: string) {
  Array.from(activeTunnelDispatches.entries()).forEach(([jobId, active]) => {
    if (active.machineId !== machineId) return;
    requeueTunnelJob(active, `machine ${machineId} 连接已断开，任务重新入队`);
    finishTunnelDispatch(jobId);
  });
}

export function registerTunnelDispatchCallbacks() {
  setTunnelExecuteResultListener(completeTunnelJob);
  setMachineDisconnectListener(handleMachineDisconnected);
}

export async function dispatchReadyTasksToMachines(input: {
  leaseOwner: string;
  limit: number;
}): Promise<{ processed: number; skippedOffline: boolean }> {
  const userId = getCurrentUserId();
  const hub = getTunnelHub();
  const onlineMachineIds = hub.getOnlineMachineIdsForUser(userId);
  if (onlineMachineIds.length === 0) {
    return { processed: 0, skippedOffline: true };
  }
  const machineId = onlineMachineIds[0];

  const config = getOrchestratorConfig();
  const available = Math.max(
    0,
    Math.min(
      input.limit,
      orchestratorConcurrencyBudget.availableSlots(userId, config) - inFlightTunnelJobs.size,
    ),
  );
  if (available === 0) {
    return { processed: 0, skippedOffline: false };
  }

  const claimed = claimQueuedRuntimeJobs({
    leaseOwner: input.leaseOwner,
    limit: available,
    runtimeTransport: "cloud_control_plane",
  });
  if (claimed.length === 0) {
    return { processed: 0, skippedOffline: false };
  }

  let processed = 0;
  for (const job of claimed) {
    if (!hub.isMachineOnline(machineId)) {
      runWithUserContext(userId, () => {
        updateGoalRuntimeJobExecution(job.id, {
          status: "queued",
          lastError: "machine 已离线，任务重新入队",
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
        });
        projectRuntimeJobStatusProjection({
          job,
          status: "queued",
          reason: "machine 已离线，任务重新入队",
        });
      });
      continue;
    }

    orchestratorConcurrencyBudget.acquire(userId, 1);
    inFlightTunnelJobs.add(job.id);

    const requestId = job.requestId ?? `goal-task-${job.id}`;
    const renewTimer = setInterval(() => {
      runWithUserContext(userId, () => {
        renewRuntimeJobLease(job.id, {
          leaseOwner: input.leaseOwner,
          leaseMs: LEASE_RENEW_DURATION_MS,
        });
      });
    }, LEASE_RENEW_INTERVAL_MS);

    activeTunnelDispatches.set(job.id, {
      job,
      leaseOwner: input.leaseOwner,
      userId,
      machineId,
      renewTimer,
    });

    runWithUserContext(userId, () => {
      projectRuntimeJobStatusProjection({
        job,
        status: "running",
        reason: "云端经 Tunnel 下发到本地 machine",
      });
    });

    try {
      hub.sendExecute({
        machineId,
        jobId: job.id,
        requestId,
        payload: {
          goal: job.payload.goal,
          subGoal: job.payload.subGoal,
          task: job.payload.task,
          instance: job.payload.instance,
          runtimeEnv: job.payload.runtimeEnv,
          resumeContext: job.payload.resumeContext,
          trajectory: job.trajectory,
        },
      });
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tunnel 下发失败";
      requeueTunnelJob(activeTunnelDispatches.get(job.id)!, message);
      finishTunnelDispatch(job.id);
    }
  }

  return { processed, skippedOffline: false };
}
