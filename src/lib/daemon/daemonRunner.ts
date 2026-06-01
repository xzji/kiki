import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { appendRuntimeDaemonLog, readRuntimeDaemonState, writeRuntimeDaemonState } from "@/lib/daemon/daemonState";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readGoalsSnapshot, readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { runGoalSchedulerEngine } from "@/lib/server/worker/goalSchedulerEngine";
import { runGoalDaemonSideEffects } from "@/lib/server/worker/goalNotificationWorker";
import { runRecoveryWorker } from "@/lib/server/worker/recoveryWorker";
import { runTaskDispatchWorker } from "@/lib/server/worker/taskDispatchWorker";
import { createClaudeJsonInvoke } from "@/lib/server/agentRuntime/claudeJsonInvoke";
import {
  createThreadLoopDaemon,
  type ThreadLoopDaemon,
} from "@/lib/server/scheduler/threadLoopDaemon";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { RuntimeEnvironment } from "@/types/runtime";

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
