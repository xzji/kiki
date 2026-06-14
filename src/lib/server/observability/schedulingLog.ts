/**
 * 调度 / 治理日志命名空间。
 *
 * 用法（关键 tick 路径）：
 *   logScheduling(NAMESPACE.task.scheduler, "candidates=...");
 *
 * 通用启动 / 自检日志保持直接调 appendRuntimeDaemonLog，无需前缀。
 *
 * KIKI_TICK_SUMMARY_STDOUT=true 会把命名空间日志同步打到 stdout，
 * 便于 Railway 容器直接观察（daemon.log 在容器里看不到）。
 */

import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";
import { recordTickSummary } from "@/lib/server/observability/tickRecorder";

export const NAMESPACE = {
  task: {
    scheduler: "task.scheduler",
    dispatch: "task.dispatch",
    reconcileLease: "task.reconcile.lease",
    reconcileOwnership: "task.reconcile.ownership",
  },
  /**
   * @deprecated Thread tick observability 已迁到 loopTickLog（domain="loop"）。
   * 仅保留导出避免外部测试断言断裂；新增代码不要直接使用。
   */
  thread: {
    scheduler: "thread.scheduler",
    tick: "thread.tick",
  },
} as const;

export type SchedulingNamespace =
  | typeof NAMESPACE.task.scheduler
  | typeof NAMESPACE.task.dispatch
  | typeof NAMESPACE.task.reconcileLease
  | typeof NAMESPACE.task.reconcileOwnership
  | typeof NAMESPACE.thread.scheduler
  | typeof NAMESPACE.thread.tick;

function shouldMirrorToStdout() {
  return process.env.KIKI_TICK_SUMMARY_STDOUT === "true";
}

export function logScheduling(namespace: SchedulingNamespace, message: string) {
  const line = `[${namespace}] ${message}`;
  appendRuntimeDaemonLog(line);
  if (shouldMirrorToStdout()) {
    console.log(line);
  }
}

/** 结构化 tick summary —— 字段约定见各 runner 调用点。 */
export type TickSummary = {
  candidates?: number;
  due?: number;
  created?: number;
  dispatched?: number;
  ticked?: number;
  skipped?: number;
  skipReasons?: Record<string, number>;
  extra?: Record<string, string | number | boolean>;
};

export function formatTickSummary(summary: TickSummary): string {
  const parts: string[] = [];
  if (summary.candidates !== undefined) parts.push(`candidates=${summary.candidates}`);
  if (summary.due !== undefined) parts.push(`due=${summary.due}`);
  if (summary.created !== undefined) parts.push(`created=${summary.created}`);
  if (summary.dispatched !== undefined) parts.push(`dispatched=${summary.dispatched}`);
  if (summary.ticked !== undefined) parts.push(`ticked=${summary.ticked}`);
  if (summary.skipped !== undefined) parts.push(`skipped=${summary.skipped}`);
  if (summary.skipReasons && Object.keys(summary.skipReasons).length > 0) {
    const reasons = Object.entries(summary.skipReasons)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(",");
    parts.push(`skipReasons=${reasons}`);
  }
  if (summary.extra) {
    for (const [key, value] of Object.entries(summary.extra)) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(" ");
}

export function logTickSummary(namespace: SchedulingNamespace, summary: TickSummary) {
  logScheduling(namespace, formatTickSummary(summary));
  recordTickSummary(namespace, summary);
}
