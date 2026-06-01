/**
 * ThreadLoopWorker 调度选择器 — 计划 §3.4.4。
 *
 * 设计要点：
 *  - 本模块是**纯函数**层，不接入 setInterval / cron 守护进程（由 PR14 scheduler
 *    在调度循环里调用本函数得到 due 列表，再依次 runThreadTick）。
 *  - paused / archived 状态的 thread 永远不被选中。
 *  - one_shot：只要从未触发过（lastTickAt 缺失）就视为 due。
 *  - cron：本函数无 cron 解析能力，统一返回 due（worker 在调用端结合
 *    cron-parser 自行二次过滤）；本期 MVP 不强测此分支。
 *  - 固定间隔（realtime / hourly / daily / weekly）：依据 nextTickAt ≤ now。
 *    若 nextTickAt 缺失（如刚创建 thread），fallback 到 lastTickAt + intervalMs；
 *    再缺失则视为首次触发立即 due。
 */

import { parseThreadLoopInterval } from "@/lib/taskTriggerTime";
import { THREAD_FAILURE_PAUSE_THRESHOLD, type Thread } from "@/types/topic";

export type DueThread = {
  thread: Thread;
  /** 该次调度计算出的预期触发时间（用于排序）；首次触发时与 now 相同。 */
  scheduledAt: Date;
  /** 该 thread 的诊断信息（worker 写入 agent_events 时使用）。 */
  reason: "first_tick" | "interval_due" | "cron_passthrough";
};

/**
 * 在给定的 thread 集合中筛选出本轮 tick 应执行的 due thread 列表。
 *
 * @param threads 候选 threads（已过滤 topic.status === "active"）。
 * @param now 当前时间。
 */
export function selectDueThreads(threads: Thread[], now: Date): DueThread[] {
  const due: DueThread[] = [];
  for (const thread of threads) {
    const verdict = isThreadDue(thread, now);
    if (verdict) due.push({ thread, ...verdict });
  }
  // 早 due 优先（同时可作为 worker 内 fairness 的稳定排序）。
  due.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  return due;
}

export function isThreadDue(
  thread: Thread,
  now: Date,
): { scheduledAt: Date; reason: DueThread["reason"] } | null {
  if (thread.status !== "active") return null;
  // 自动 paused 阈值守卫：worker 不应该再调度已达失败阈值的 thread；
  // 同样状态机已在 ThreadRunner 内处理，此处再次防御以隔离脏数据。
  if (thread.failureCount >= THREAD_FAILURE_PAUSE_THRESHOLD) return null;

  const parsed = parseThreadLoopInterval(thread.loopInterval);

  if (parsed.kind === "one_shot") {
    if (!thread.lastTickAt) return { scheduledAt: new Date(now.getTime()), reason: "first_tick" };
    return null;
  }

  if (parsed.kind === "cron") {
    // 无 cron 解析器；交由 worker 调用端二次过滤
    return { scheduledAt: new Date(now.getTime()), reason: "cron_passthrough" };
  }

  // 固定间隔类型：优先信任 nextTickAt；缺失或异常时回落到 computeNextTickAt
  const explicitNext = parseDateSafe(thread.nextTickAt);
  if (explicitNext) {
    return explicitNext.getTime() <= now.getTime()
      ? { scheduledAt: explicitNext, reason: thread.lastTickAt ? "interval_due" : "first_tick" }
      : null;
  }
  // 既无 nextTickAt 也无 lastTickAt → 首次触发立即 due
  if (!thread.lastTickAt) {
    return { scheduledAt: new Date(now.getTime()), reason: "first_tick" };
  }
  // 有 lastTickAt：根据间隔自行判定（不复用 computeNextTickAt，因为它永远返回 > now）
  const last = parseDateSafe(thread.lastTickAt);
  if (!last) {
    return { scheduledAt: new Date(now.getTime()), reason: "first_tick" };
  }
  const elapsed = now.getTime() - last.getTime();
  if (elapsed < parsed.intervalMs) return null;
  // 计算 last 之后第一个 ≤ now 的 tick 槽位
  const slots = Math.floor(elapsed / parsed.intervalMs);
  const scheduledAt = new Date(last.getTime() + slots * parsed.intervalMs);
  return { scheduledAt, reason: "interval_due" };
}

function parseDateSafe(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}
