/**
 * taskSchedulingRunner — 任务调度层主循环（PR refactor §3-A）。
 *
 * 职责：周期性跑 `runGoalSchedulerEngine`（建 queued job）+ `runGoalDaemonSideEffects`
 * （schedule synth / notifications / watchdog），并触发一次"调度后立即 dispatch"以
 * 避免新建任务等到下一个 dispatch 节拍才被领走。
 *
 * 与 `taskDispatchRunner` 的关系：
 *  - 本 runner 在每帧 schedule 完调用 `runDispatchFrame`（注入），不持有 dispatch 节拍；
 *  - 独立的 dispatch interval 保持 fire-and-forget 语义。
 *
 * 设计要点：
 *  - **不**直接调 setInterval；用 while + sleep 维持串行帧节奏（与 daemonRunner 历史
 *    一致：每帧 schedule + side effects 必须串行，避免重复建 job）。
 *  - 用户上下文由调用方注入 `wrapTick`（本地 daemon 注入 DEFAULT_LOCAL_USER_ID）。
 *  - 心跳的 lastJobId/lastJobFinishedAt 透传由 `onTickSettled` 回调向外暴露——
 *    runner 本身不写 daemon_state。
 */

import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readGoalsSnapshot, readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { runGoalSchedulerEngine } from "@/lib/server/scheduling/taskScheduler";
import { runGoalDaemonSideEffects } from "@/lib/server/scheduling/goalSideEffects";
import {
  NAMESPACE,
  logTickSummary,
} from "@/lib/server/observability/schedulingLog";
import type { RuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import type { RuntimeEnvironment } from "@/types/runtime";

export type TaskSchedulingRunnerOptions = {
  config: RuntimeDaemonConfig;
  /** 注入用户上下文（本地 daemon 用 DEFAULT_LOCAL_USER_ID）。 */
  wrapTick: <T>(fn: () => T) => T;
  /** 调度帧建完 queued job 立即触发一次 dispatch（fire-and-forget）。 */
  runDispatchFrame: () => void;
  /** 帧结束回调，调用方可用来更新 daemon_state heartbeat 之类。可选。 */
  onTickSettled?: () => void;
};

export type TaskSchedulingRunnerHandle = {
  /** 启动 runner（async loop，永不 resolve；调用方一般不 await）。 */
  start: () => Promise<void>;
};

function selectLocalRuntimeEnv(): RuntimeEnvironment | null {
  const runtimeEnvironments = readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS);
  return (
    runtimeEnvironments.find((environment) => environment.isDefault && environment.type === "local") ??
    runtimeEnvironments.find((environment) => environment.type === "local") ??
    null
  );
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createTaskSchedulingRunner(
  options: TaskSchedulingRunnerOptions,
): TaskSchedulingRunnerHandle {
  const { config, wrapTick, runDispatchFrame, onTickSettled } = options;

  return {
    async start() {
      // 等价行为保留：原 daemonRunner 主 while 没有顶层 try/catch；
      // 内部任意 throw 会终止整个 daemon。这里维持同语义。
      while (true) {
        const runtimeEnv = wrapTick(() => selectLocalRuntimeEnv());
        // allow-raw-goals-snapshot: 调度循环读取结构基准；scheduler/sideEffects 内部再合成 runtime_jobs 执行态。
        const goals = wrapTick(() => readGoalsSnapshot([]));

        const schedulerResult = wrapTick(() =>
          runGoalSchedulerEngine({
            goals,
            runtimeEnv,
            config,
          }),
        );
        const sideEffectsResult = wrapTick(() =>
          runGoalDaemonSideEffects(goals),
        );

        // 调度后立即 dispatch（fire-and-forget），不等下一个 dispatch interval。
        runDispatchFrame();

        onTickSettled?.();

        logTickSummary(NAMESPACE.task.scheduler, {
          created: schedulerResult.createdJobs,
          skipped: schedulerResult.skipped,
          extra: {
            scheduleSynthesized: sideEffectsResult.schedule.synthesized,
            notificationsDelivered: sideEffectsResult.notifications.delivered,
            watchdogPaused: sideEffectsResult.watchdog.paused,
          },
        });

        await sleep(config.schedulerIntervalMs);
      }
    },
  };
}
