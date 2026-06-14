import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LOCAL_USER_ID, runWithUserContext } from "@/lib/server/context/userContext";
import { closeDatabaseForReset } from "@/lib/server/db/client";
import { createAgentRun } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { listAgentEvents } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import { frameError, frameSummary, recordEntity } from "@/lib/server/observability/loopTickLog";

function withTempDaemonLog<T>(fn: (input: { dir: string; logFile: string }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "kiki-loop-tick-"));
  const previousHome = process.env.KIKI_RUNTIME_HOME;
  const previousLevel = process.env.KIKI_DAEMON_LOG_LEVEL;
  const previousTrace = process.env.KIKI_DAEMON_TRACE;
  process.env.KIKI_RUNTIME_HOME = dir;
  delete process.env.KIKI_DAEMON_LOG_LEVEL;
  delete process.env.KIKI_DAEMON_TRACE;
  try {
    return fn({ dir, logFile: join(dir, "logs", "daemon.log") });
  } finally {
    if (previousHome === undefined) delete process.env.KIKI_RUNTIME_HOME;
    else process.env.KIKI_RUNTIME_HOME = previousHome;
    if (previousLevel === undefined) delete process.env.KIKI_DAEMON_LOG_LEVEL;
    else process.env.KIKI_DAEMON_LOG_LEVEL = previousLevel;
    if (previousTrace === undefined) delete process.env.KIKI_DAEMON_TRACE;
    else process.env.KIKI_DAEMON_TRACE = previousTrace;
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempUserDb<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "kiki-loop-db-"));
  const previousDataDir = process.env.KIKI_DATA_DIR;
  process.env.KIKI_DATA_DIR = dir;
  closeDatabaseForReset(DEFAULT_LOCAL_USER_ID);
  try {
    return runWithUserContext(DEFAULT_LOCAL_USER_ID, fn);
  } finally {
    closeDatabaseForReset(DEFAULT_LOCAL_USER_ID);
    if (previousDataDir === undefined) delete process.env.KIKI_DATA_DIR;
    else process.env.KIKI_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

function readLogLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter((line) => line.length > 0);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRun(id: string) {
  return createAgentRun({
    id,
    topicId: "tp-1",
    threadId: "th-1",
    role: "thread_runner",
    idempotencyKey: id,
    startedAt: "2026-06-12T08:00:00.000Z",
  });
}

function frameSummaryWritesOneLineWithLoopDomain() {
  withTempDaemonLog(({ logFile }) => {
    frameSummary({
      kind: "thread",
      ticked: 3,
      ok: 2,
      frameErrors: 0,
      skipReasons: { persist_conflict: 1 },
    });
    const lines = readLogLines(logFile);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /\[info\] \[loop\] /);
    assert.match(lines[0] ?? "", /kind=thread/);
    assert.match(lines[0] ?? "", /ticked=3/);
    assert.match(lines[0] ?? "", /ok=2/);
    assert.match(lines[0] ?? "", /skipReasons=persist_conflict:1/);
  });
}

function frameSummarySkipsEmptyFrames() {
  withTempDaemonLog(({ logFile }) => {
    frameSummary({ kind: "thread", ticked: 0, ok: 0, frameErrors: 0 });
    assert.equal(readLogLines(logFile).length, 0);
  });
}

function frameSummaryKeepsTickRecorderSummaryShape() {
  withTempDaemonLog(({ dir }) => {
    const recordPath = join(dir, "tick.jsonl");
    const previous = process.env.KIKI_TICK_RECORD_PATH;
    process.env.KIKI_TICK_RECORD_PATH = recordPath;
    try {
      frameSummary({ kind: "thread", ticked: 2, ok: 1, frameErrors: 1 });
      const lines = readJsonl(recordPath);
      assert.equal(lines.length, 1);
      assert.equal(lines[0]?.namespace, "thread.tick");
      assert.equal(lines[0]?.kind, "summary");
      const payload = lines[0]?.payload as Record<string, unknown>;
      assert.equal(payload.ticked, 2);
      assert.deepEqual(payload.extra, { ok: 1, frameErrors: 1 });
    } finally {
      if (previous === undefined) delete process.env.KIKI_TICK_RECORD_PATH;
      else process.env.KIKI_TICK_RECORD_PATH = previous;
    }
  });
}

function recordEntityWritesL1DebugLineOnlyAtDebugLevel() {
  withTempDaemonLog(({ logFile }) => {
    withTempUserDb(() => {
      const run1 = createRun("agent-run-loop-debug-1");
      recordEntity({
        kind: "thread",
        entityId: "th-1",
        parentId: "tp-1",
        agentRunId: run1.id,
        startedAt: "2026-06-12T08:00:00.000Z",
        finishedAt: "2026-06-12T08:00:01.000Z",
        durationMs: 1000,
        ok: true,
        phase: "completed",
        dispatchedTaskCount: 1,
      });
      assert.equal(readLogLines(logFile).length, 0, "info 级别不应打 per-entity 行");

      process.env.KIKI_DAEMON_LOG_LEVEL = "debug";
      const run2 = createRun("agent-run-loop-debug-2");
      recordEntity({
        kind: "thread",
        entityId: "th-2",
        parentId: "tp-1",
        agentRunId: run2.id,
        startedAt: "2026-06-12T08:00:02.000Z",
        finishedAt: "2026-06-12T08:00:03.500Z",
        durationMs: 1500,
        ok: true,
        phase: "completed",
        dispatchedTaskCount: 2,
        updatedTaskCount: 1,
      });
      const lines = readLogLines(logFile);
      assert.equal(lines.length, 1, "debug 级别应打一行");
      assert.match(lines[0] ?? "", /\[debug\] \[loop\] /);
      assert.match(lines[0] ?? "", /kind=thread/);
      assert.match(lines[0] ?? "", /entity=th-2/);
      assert.match(lines[0] ?? "", /phase=completed/);
      assert.match(lines[0] ?? "", /dur_ms=1500/);
      assert.match(lines[0] ?? "", /dispatched=2/);
    });
  });
}

function recordEntityWritesAgentEventsWithBothKinds() {
  withTempUserDb(() => {
    const run = createRun("agent-run-loop-l2");
    recordEntity({
      kind: "thread",
      entityId: "th-1",
      parentId: "tp-1",
      agentRunId: run.id,
      startedAt: "2026-06-12T08:00:00.000Z",
      finishedAt: "2026-06-12T08:00:00.100Z",
      durationMs: 100,
      ok: true,
      phase: "completed",
      dispatchedTaskCount: 1,
      updatedTaskCount: 0,
      cancelledTaskCount: 0,
      sentMessageCount: 0,
      silentCount: 0,
      assessment: "test",
      confidence: 0.9,
    });
    const kinds = listAgentEvents({ agentRunId: run.id }).map((event) => event.payload.kind).sort();
    assert.deepEqual(kinds, ["loop.thread.tick.completed", "thread.tick.completed"]);
  });
}

function recordEntityWritesTraceMetadataAndPayload() {
  withTempDaemonLog(({ dir }) => {
    withTempUserDb(() => {
      process.env.KIKI_DAEMON_LOG_LEVEL = "trace";
      process.env.KIKI_DAEMON_TRACE = "1";
      const run = createRun("agent-run-loop-trace");
      recordEntity({
        kind: "thread",
        entityId: "th-trace",
        parentId: "tp-1",
        agentRunId: run.id,
        startedAt: "2026-06-12T08:00:00.000Z",
        finishedAt: "2026-06-12T08:00:00.100Z",
        durationMs: 100,
        ok: true,
        phase: "completed",
        tracePayload: { sample: true },
      });
      const date = new Date().toISOString().slice(0, 10);
      const traceDir = join(dir, "logs", "trace", date, run.id);
      const meta = JSON.parse(readFileSync(join(traceDir, "meta.json"), "utf-8")) as Record<string, unknown>;
      const payload = JSON.parse(readFileSync(join(traceDir, "payload.json"), "utf-8")) as {
        record?: { entityId?: string };
        details?: { sample?: boolean };
      };
      assert.equal(meta.loopKind, "thread");
      assert.equal(meta.entityId, "th-trace");
      assert.equal(meta.phase, "completed");
      assert.equal(payload.record?.entityId, "th-trace");
      assert.equal(payload.details?.sample, true);
    });
  });
}

function frameErrorWritesInfoLevelLine() {
  withTempDaemonLog(({ logFile }) => {
    frameError({ kind: "thread", message: "collect callback exploded" });
    const lines = readLogLines(logFile);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /\[info\] \[loop\] /);
    assert.match(lines[0] ?? "", /kind=thread/);
    assert.match(lines[0] ?? "", /event=frame_error/);
    assert.match(lines[0] ?? "", /collect callback exploded/);
  });
}

export function runLoopTickLogSpecs() {
  frameSummaryWritesOneLineWithLoopDomain();
  frameSummarySkipsEmptyFrames();
  frameSummaryKeepsTickRecorderSummaryShape();
  recordEntityWritesL1DebugLineOnlyAtDebugLevel();
  recordEntityWritesAgentEventsWithBothKinds();
  recordEntityWritesTraceMetadataAndPayload();
  frameErrorWritesInfoLevelLine();
  console.log("loopTickLog specs passed");
}
