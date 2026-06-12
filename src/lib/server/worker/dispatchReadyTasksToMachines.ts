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
  setTunnelExecuteProgressListener,
  setTunnelExecuteResultListener,
} from "@/lib/server/tunnel/tunnelHub";
import {
  claimQueuedRuntimeJobs,
  getRuntimeJob,
  renewRuntimeJobLease,
  type RuntimeJobRecord,
} from "@/lib/server/repositories/runtimeJobsRepository";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";

const LEASE_RENEW_INTERVAL_MS = 30_000;
const LEASE_RENEW_DURATION_MS = 2 * 60 * 1000;
const DEFAULT_TUNNEL_LEASE_OWNER = "cloud-orchestrator";

type ActiveTunnelDispatch = {
  job: RuntimeJobRecord;
  leaseOwner: string;
  userId: string;
  machineId: string;
  renewTimer: NodeJS.Timeout;
};

const inFlightTunnelJobs = new Set<string>();
const activeTunnelDispatches = new Map<string, ActiveTunnelDispatch>();
const MAX_TUNNEL_PROGRESS_LOGS = 200;

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

function completeTunnelJob(input: {
  jobId: string;
  ok: boolean;
  error?: string;
  status?: "completed" | "failed" | "awaiting_user";
  blocker?: unknown;
  trajectory?: unknown;
  result?: Record<string, unknown> | null;
}) {
  const active = activeTunnelDispatches.get(input.jobId);
  if (!active) return;

  // 终态以 daemon 回传的结构化 status 为准；缺省（旧版 daemon 瘦回执）回退按 ok 推断。
  const status = input.status ?? (input.ok ? "completed" : "failed");
  // 仅在回传非空轨迹时覆盖，避免空数组冲掉云端 job 下发时的初始 trajectory 快照。
  const trajectory =
    Array.isArray(input.trajectory) && input.trajectory.length > 0
      ? (input.trajectory as ExecutionTrajectoryStep[])
      : undefined;
  const blocker = (input.blocker as ExecutionBlocker | null | undefined) ?? undefined;
  const now = new Date().toISOString();
  const finalProgress =
    input.result !== undefined
      ? ({
          requestId: active.job.requestId ?? `goal-task-${active.job.id}`,
          scope: "goal_task_execute" as const,
          status: status === "failed" ? "failed" : "completed",
          phase: status === "failed" ? "error" : status === "awaiting_user" ? "reviewing" : "completed",
          message:
            typeof input.result?.finalMessage === "string"
              ? input.result.finalMessage
              : status === "failed"
                ? input.error ?? "本地 machine 执行失败"
                : status === "awaiting_user"
                  ? "任务执行已暂停，等待用户补充必要信息"
                  : "任务执行完成",
          startedAt: active.job.startedAt ?? active.job.createdAt,
          updatedAt: now,
          finishedAt: now,
          error: status === "failed" ? input.error ?? "本地 machine 执行失败" : undefined,
          goalId: active.job.goalId,
          taskId: active.job.taskId,
          taskInstanceId: active.job.taskInstanceId,
          resultPayload: input.result,
        } satisfies GoalServerProgress)
      : undefined;

  runWithUserContext(active.userId, () => {
    if (status === "awaiting_user") {
      // 本机执行后产出 blocker（如缺少用户补充信息），落 awaiting_user 并把 blocker/result
      // 投影到 UI，避免任务永远停留在「等待 Agent 开始执行」的悬空态。
      updateGoalRuntimeJobExecution(active.job.id, {
        status: "awaiting_user",
        ...(blocker !== undefined ? { blocker } : {}),
        ...(finalProgress !== undefined ? { progress: finalProgress } : {}),
        ...(trajectory !== undefined ? { trajectory } : {}),
        ...(input.result !== undefined ? { result: input.result } : {}),
        lastError: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
      });
      return;
    }
    updateGoalRuntimeJobExecution(active.job.id, {
      status: status === "completed" ? "completed" : "failed",
      ...(blocker !== undefined ? { blocker } : {}),
      ...(finalProgress !== undefined ? { progress: finalProgress } : {}),
      ...(trajectory !== undefined ? { trajectory } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
      lastError: status === "completed" ? undefined : input.error ?? "本地 machine 执行失败",
      finishedAt: new Date().toISOString(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    if (status === "failed") {
      projectRuntimeJobStatusProjection({
        job: active.job,
        status: "failed",
        reason: input.error ?? "本地 machine 执行失败",
      });
    }
  });
  finishTunnelDispatch(input.jobId);
}

function mergeRuntimeJobLogs(existing: GoalServerLogEntry[], next?: GoalServerLogEntry) {
  if (!next) return existing;
  if (existing.some((entry) => entry.id === next.id)) return existing;
  return [...existing, next].slice(-MAX_TUNNEL_PROGRESS_LOGS);
}

function logStatusToTrajectoryStatus(status: GoalServerLogEntry["status"]): ExecutionTrajectoryStep["status"] {
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  if (status === "awaiting_user") return "awaiting_user";
  return "running";
}

function logToTrajectoryStep(log: GoalServerLogEntry, index: number): ExecutionTrajectoryStep {
  const isToolLike = log.eventType === "tool_call_started" || log.eventType === "tool_call_finished" || Boolean(log.toolName);
  return {
    id: `remote-log-${log.id}`,
    index,
    type: isToolLike ? "tool_call" : log.status === "completed" ? "result" : "assistant",
    status: logStatusToTrajectoryStatus(log.status),
    title: log.message,
    thought: log.details,
    ...(log.toolName ? { toolCall: { name: log.toolName, summary: log.message } } : {}),
    startedAt: log.timestamp,
    ...(log.status === "completed" || log.status === "failed" || log.status === "awaiting_user"
      ? { endedAt: log.timestamp }
      : {}),
  };
}

function mergeRuntimeJobTrajectoryFromLog(existing: ExecutionTrajectoryStep[], log?: GoalServerLogEntry) {
  if (!log) return undefined;
  const stepId = `remote-log-${log.id}`;
  if (existing.some((step) => step.id === stepId)) return existing;
  const next = logToTrajectoryStep(log, existing.length);
  return [...existing, next].slice(-MAX_TUNNEL_PROGRESS_LOGS).map((step, index) => ({ ...step, index }));
}

function handleTunnelJobProgress(input: {
  jobId: string;
  progress?: GoalServerProgress;
  log?: GoalServerLogEntry;
  trajectory?: ExecutionTrajectoryStep[];
}) {
  const active = activeTunnelDispatches.get(input.jobId);
  if (!active) return;
  runWithUserContext(active.userId, () => {
    const current = getRuntimeJob(input.jobId) ?? active.job;
    const logs = input.log ? mergeRuntimeJobLogs(current.logs, input.log) : undefined;
    const trajectoryFromLog = input.log ? mergeRuntimeJobTrajectoryFromLog(current.trajectory, input.log) : undefined;
    const trajectory = input.trajectory && input.trajectory.length > 0 ? input.trajectory : trajectoryFromLog;
    const next = updateGoalRuntimeJobExecution(input.jobId, {
      ...(input.progress ? { progress: input.progress } : {}),
      ...(logs ? { logs } : {}),
      ...(trajectory && trajectory.length > 0 ? { trajectory } : {}),
      lastError: undefined,
    });
    if (next) activeTunnelDispatches.set(input.jobId, { ...active, job: next });
  });
}

function handleMachineDisconnected(machineId: string) {
  Array.from(activeTunnelDispatches.entries()).forEach(([jobId, active]) => {
    if (active.machineId !== machineId) return;
    requeueTunnelJob(active, `machine ${machineId} 连接已断开，任务重新入队`);
    finishTunnelDispatch(jobId);
  });
}

function createRenewTimer(jobId: string, machineId: string, userId: string, leaseOwner: string) {
  return setInterval(() => {
    const hub = getTunnelHub();
    if (!hub.isMachineOnline(machineId, userId)) {
      const active = activeTunnelDispatches.get(jobId);
      if (active) {
        requeueTunnelJob(active, `machine ${machineId} 已离线，任务重新入队`);
        finishTunnelDispatch(jobId);
      }
      return;
    }
    runWithUserContext(userId, () => {
      renewRuntimeJobLease(jobId, {
        leaseOwner,
        leaseMs: LEASE_RENEW_DURATION_MS,
      });
    });
  }, LEASE_RENEW_INTERVAL_MS);
}

export function reconcileMachineTunnelHello(input: {
  machineId: string;
  userId: string;
  runningJobIds: string[];
}) {
  const uniqueJobIds = Array.from(new Set(input.runningJobIds));
  for (const jobId of uniqueJobIds) {
    if (activeTunnelDispatches.has(jobId)) continue;
    runWithUserContext(input.userId, () => {
      const job = getRuntimeJob(jobId);
      if (!job) return;
      if (job.userId !== input.userId) return;
      if (job.runtimeTransport !== "cloud_control_plane") return;
      // awaiting_user 同属"执行已结束"语义（本机已 return，等待用户补充信息），
      // daemon 正常不会在 runningJobIds 中上报它；此处一并跳过做防御，避免误恢复为 running。
      if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "cancelled" ||
        job.status === "awaiting_user"
      )
        return;

      const leaseOwner = job.leaseOwner || DEFAULT_TUNNEL_LEASE_OWNER;
      const nextJob =
        job.status === "running"
          ? job
          : updateGoalRuntimeJobExecution(job.id, {
              status: "running",
              lastError: undefined,
              leaseOwner,
              leaseExpiresAt: new Date(Date.now() + LEASE_RENEW_DURATION_MS).toISOString(),
            }) ?? job;

      orchestratorConcurrencyBudget.acquire(input.userId, 1);
      inFlightTunnelJobs.add(job.id);
      activeTunnelDispatches.set(job.id, {
        job: nextJob,
        leaseOwner,
        userId: input.userId,
        machineId: input.machineId,
        renewTimer: createRenewTimer(job.id, input.machineId, input.userId, leaseOwner),
      });
    });
  }
}

export function registerTunnelDispatchCallbacks() {
  setTunnelExecuteResultListener(completeTunnelJob);
  setTunnelExecuteProgressListener(handleTunnelJobProgress);
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
    if (!hub.isMachineOnline(machineId, userId)) {
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
    activeTunnelDispatches.set(job.id, {
      job,
      leaseOwner: input.leaseOwner,
      userId,
      machineId,
      renewTimer: createRenewTimer(job.id, machineId, userId, input.leaseOwner),
    });

    runWithUserContext(userId, () => {
      const now = new Date().toISOString();
      updateGoalRuntimeJobExecution(job.id, {
        progress: {
          requestId,
          scope: "goal_task_execute",
          status: "running",
          phase: "executing",
          message: "任务已下发到本地 machine，等待 Agent 启动执行。",
          startedAt: job.startedAt ?? now,
          updatedAt: now,
          goalId: job.goalId,
          taskId: job.taskId,
          taskInstanceId: job.taskInstanceId,
        },
      });
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
