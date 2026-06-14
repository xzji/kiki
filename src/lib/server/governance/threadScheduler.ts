/**
 * ThreadLoopWorker 调度选择器 — 计划 §3.4.4。
 *
 * 设计要点：
 *  - 本模块是**纯函数**层，不接入 setInterval / cron 守护进程（由 PR14 scheduler
 *    在调度循环里调用本函数得到 due 列表，再依次 runThreadTick）。
 *  - paused / archived 状态的 thread 永远不被选中。
 *  - one_shot：从未触发过时视为 due；触发过后仅响应事件桥写入的 nextTickAt。
 *  - cron：本函数无 cron 解析能力，统一返回 due（worker 在调用端结合
 *    cron-parser 自行二次过滤）；本期 MVP 不强测此分支。
 *  - 固定间隔（realtime / hourly / daily / weekly）：依据 nextTickAt ≤ now。
 *    这里的 loopInterval 表示治理 review 节拍，不代表 Task 执行频率。
 *    若 nextTickAt 缺失（如刚创建 thread），fallback 到 lastTickAt + intervalMs；
 *    再缺失则视为首次触发立即 due。
 */

import { computeThreadDueTickAt, isTriggerSpecInPhasedWindow, parseThreadLoopInterval } from "@/lib/taskTriggerTime";
import { THREAD_FAILURE_PAUSE_THRESHOLD, type Thread } from "@/types/topic";

export type DueThread = {
  thread: Thread;
  /** 该次调度计算出的预期触发时间（用于排序）；首次触发时与 now 相同。 */
  scheduledAt: Date;
  /** 该 thread 的诊断信息（worker 写入 agent_events 时使用）。 */
  reason: "first_tick" | "event_triggered" | "interval_due" | "cron_due";
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

  const explicitNext = parseDateSafe(thread.nextTickAt);
  const parsed = parseThreadLoopInterval(thread.loopTrigger ?? thread.loopInterval);

  if (parsed.kind === "one_shot") {
    if (explicitNext && explicitNext.getTime() <= now.getTime()) {
      return {
        scheduledAt: explicitNext,
        reason: thread.lastTickAt ? "event_triggered" : "first_tick",
      };
    }
    if (!thread.lastTickAt) return { scheduledAt: new Date(now.getTime()), reason: "first_tick" };
    return null;
  }

  if (parsed.kind === "event") {
    if (explicitNext && explicitNext.getTime() <= now.getTime()) {
      return { scheduledAt: explicitNext, reason: "event_triggered" };
    }
    return null;
  }

  // 统一调度入口：优先信任 nextTickAt；phased 类型在真正选中前再做窗口校验。
  if (explicitNext) {
    if (explicitNext.getTime() > now.getTime()) return null;
    if (!isTriggerSpecInPhasedWindow(thread.loopTrigger ?? thread.loopInterval, now)) return null;
    const last = parseDateSafe(thread.lastTickAt);
    const expectedReviewAt =
      last &&
      (parsed.kind === "realtime" ||
        parsed.kind === "hourly" ||
        parsed.kind === "daily" ||
        parsed.kind === "weekly" ||
        parsed.kind === "interval")
        ? last.getTime() + parsed.intervalMs
        : undefined;
    return {
      scheduledAt: explicitNext,
      reason:
        expectedReviewAt !== undefined && explicitNext.getTime() < expectedReviewAt
          ? "event_triggered"
          : thread.lastTickAt
            ? "interval_due"
            : "first_tick",
    };
  }

  const scheduledAt = computeThreadDueTickAt(
    thread.loopTrigger ? { ...thread, loopInterval: thread.loopTrigger } : thread,
    now,
  );
  if (!scheduledAt) return null;
  if (!isTriggerSpecInPhasedWindow(thread.loopTrigger ?? thread.loopInterval, now)) return null;
  return {
    scheduledAt,
    reason: parsed.kind === "cron" ? "cron_due" : thread.lastTickAt ? "interval_due" : "first_tick",
  };
}

function parseDateSafe(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}
