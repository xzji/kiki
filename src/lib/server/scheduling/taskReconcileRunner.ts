/**
 * taskReconcileRunner — 任务调度层对账节拍（PR refactor §3-B）。
 *
 * 周期性执行：
 *  1. `reconcileRuntimeJobLeasesAndProjections` —— DB 层 lease / projection 对账；
 *  2. `processSupervisor.reconcileJobOwnership` —— in-memory job map 对自身 register
 *     的子进程做对账（仅本地 daemon 有意义；云端不调用）。
 *
 * 注意：启动时立即跑一次 lease 对账以避免 30s 节拍前 lease 过期任务无人回收，
 * 这一动作由 composeDaemon 在 runner.start() 之前显式触发；本 runner 只负责节拍内对账。
 */

import { processSupervisor } from "@/lib/runtime/processSupervisor";
import { reconcileRuntimeJobLeasesAndProjections } from "@/lib/server/scheduling/taskDispatchWorker";
import {
  NAMESPACE,
  logScheduling,
} from "@/lib/server/observability/schedulingLog";

/** 30s 一拍。与原 daemonRunner.RECONCILE_INTERVAL_MS 等价。 */
export const RECONCILE_INTERVAL_MS = 30 * 1000;

export type TaskReconcileRunnerOptions = {
  intervalMs?: number;
  wrapTick: <T>(fn: () => T) => T;
  /** 是否启用 in-memory processSupervisor 对账（云端可关闭）。 */
  withProcessSupervisor?: boolean;
};

export type TaskReconcileRunnerHandle = {
  start: () => void;
  stop: () => void;
};

export function createTaskReconcileRunner(
  options: TaskReconcileRunnerOptions,
): TaskReconcileRunnerHandle {
  const intervalMs = options.intervalMs ?? RECONCILE_INTERVAL_MS;
  const withProcessSupervisor = options.withProcessSupervisor !== false;
  let timer: NodeJS.Timeout | null = null;

  const tick = () => {
    options.wrapTick(() => {
      try {
        reconcileRuntimeJobLeasesAndProjections();
      } catch (err) {
        logScheduling(
          NAMESPACE.task.reconcileLease,
          `error ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (withProcessSupervisor) {
        try {
          processSupervisor.reconcileJobOwnership();
        } catch (err) {
          logScheduling(
            NAMESPACE.task.reconcileOwnership,
            `error ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
