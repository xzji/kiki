import assert from "node:assert/strict";

import { ProcessSupervisor } from "@/lib/runtime/processSupervisor";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerInput(
  abortController: AbortController,
  overrides: Partial<Parameters<ProcessSupervisor["registerJob"]>[0]> = {},
): Parameters<ProcessSupervisor["registerJob"]>[0] {
  return {
    requestId: "req-process-supervisor",
    jobId: "job-process-supervisor",
    leaseOwner: "lease-owner",
    abortController,
    maxDurationMs: 60_000,
    idleTimeoutMs: 60_000,
    ...overrides,
  };
}

export async function runProcessSupervisorSpecs() {
  // register/complete 管理内存态生命周期。
  {
    const supervisor = new ProcessSupervisor();
    const controller = new AbortController();
    supervisor.registerJob(registerInput(controller));
    assert.equal(supervisor.size(), 1);
    supervisor.completeJob("req-process-supervisor");
    assert.equal(supervisor.size(), 0);
    assert.equal(controller.signal.aborted, false);
  }

  // 重复 register 同一 requestId 时只保留最新记录。
  {
    const supervisor = new ProcessSupervisor();
    supervisor.registerJob(registerInput(new AbortController()));
    supervisor.registerJob(registerInput(new AbortController()));
    assert.equal(supervisor.size(), 1);
    supervisor.completeJob("req-process-supervisor");
    assert.equal(supervisor.size(), 0);
  }

  // 总时长定时器会触发 abort。
  {
    const supervisor = new ProcessSupervisor();
    const controller = new AbortController();
    supervisor.registerJob(registerInput(controller, { maxDurationMs: 5 }));
    await sleep(20);
    assert.equal(controller.signal.aborted, true);
    supervisor.completeJob("req-process-supervisor");
  }

  // ownership 对账发现 DB lease 不存在时会中止本地执行。
  {
    const supervisor = new ProcessSupervisor();
    const controller = new AbortController();
    supervisor.registerJob(registerInput(controller, { jobId: "job-missing-from-db" }));
    supervisor.reconcileJobOwnership();
    assert.equal(controller.signal.aborted, true);
    supervisor.completeJob("req-process-supervisor");
  }

  console.log("processSupervisor specs passed");
}
