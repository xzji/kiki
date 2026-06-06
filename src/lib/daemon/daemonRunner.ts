import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { appendRuntimeDaemonLog, readRuntimeDaemonState, writeRuntimeDaemonState } from "@/lib/daemon/daemonState";
import { getDatabase, getDatabaseRuntimeInfo } from "@/lib/server/db/client";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readGoalsSnapshot, readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { runGoalSchedulerEngine } from "@/lib/server/worker/goalSchedulerEngine";
import { runGoalDaemonSideEffects } from "@/lib/server/worker/goalNotificationWorker";
import { runRecoveryWorker } from "@/lib/server/worker/recoveryWorker";
import {
  reconcileRuntimeJobLeasesAndProjections,
  runTaskDispatchWorker,
} from "@/lib/server/worker/taskDispatchWorker";
import { executionSupervisor } from "@/lib/server/worker/executionSupervisor";
import { createClaudeJsonInvoke } from "@/lib/server/agentRuntime/claudeJsonInvoke";
import {
  createThreadLoopDaemon,
  type ThreadLoopDaemon,
} from "@/lib/server/scheduler/threadLoopDaemon";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { RuntimeEnvironment } from "@/types/runtime";

/** ExecutionSupervisor 对账节拍：每 30s 检查一次在管 job 的超时与 DB 所有权。 */
const RECONCILE_INTERVAL_MS = 30 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectLocalRuntimeEnv(): RuntimeEnvironment | null {
  const runtimeEnvironments = readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS);
  return (
    runtimeEnvironments.find((environment) => environment.isDefault && environment.type === "local") ??
    runtimeEnvironments.find((environment) => environment.type === "local") ??
    null
  );
}

/**
 * Build a thread_runner LlmInvoke that lazily resolves the current
 * runtimeEnv at each call — this keeps semantics consistent with
 * `runGoalSchedulerEngine` which re-reads runtimeEnv every loop tick.
 */
function buildThreadRunnerInvoke(): LlmInvoke {
  return async (request) => {
    const runtimeEnv = selectLocalRuntimeEnv();
    if (!runtimeEnv) {
      throw new Error("thread_runner: no local runtimeEnv available");
    }
    const innerInvoke = createClaudeJsonInvoke<Record<string, unknown>>({
      cwd: process.cwd(),
      runtimeEnv,
      validator: (value) => {
        if (!value || typeof value !== "object") {
          throw new Error("thread_runner: expected JSON object");
        }
        return value as Record<string, unknown>;
      },
    });
    return innerInvoke(request);
  };
}

export function recordThreadLoopDaemonStartedLog(appendLog = appendRuntimeDaemonLog) {
  appendLog("threadLoopDaemon: started");
}

export async function runRuntimeDaemonLoop() {
  const config = readRuntimeDaemonConfig();
  appendRuntimeDaemonLog("KiKi Runtime Daemon 已启动");
  // 启动自检：记录 worker 实际打开的数据库路径与 inode，便于排查
  // 「worker 与前端读写不同物理文件」的 inode 漂移问题。
  try {
    getDatabase();
    const info = getDatabaseRuntimeInfo();
    appendRuntimeDaemonLog(`db 自检：path=${info.path} inode=${info.inode}`);
  } catch (err) {
    appendRuntimeDaemonLog(`db 自检失败 ${err instanceof Error ? err.message : String(err)}`);
  }
  runRecoveryWorker();
  // 启动时立即做一次对账，避免到首个 reconcile 节拍（30s）前 lease 过期任务无人回收。
  try {
    reconcileRuntimeJobLeasesAndProjections();
  } catch (err) {
    appendRuntimeDaemonLog(
      `startup runtime job reconcile error ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  setInterval(() => {
    const now = new Date().toISOString();
    const current = readRuntimeDaemonState();
    const dbInfo = getDatabaseRuntimeInfo();
    writeRuntimeDaemonState({
      deviceId: current?.deviceId ?? config.deviceId,
      status: current?.status ?? "idle",
      lastHeartbeatAt: now,
      lastJobId: current?.lastJobId,
      lastJobFinishedAt: current?.lastJobFinishedAt,
      lastError: current?.lastError,
      dbPath: dbInfo.path,
      dbInode: dbInfo.inode,
      updatedAt: now,
    });
  }, config.heartbeatIntervalMs);

  // ThreadLoopDaemon 在主循环之外独立 setInterval；它内部的 invoke
  // 工厂会在每次调用时按需重读最新 runtimeEnv，无需等待主循环刷新。
  const threadLoopDaemon: ThreadLoopDaemon = createThreadLoopDaemon(
    { invoke: buildThreadRunnerInvoke() },
    {
      tickIntervalMs: config.schedulerIntervalMs,
      onError: (err) => {
        appendRuntimeDaemonLog(
          `threadLoopDaemon: frame error ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    },
  );
  threadLoopDaemon.start();
  recordThreadLoopDaemonStartedLog();

  // 调度与执行解耦：dispatch 放在独立 setInterval，避免某帧任务执行 hang 住
  // 拖死整个调度循环（历史根因）。runTaskDispatchWorker 自身按
  // `maxConcurrentTasks - 在执行数` 领取并 fire-and-forget 并行执行，领取后立即返回，
  // 因此每帧可安全重入以补位空闲并发额度；这里不再需要 in-flight 串行护栏。
  const runDispatchFrame = () => {
    void runTaskDispatchWorker(config.deviceId).catch((err) => {
      appendRuntimeDaemonLog(
        `dispatch frame error ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  setInterval(runDispatchFrame, config.schedulerIntervalMs);

  // 执行生命周期对账：周期性检查空闲超时 / 总时长超时 / DB 所有权丢失，
  // 命中即中止对应子进程（进程组强杀）。这是「删会话 ≤30s 杀进程」与
  // 「空闲看门狗」真正生效的驱动节拍。
  setInterval(() => {
    try {
      // 全量对账下沉到本低频节拍：lease 过期回收 + runtime job 状态投影对账。
      // dispatch 帧只做领取与启动，不再每帧重复执行重量级全表对账。
      reconcileRuntimeJobLeasesAndProjections();
    } catch (err) {
      appendRuntimeDaemonLog(
        `runtime job reconcile error ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      executionSupervisor.reconcileJobOwnership();
    } catch (err) {
      appendRuntimeDaemonLog(
        `supervisor reconcile error ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, RECONCILE_INTERVAL_MS);

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

    // 调度帧刚创建 queued job 后立即触发一次执行帧，但不 await；
    // 否则新建任务最坏要等到下一个 dispatch interval 才开始执行。
    runDispatchFrame();

    const now = new Date().toISOString();
    const current = readRuntimeDaemonState();
    const dbInfo = getDatabaseRuntimeInfo();
    writeRuntimeDaemonState({
      deviceId: current?.deviceId ?? config.deviceId,
      status: current?.status === "running" ? "running" : "idle",
      lastHeartbeatAt: now,
      lastJobId: current?.lastJobId,
      lastJobFinishedAt: current?.lastJobFinishedAt,
      lastError: current?.status === "running" ? current.lastError : undefined,
      dbPath: dbInfo.path,
      dbInode: dbInfo.inode,
      updatedAt: now,
    });
    appendRuntimeDaemonLog(
      `本轮调度结束，新增队列任务 ${schedulerResult.createdJobs} 个，跳过 ${schedulerResult.skipped} 个，派生日程 ${sideEffectsResult.schedule.synthesized} 个，投递通知 ${sideEffectsResult.notifications.delivered} 个，暂停超时 ${sideEffectsResult.watchdog.paused} 个`,
    );
    await sleep(config.schedulerIntervalMs);
  }
}
