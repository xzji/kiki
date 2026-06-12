/**
 * threadGovernanceRunner spec — PR13（计划 §12.2.5）。
 *
 * 验证 daemon 外壳行为（不接 DB）：
 *  - start() 后 setInterval 周期性触发 frame；
 *  - stop() 后不再触发；
 *  - 单帧未结束时下一次 interval 触发会被 inFlight flag 跳过；
 *  - runOnce() 同步等待一帧结束并返回 outcome；
 *  - frame 抛错走 onError，不冒泡；
 *  - clock 注入生效（callbacks 工厂收到的 frameStartedAt 来自 clock）。
 */

import assert from "node:assert/strict";

import { createThreadLoopDaemon } from "@/lib/server/governance/threadGovernanceRunner";
import type { ThreadLoopFrameCallbacks } from "@/lib/server/governance/threadGovernorCallbacks";
import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";
import type { ThreadLoopFrameOutcome } from "@/lib/server/governance/threadGovernor";

function buildNoopCallbacks(): ThreadLoopFrameCallbacks {
  return {
    collectActiveThreads: async () => [],
    collectRecentTaskInstances: async () => [],
    prepareAgentRun: async () => ({ agentRunId: "ar" }),
    persistThreadPatch: async () => ({ ok: true }),
    recordTickOutcome: async () => {},
    dispatchTask: async () => ({ taskId: "x" }),
    sendThreadMessage: async () => ({ conversationMessageId: "x" }),
  };
}

const noopInvoke: LlmInvoke = async () => ({ rawText: "{}", parsed: {} });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runThreadGovernanceRunnerSpecs() {
  // ---------- runOnce 同步触发一帧 ----------
  {
    let buildCount = 0;
    const fixedNow = new Date("2026-06-01T00:00:00.000Z");
    let receivedNow: Date | null = null;
    const daemon = createThreadLoopDaemon(
      { invoke: noopInvoke },
      {
        clock: () => fixedNow,
        buildCallbacks: (frameStartedAt) => {
          buildCount += 1;
          receivedNow = frameStartedAt;
          return buildNoopCallbacks();
        },
      },
    );
    const outcome = await daemon.runOnce();
    assert.equal(buildCount, 1, "runOnce 触发一次 buildCallbacks");
    assert.ok(receivedNow !== null, "receivedNow 应已被赋值");
    assert.equal(
      (receivedNow as Date | null)?.toISOString(),
      fixedNow.toISOString(),
      "clock 注入生效",
    );
    assert.equal(outcome.ticked.length, 0);
    assert.equal(outcome.frameErrors.length, 0);
    assert.equal(daemon.isRunning(), false);
  }

  // ---------- start/stop 控制 setInterval 触发 ----------
  {
    let frameCount = 0;
    const daemon = createThreadLoopDaemon(
      { invoke: noopInvoke },
      {
        tickIntervalMs: 20,
        buildCallbacks: () => buildNoopCallbacks(),
        onFrameSettled: () => {
          frameCount += 1;
        },
      },
    );
    daemon.start();
    assert.equal(daemon.isRunning(), true);
    await sleep(80); // 至少跑 2-3 帧
    await daemon.stop();
    assert.equal(daemon.isRunning(), false);
    const countAfterStop = frameCount;
    assert.ok(countAfterStop >= 2, `预期至少 2 帧，实际 ${countAfterStop}`);
    await sleep(60);
    assert.equal(frameCount, countAfterStop, "stop 后 frame 不再增加");
  }

  // ---------- inFlight 防重入：长 frame 期间下一 interval 跳过 ----------
  {
    let frameCount = 0;
    let resolveSlow: (() => void) | null = null;
    const slowCallbacks = (): ThreadLoopFrameCallbacks => ({
      ...buildNoopCallbacks(),
      collectActiveThreads: async () => {
        await new Promise<void>((resolve) => {
          resolveSlow = resolve;
        });
        return [];
      },
    });
    const daemon = createThreadLoopDaemon(
      { invoke: noopInvoke },
      {
        tickIntervalMs: 10,
        buildCallbacks: () => slowCallbacks(),
        onFrameSettled: () => {
          frameCount += 1;
        },
      },
    );
    daemon.start();
    // 让 setInterval 触发若干次，但首帧因 collectActiveThreads pending 阻塞
    await sleep(50);
    assert.equal(frameCount, 0, "首帧未结束，无 settled");
    // 释放首帧
    const release = resolveSlow as (() => void) | null;
    if (release) release();
    await sleep(30);
    assert.ok(frameCount >= 1, "首帧 settled 后 frameCount 至少 1");
    await daemon.stop();
  }

  // ---------- frame 抛错走 onError ----------
  {
    const errors: unknown[] = [];
    // worker 把 callback 抛错收集到 frameErrors，不会冒泡到 daemon。
    // 这里用 buildCallbacks 工厂本身抛错触发 daemon onError 兜底。
    const daemon = createThreadLoopDaemon(
      { invoke: noopInvoke },
      {
        tickIntervalMs: 10,
        buildCallbacks: () => {
          throw new Error("buildCallbacks boom");
        },
        onError: (err) => errors.push(err),
      },
    );
    daemon.start();
    await sleep(40);
    await daemon.stop();
    assert.ok(errors.length >= 1, "buildCallbacks 抛错应触发 onError");
    const first = errors[0];
    assert.ok(first instanceof Error && /boom/.test(first.message));
  }

  // ---------- restart 等价 stop().then(start) ----------
  {
    let count = 0;
    const daemon = createThreadLoopDaemon(
      { invoke: noopInvoke },
      {
        tickIntervalMs: 15,
        buildCallbacks: () => buildNoopCallbacks(),
        onFrameSettled: () => {
          count += 1;
        },
      },
    );
    daemon.start();
    await sleep(40);
    const before = count;
    await daemon.restart();
    assert.equal(daemon.isRunning(), true);
    await sleep(40);
    await daemon.stop();
    assert.ok(count > before, "restart 后仍然继续 tick");
  }

  // ---------- onFrameSettled 收到 outcome ----------
  {
    const outcomes: ThreadLoopFrameOutcome[] = [];
    const daemon = createThreadLoopDaemon(
      { invoke: noopInvoke },
      {
        buildCallbacks: () => buildNoopCallbacks(),
        onFrameSettled: (outcome) => outcomes.push(outcome),
      },
    );
    await daemon.runOnce();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.ticked.length, 0);
    assert.equal(outcomes[0]?.frameErrors.length, 0);
  }

  // ---------- 解构调用 restart/stop 不丢 this ----------
  {
    const daemon = createThreadLoopDaemon(
      { invoke: noopInvoke },
      {
        tickIntervalMs: 20,
        buildCallbacks: () => buildNoopCallbacks(),
      },
    );
    const { start, stop, restart, isRunning } = daemon;
    start();
    assert.equal(isRunning(), true);
    await restart();
    assert.equal(isRunning(), true);
    await stop();
    assert.equal(isRunning(), false);
  }
}
