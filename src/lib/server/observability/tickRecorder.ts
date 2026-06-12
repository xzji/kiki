/**
 * 调度 / 治理行为等价基线录制器。
 *
 * 通过环境变量 KIKI_TICK_RECORD_PATH 启用：开启后每个 tick 会以 JSONL 形式追加一行，
 * 阶段 1-3 重构前后跑同一组 fixture，对比 JSONL 即可发现行为漂移。
 *
 * 录制格式（每行一个 JSON 对象）：
 *   { ts: ISOString, namespace: string, kind: "summary" | "event", payload: ... }
 *
 * - 不写则 noop，零开销。
 * - 写入失败静默吞掉，不影响主流程。
 */

import { appendFileSync } from "fs";

import type { SchedulingNamespace, TickSummary } from "@/lib/server/observability/schedulingLog";

function recordPath(): string | null {
  const value = process.env.KIKI_TICK_RECORD_PATH?.trim();
  return value && value.length > 0 ? value : null;
}

type RecordEntry = {
  ts: string;
  namespace: SchedulingNamespace | string;
  kind: "summary" | "event";
  payload: unknown;
};

function writeEntry(entry: RecordEntry) {
  const path = recordPath();
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    /* swallow — 录制失败不影响主流程 */
  }
}

export function recordTickSummary(namespace: SchedulingNamespace, summary: TickSummary) {
  writeEntry({
    ts: new Date().toISOString(),
    namespace,
    kind: "summary",
    payload: summary,
  });
}

export function recordTickEvent(
  namespace: SchedulingNamespace,
  event: string,
  payload: Record<string, unknown> = {},
) {
  writeEntry({
    ts: new Date().toISOString(),
    namespace,
    kind: "event",
    payload: { event, ...payload },
  });
}

export function isTickRecordingEnabled(): boolean {
  return recordPath() !== null;
}
