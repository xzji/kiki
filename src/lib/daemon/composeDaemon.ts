/**
 * composeDaemon — 本地 KiKi Runtime Daemon 顶层装配（PR refactor §3-A/D）。
 *
 * 把四个独立 runner 拼起来：
 *  1. taskSchedulingRunner —— 主 while 调度（建 queued job + side effects + heartbeat）
 *  2. taskDispatchRunner —— 独立 setInterval 拉 queued job 并 fire-and-forget 执行
 *  3. taskReconcileRunner —— 30s 节拍对账 lease 与本地子进程 ownership
 *  4. ThreadLoopDaemon（治理层 runner）—— 独立 setInterval 跑 thread tick
 *
 * 入口（`runRuntimeDaemonLoop`）只负责：
 *  - 读 config / 打启动自检日志（tz / db inode）
 *  - 启动时立即跑一次 lease 对账（避免到 30s 节拍前过期 lease 无人回收）
 *  - 启动 4 个 runner 与心跳 setInterval
 *  - 进入 schedulingRunner.start()（永不 resolve）
 *
 * 不再在主入口内联业务逻辑；全部 runner 解耦后单独可测/可复用（云端复用 dispatch +
 * reconcile，不复用 scheduling 主 while 与治理层 runner）。
 */

import {
  DEFAULT_LOCAL_USER_ID,
  hasUserContext,
  runWithUserContext,
} from "@/lib/server/context/userContext";
import { readRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import {
  appendRuntimeDaemonLog,
  readRuntimeDaemonState,
  writeRuntimeDaemonState,
} from "@/lib/daemon/daemonState";
import { getDatabase, getDatabaseRuntimeInfo } from "@/lib/server/db/client";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { runRecoveryWorker } from "@/lib/server/scheduling/recoveryWorker";
import { reconcileRuntimeJobLeasesAndProjections } from "@/lib/server/scheduling/taskDispatchWorker";
import { createTaskSchedulingRunner } from "@/lib/server/scheduling/taskSchedulingRunner";
import { createTaskDispatchRunner } from "@/lib/server/scheduling/taskDispatchRunner";
import { createTaskReconcileRunner } from "@/lib/server/scheduling/taskReconcileRunner";
import { createClaudeJsonInvoke } from "@/lib/server/agentRuntime/claudeJsonInvoke";
import {
  createThreadLoopDaemon,
  type ThreadLoopDaemon,
} from "@/lib/server/governance/threadGovernanceRunner";
import { describeSchedulingTimezone } from "@/lib/runtime/schedulingTimezone";
import {
  NAMESPACE,
  logScheduling,
} from "@/lib/server/observability/schedulingLog";
import {
  frameError as logLoopFrameError,
  frameSummary as logLoopFrameSummary,
} from "@/lib/server/observability/loopTickLog";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { RuntimeEnvironment } from "@/types/runtime";

function withDaemonUserContext<T>(fn: () => T): T {
  if (hasUserContext()) return fn();
  return runWithUserContext(DEFAULT_LOCAL_USER_ID, fn);
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
 * 构造 thread_runner 用的 LlmInvoke：每次调用按需重读最新 runtimeEnv，
 * 与主调度循环每帧重读 runtimeEnv 的语义一致。
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

export function composeDaemon() {
  const config = readRuntimeDaemonConfig();

  // 1. 启动横幅 + 自检
  appendRuntimeDaemonLog("KiKi Runtime Daemon 已启动");
  const tzInfo = describeSchedulingTimezone();
  appendRuntimeDaemonLog(
    `tz applied=${tzInfo.applied} requested=${tzInfo.requested ?? "<unset>"} intl=${tzInfo.intlResolved}`,
  );
  try {
    withDaemonUserContext(() => {
      getDatabase();
      const info = getDatabaseRuntimeInfo();
      appendRuntimeDaemonLog(`db 自检：path=${info.path} inode=${info.inode}`);
    });
  } catch (err) {
    appendRuntimeDaemonLog(`db 自检失败 ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. recovery + 启动时立即对账（节拍前防过期 lease 无人回收）
  withDaemonUserContext(() => runRecoveryWorker());
  try {
    withDaemonUserContext(() => reconcileRuntimeJobLeasesAndProjections());
  } catch (err) {
    logScheduling(
      NAMESPACE.task.reconcileLease,
      `startup reconcile error ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3. 心跳 setInterval（独立节拍；写 daemon_state.lastHeartbeatAt）
  setInterval(() => {
    withDaemonUserContext(() => {
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
    });
  }, config.heartbeatIntervalMs);

  // 4. 治理层 runner（本地独占 owner；D1=B 路线下云端不装配）
  const threadLoopDaemon: ThreadLoopDaemon = createThreadLoopDaemon(
    { invoke: buildThreadRunnerInvoke() },
    {
      tickIntervalMs: config.schedulerIntervalMs,
      wrapTick: async (fn) => withDaemonUserContext(() => fn()),
      onFrameSettled: (outcome) => {
        if (outcome.ticked.length === 0 && outcome.frameErrors.length === 0) return;
        const failureReasons: Record<string, number> = {};
        let okCount = 0;
        for (const tick of outcome.ticked) {
          if (tick.ok) {
            okCount += 1;
          } else if (tick.failureReason) {
            const key = tick.failureReason.split(":")[0]?.trim() || "unknown";
            failureReasons[key] = (failureReasons[key] ?? 0) + 1;
          }
        }
        logLoopFrameSummary({
          kind: "thread",
          ticked: outcome.ticked.length,
          ok: okCount,
          frameErrors: outcome.frameErrors.length,
          skipReasons: Object.keys(failureReasons).length > 0 ? failureReasons : undefined,
        });
      },
      onError: (err) => {
        logLoopFrameError({
          kind: "thread",
          message: `frame error ${err instanceof Error ? err.message : String(err)}`,
        });
      },
    },
  );
  threadLoopDaemon.start();
  recordThreadLoopDaemonStartedLog();

  // 5. dispatch runner（独立节拍 + 暴露 runDispatchFrame 给 schedulingRunner）
  const dispatchRunner = createTaskDispatchRunner({
    deviceId: config.deviceId,
    intervalMs: config.schedulerIntervalMs,
    wrapTick: withDaemonUserContext,
  });
  dispatchRunner.start();

  // 6. reconcile runner（30s 节拍）
  const reconcileRunner = createTaskReconcileRunner({
    wrapTick: withDaemonUserContext,
    withProcessSupervisor: true,
  });
  reconcileRunner.start();

  // 7. scheduling runner（主 while；永不 resolve）
  const schedulingRunner = createTaskSchedulingRunner({
    config,
    wrapTick: withDaemonUserContext,
    runDispatchFrame: dispatchRunner.runDispatchFrame,
    onTickSettled: () => {
      withDaemonUserContext(() => {
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
      });
    },
  });

  return {
    config,
    schedulingRunner,
    dispatchRunner,
    reconcileRunner,
    threadLoopDaemon,
  };
}

export async function runRuntimeDaemonLoop() {
  const { schedulingRunner } = composeDaemon();
  // 主 while；进入后永不 resolve（除非内部抛错冒泡）。
  await schedulingRunner.start();
}
