/**
 * threadLoopDaemon — PR13（计划 §12.2）。
 *
 * 职责：
 *  - 把 [runThreadLoopFrame](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/thread/threadLoopWorker.ts)
 *    包装成可启动 / 停止 / 重启的守护进程；
 *  - setInterval(tickIntervalMs) 内每帧调用 `runThreadLoopFrame({ now: clock(), invoke, callbacks })`；
 *  - 通过 in-flight flag 阻止下一帧在上一帧未结束时重入；
 *  - 注入 [buildThreadLoopFrameCallbacks](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/thread/threadLoopCallbacks.ts)
 *    与 [createClaudeJsonInvoke](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/agentRuntime/claudeJsonInvoke.ts)
 *    工厂建好的 thread_runner LlmInvoke。
 *
 * 不做的事：
 *  - 不在 daemon 层访问 DB（仓库访问全在 callback 内）；
 *  - 不在 daemon 层处理 cron_passthrough 二次过滤（§3.4.5 已交给
 *    `parseThreadLoopInterval` + `computeNextTickAt` 一起处理；daemon 仅按
 *    `nextTickAt` 调用 selectDueThreads，由 worker 内部完成）。
 */

import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import {
  buildThreadLoopFrameCallbacks,
  type ThreadLoopFrameCallbacks,
} from "@/lib/server/thread/threadLoopCallbacks";
import {
  runThreadLoopFrame,
  type ThreadLoopFrameOutcome,
} from "@/lib/server/thread/threadLoopWorker";

export type ThreadLoopDaemonConfig = {
  /** 默认 60_000ms。 */
  tickIntervalMs?: number;
  /** 可注入的虚拟时钟，便于测试。 */
  clock?: () => Date;
  /** 帧级异常回调；仅当帧整体抛错时触发（单 thread 异常已被 worker 收集）。 */
  onError?: (err: unknown) => void;
  /** 帧完成回调；测试断言用。 */
  onFrameSettled?: (outcome: ThreadLoopFrameOutcome) => void;
  /** stop() 等待 in-flight tick 的最长时间，默认 30_000ms。 */
  stopTimeoutMs?: number;
  /** 自定义 callbacks 工厂（默认使用仓库层装配工厂）。 */
  buildCallbacks?: (frameStartedAt: Date, invoke?: LlmInvoke) => ThreadLoopFrameCallbacks;
  /** 每帧 tick 外包一层（多租户场景下注入用户上下文）。 */
  wrapTick?: <T>(fn: () => Promise<T>) => Promise<T>;
};

export type ThreadLoopDaemonDeps = {
  /** thread_runner 角色的 LlmInvoke（PR9c createClaudeJsonInvoke 工厂产物）。 */
  invoke: LlmInvoke;
};

export type ThreadLoopDaemon = {
  start(): void;
  stop(): Promise<void>;
  restart(): Promise<void>;
  isRunning(): boolean;
  /** 直接跑一帧；测试或手动触发用。 */
  runOnce(): Promise<ThreadLoopFrameOutcome>;
};

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

export function createThreadLoopDaemon(
  deps: ThreadLoopDaemonDeps,
  config: ThreadLoopDaemonConfig = {},
): ThreadLoopDaemon {
  const tickIntervalMs = config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const stopTimeoutMs = config.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const clock = config.clock ?? (() => new Date());
  const buildCallbacks = config.buildCallbacks ?? buildThreadLoopFrameCallbacks;

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const tickOnce = async (): Promise<ThreadLoopFrameOutcome> => {
    const run = async (): Promise<ThreadLoopFrameOutcome> => {
      const now = clock();
      const callbacks = buildCallbacks(now, deps.invoke);
      return runThreadLoopFrame({
        now,
        invoke: deps.invoke,
        callbacks,
      });
    };
    return config.wrapTick ? config.wrapTick(run) : run();
  };

  const wrappedTick = async (): Promise<void> => {
    if (inFlight) return; // 跳过重入帧
    inFlight = true;
    try {
      const outcome = await tickOnce();
      config.onFrameSettled?.(outcome);
    } catch (err) {
      // worker 内单 thread 失败已收集到 ticked[].failureReason；这里只兜底意外抛错。
      config.onError?.(err);
    } finally {
      inFlight = false;
    }
  };

  return {
    start,
    stop,
    async restart() {
      await stop();
      start();
    },
    isRunning,
    runOnce,
  };

  function start() {
    if (timer !== null) return;
    timer = setInterval(() => {
      // 不 await：允许 setInterval 周期性触发，由 inFlight flag 防重入。
      void wrappedTick();
    }, tickIntervalMs);
  }

  async function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    const deadline = Date.now() + stopTimeoutMs;
    while (inFlight && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  function isRunning() {
    return timer !== null;
  }

  async function runOnce() {
    if (inFlight) {
      // 等待上一帧结束再跑；测试/手动触发更直观
      const deadline = Date.now() + stopTimeoutMs;
      while (inFlight && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
    inFlight = true;
    try {
      const outcome = await tickOnce();
      config.onFrameSettled?.(outcome);
      return outcome;
    } finally {
      inFlight = false;
    }
  }
}
