/**
 * taskDispatchRunner — 任务调度层 dispatch 节拍（PR refactor §3-C）。
 *
 * 调度与执行解耦的关键节拍：
 *  - 周期性调 `runTaskDispatchWorker(deviceId)`（fire-and-forget）；
 *  - 同时把 `runDispatchFrame` 暴露给 `taskSchedulingRunner`，让调度帧建完 queued job
 *    立刻触发一次 dispatch（不等下一拍）；
 *  - runTaskDispatchWorker 自身按"maxConcurrent - 在执行数"领取并并行执行，领取后立即
 *    返回，因此每帧可安全重入，无需 in-flight 串行护栏（历史根因见 daemonRunner 注释）。
 */

import { runTaskDispatchWorker } from "@/lib/server/scheduling/taskDispatchWorker";
import {
  NAMESPACE,
  logScheduling,
} from "@/lib/server/observability/schedulingLog";

export type TaskDispatchRunnerOptions = {
  deviceId: string;
  intervalMs: number;
  wrapTick: <T>(fn: () => T) => T;
};

export type TaskDispatchRunnerHandle = {
  start: () => void;
  stop: () => void;
  /** 同步触发一次 dispatch 帧（fire-and-forget）；供 schedulingRunner 在调度后立即调用。 */
  runDispatchFrame: () => void;
};

export function createTaskDispatchRunner(
  options: TaskDispatchRunnerOptions,
): TaskDispatchRunnerHandle {
  const { deviceId, intervalMs, wrapTick } = options;
  let timer: NodeJS.Timeout | null = null;

  const runDispatchFrame = () => {
    const result = wrapTick(() => runTaskDispatchWorker(deviceId));
    void Promise.resolve(result).catch((err) => {
      logScheduling(
        NAMESPACE.task.dispatch,
        `frame error ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(runDispatchFrame, intervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    runDispatchFrame,
  };
}
