import { readRuntimeDaemonConfig, type RuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import {
  appendRuntimeDaemonLog,
  readRuntimeDaemonDeviceState,
  writeRuntimeDaemonDeviceState,
  writeRuntimeDaemonState,
} from "@/lib/daemon/daemonState";
import {
  projectRuntimeJobStatusProjection,
  reconcileRuntimeJobStatusProjections,
  updateGoalRuntimeJobExecution,
} from "@/lib/server/services/goalRuntimeService";
import { getGoalTelemetryProgress, getTaskTelemetryLogs } from "@/lib/server/goalTelemetry";
import { runGoalTask } from "@/lib/server/goalTaskRunner";
import {
  ensureConversationWorkspace,
  ensureTaskWorkspace,
  writeTaskRunSnapshot,
} from "@/lib/server/workspace/conversationWorkspace";
import {
  claimQueuedRuntimeJobs,
  getRuntimeJobByRequestId,
  isRuntimeJobLeaseHeld,
  releaseExpiredRuntimeJobLeases,
  renewRuntimeJobLease,
  type RuntimeJobRecord,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { executionSupervisor } from "@/lib/server/worker/executionSupervisor";

const DAEMON_VERSION = "0.1.0";
const LEASE_RENEW_INTERVAL_MS = 30 * 1000;
const LEASE_RENEW_DURATION_MS = 2 * 60 * 1000;

/**
 * 进程内「正在执行」的 job 集合。用于在每个调度帧按
 * `maxConcurrentTasks - inFlightJobs.size` 计算剩余并发额度，
 * 从而真正支持多任务并行执行（runtime_jobs 仍是权威业务状态）。
 */
const inFlightJobs = new Set<string>();

/**
 * 进程内 dispatch 护栏：dispatch 帧可由主循环、独立 setInterval、以及任务结束后的
 * setImmediate 补位三处叠加触发。这里把多源触发收敛为「最多一帧在跑 + 至多一次待补位」，
 * 避免重入放大领取/对账成本，同时防止额度计算与领取之间被其它帧穿插。
 */
let isDispatching = false;
let pendingRetrigger = false;

/**
 * runtime job 的全量对账（lease 过期回收 + 状态投影对账）。开销较重，已从「每个
 * dispatch 帧」下沉到固定低频节拍（由 daemonRunner 的 reconcile interval 调用），
 * dispatch 帧只做领取与启动。
 */
export function reconcileRuntimeJobLeasesAndProjections() {
  const expiredJobs = releaseExpiredRuntimeJobLeases();
  expiredJobs.forEach((job) => {
    projectRuntimeJobStatusProjection({
      job,
      status: "queued",
      reason: "任务 lease 已过期，重新进入队列",
    });
  });
  reconcileRuntimeJobStatusProjections({
    statuses: ["queued", "running", "awaiting_user"],
  });
}

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

type DeviceState = ReturnType<typeof ensureDeviceState>;

export async function runTaskDispatchWorker(leaseOwner: string): Promise<{
  processed: number;
  inFlight: number;
}> {
  // 护栏：若已有一帧在跑，仅标记待补位并立即返回，由当前帧结束后统一补跑一次。
  if (isDispatching) {
    pendingRetrigger = true;
    return { processed: 0, inFlight: inFlightJobs.size };
  }
  isDispatching = true;
  try {
    return dispatchFrame(leaseOwner);
  } finally {
    isDispatching = false;
    if (pendingRetrigger) {
      pendingRetrigger = false;
      // 补位帧 fire-and-forget，避免递归占用当前调用栈；护栏保证不会无限叠加。
      setImmediate(() => {
        void runTaskDispatchWorker(leaseOwner).catch(() => {
          // 补位失败不影响主调度帧，错误已在主帧路径记录。
        });
      });
    }
  }
}

/**
 * 单次领取-启动帧。额度计算与领取在同一同步段内完成（中间不 await），
 * 配合 isDispatching 护栏，保证进程内并行数不会突破 maxConcurrentTasks。
 */
function dispatchFrame(leaseOwner: string): { processed: number; inFlight: number } {
  const config = readRuntimeDaemonConfig();
  const device = ensureDeviceState(config.deviceId);

  // 按剩余并发额度领取：最多领取 maxConcurrentTasks - 当前在执行数。
  const available = Math.max(0, config.maxConcurrentTasks - inFlightJobs.size);
  if (available === 0) {
    return { processed: 0, inFlight: inFlightJobs.size };
  }

  const claimed = claimQueuedRuntimeJobs({
    leaseOwner,
    limit: available,
  });
  if (claimed.length === 0) {
    if (inFlightJobs.size === 0) {
      writeRuntimeDaemonState({
        deviceId: device.deviceId,
        status: "idle",
        lastHeartbeatAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return { processed: 0, inFlight: inFlightJobs.size };
  }

  // fire-and-forget 并行执行：领取后立即返回，避免阻塞后续调度帧补位空闲额度。
  for (const job of claimed) {
    inFlightJobs.add(job.id);
    void executeClaimedJob({ job, leaseOwner, config, device }).finally(() => {
      inFlightJobs.delete(job.id);
      // 任务结束立即触发一次补位领取，避免空出的并发额度要干等到下一个调度帧
      // （最长 schedulerIntervalMs）。护栏会把并发补位收敛为至多一帧。
      void runTaskDispatchWorker(leaseOwner).catch(() => {
        // 补位失败不影响主调度帧，错误已在主帧路径记录。
      });
    });
  }

  return { processed: claimed.length, inFlight: inFlightJobs.size };
}

async function executeClaimedJob(params: {
  job: RuntimeJobRecord;
  leaseOwner: string;
  config: RuntimeDaemonConfig;
  device: DeviceState;
}) {
  const { job, leaseOwner, config, device } = params;
  projectRuntimeJobStatusProjection({
    job,
    status: "running",
    reason: "worker 已领取任务并开始执行",
  });
  writeRuntimeDaemonState({
    deviceId: device.deviceId,
    status: "running",
    lastHeartbeatAt: new Date().toISOString(),
    lastJobId: job.id,
    updatedAt: new Date().toISOString(),
  });
  appendRuntimeDaemonLog(`开始执行任务 ${job.id}`);
  let renewTimer: NodeJS.Timeout | null = null;
  let leaseLostMessage: string | null = null;
  const abortController = new AbortController();
  const requestId = job.requestId ?? `goal-task-${Date.now()}`;
  executionSupervisor.registerJob({
    requestId,
    jobId: job.id,
    leaseOwner,
    abortController,
    maxDurationMs: config.jobMaxDurationMs,
    idleTimeoutMs: config.jobIdleTimeoutMs,
  });
  try {
    const conversationId = job.conversationId ?? job.payload.goal.conversationId;
    const conversationWorkspaceDir = conversationId
      ? job.payload.conversationWorkspaceDir ?? ensureConversationWorkspace(conversationId).workspaceDir
      : job.payload.conversationWorkspaceDir;
    const taskWorkspaceDir =
      job.payload.taskWorkspaceDir ??
      (conversationId
        ? ensureTaskWorkspace({
            conversationId,
            taskId: job.payload.task.id,
            instanceId: job.payload.instance.id,
          })
        : undefined);
    renewTimer = setInterval(() => {
      try {
        const renewResult = renewRuntimeJobLease(job.id, {
          leaseOwner,
          leaseMs: LEASE_RENEW_DURATION_MS,
        });
        if (!renewResult.renewed) {
          leaseLostMessage = `任务 ${job.id} 续租失败：lease 已被其他 owner 占用或任务已不在 running 状态`;
          // 统一交由 ExecutionSupervisor 中止，由 transport 的 abort 监听强杀进程组。
          executionSupervisor.abortJob(requestId, leaseLostMessage);
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
    // 续租定时器 unref 并纳入 supervisor 生命周期：与 durationTimer 行为一致，
    // 极端路径下（finally 未执行）由 supervisor 销账时统一清理，避免残留 interval 阻止进程退出。
    renewTimer.unref?.();
    executionSupervisor.attachRenewTimer(requestId, renewTimer);
    await runGoalTask({
      requestId,
      goal: job.payload.goal,
      subGoal: job.payload.subGoal,
      task: job.payload.task,
      instance: job.payload.instance,
      runtimeEnv: job.payload.runtimeEnv,
      conversationWorkspaceDir,
      taskWorkspaceDir,
      resumeContext: job.payload.resumeContext,
      initialTrajectory: job.payload.resumeContext ? job.trajectory : [],
      signal: abortController.signal,
      onProgressPing: (kind) => executionSupervisor.markProgress(requestId, kind),
      onSpawn: (pid) => executionSupervisor.attachProcess(requestId, pid),
    });
    if (abortController.signal.aborted) {
      throw new Error(leaseLostMessage || `任务 ${job.id} 已因 lease 失效或超时中断`);
    }

    const latestProgress = getGoalTelemetryProgress(requestId);
    const latestLogs = job.taskInstanceId ? getTaskTelemetryLogs(job.taskInstanceId) : [];
    const runTrajectory = Array.isArray(latestProgress?.resultPayload?.trajectory)
      ? (latestProgress.resultPayload.trajectory as typeof job.trajectory)
      : null;
    const latestTrajectory = runTrajectory
      ? (job.payload.resumeContext
          ? job.trajectory.concat(runTrajectory).filter((step, index, all) => all.findIndex((item) => item.id === step.id) === index)
          : runTrajectory)
      : job.trajectory;
    const latestBlocker = latestProgress?.resultPayload?.blocker ?? null;
    if (!isRuntimeJobLeaseHeld(job.id, leaseOwner)) {
      appendRuntimeDaemonLog(`任务 ${job.id} 已失去 lease，跳过结果写回以避免覆盖其他 worker`);
      return;
    }
    if (conversationId) {
      writeTaskRunSnapshot({
        conversationId,
        taskId: job.payload.task.id,
        instanceId: job.payload.instance.id,
        progress: latestProgress,
        trajectory: latestTrajectory,
        result: latestProgress?.resultPayload ?? null,
      });
    }
    const nextStatus =
      latestProgress?.status === "failed"
        ? "failed"
        : latestProgress?.resultPayload?.awaitingUser || latestBlocker
          ? "awaiting_user"
          : "completed";
    updateGoalRuntimeJobExecution(job.id, {
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
    writeDaemonStateAfterJob(device, job.id);
    appendRuntimeDaemonLog(
      nextStatus === "failed"
        ? `任务 ${job.id} 执行失败: ${latestProgress?.error || "任务未达到完成标准"}`
        : latestBlocker
          ? `任务 ${job.id} 等待用户确认`
          : `任务 ${job.id} 执行完成`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "后台任务执行失败";
    if (abortController.signal.aborted && !isRuntimeJobLeaseHeld(job.id, leaseOwner)) {
      appendRuntimeDaemonLog(`任务 ${job.id} 已因 lease 失效中断，跳过失败状态写回: ${message}`);
      return;
    }
    const failedJob = job.requestId ? getRuntimeJobByRequestId(job.requestId) : null;
    const latestProgress = getGoalTelemetryProgress(requestId) ?? failedJob?.progress ?? null;
    const latestLogs = job.taskInstanceId ? getTaskTelemetryLogs(job.taskInstanceId) : [];
    const runTrajectory = Array.isArray(latestProgress?.resultPayload?.trajectory)
      ? (latestProgress.resultPayload.trajectory as typeof job.trajectory)
      : null;
    const latestTrajectory = runTrajectory
      ? (job.payload.resumeContext
          ? job.trajectory.concat(runTrajectory).filter((step, index, all) => all.findIndex((item) => item.id === step.id) === index)
          : runTrajectory)
      : job.trajectory;
    updateGoalRuntimeJobExecution(job.id, {
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
    // 统一销账：清理 supervisor 内存态（含总时长计时器），避免泄漏。
    executionSupervisor.completeJob(requestId);
  }
}

/**
 * 单个 job 正常结束后刷新 daemon 状态：仅当本进程已无其它在执行任务时才置 idle，
 * 否则保持 running，避免并行场景下被某个先完成的任务误标为空闲。
 */
function writeDaemonStateAfterJob(device: DeviceState, jobId: string) {
  const now = new Date().toISOString();
  const stillBusy = Array.from(inFlightJobs).some((id) => id !== jobId);
  writeRuntimeDaemonState({
    deviceId: device.deviceId,
    status: stillBusy ? "running" : "idle",
    lastHeartbeatAt: now,
    lastJobId: jobId,
    lastJobFinishedAt: now,
    updatedAt: now,
  });
}
