import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NAMESPACE, logTickSummary } from "@/lib/server/observability/schedulingLog";
import { recordTickEvent, isTickRecordingEnabled } from "@/lib/server/observability/tickRecorder";

function withTempRecord<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "kiki-tick-record-"));
  const path = join(dir, "tick.jsonl");
  const previous = process.env.KIKI_TICK_RECORD_PATH;
  process.env.KIKI_TICK_RECORD_PATH = path;
  try {
    return fn(path);
  } finally {
    if (previous === undefined) {
      delete process.env.KIKI_TICK_RECORD_PATH;
    } else {
      process.env.KIKI_TICK_RECORD_PATH = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function readLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function logTickSummaryWritesEntry() {
  withTempRecord((path) => {
    assert.equal(isTickRecordingEnabled(), true);
    logTickSummary(NAMESPACE.task.scheduler, { created: 3, skipped: 1 });
    const lines = readLines(path);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].namespace, "task.scheduler");
    assert.equal(lines[0].kind, "summary");
    const payload = lines[0].payload as Record<string, unknown>;
    assert.equal(payload.created, 3);
    assert.equal(payload.skipped, 1);
  });
}

function recordTickEventAttachesEvent() {
  withTempRecord((path) => {
    recordTickEvent(NAMESPACE.thread.tick, "lease_skipped", { threadId: "t1" });
    const lines = readLines(path);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].namespace, "thread.tick");
    assert.equal(lines[0].kind, "event");
    const payload = lines[0].payload as Record<string, unknown>;
    assert.equal(payload.event, "lease_skipped");
    assert.equal(payload.threadId, "t1");
  });
}

function disabledByDefault() {
  const previous = process.env.KIKI_TICK_RECORD_PATH;
  delete process.env.KIKI_TICK_RECORD_PATH;
  try {
    assert.equal(isTickRecordingEnabled(), false);
    // 不抛错即可
    logTickSummary(NAMESPACE.task.scheduler, { created: 0 });
  } finally {
    if (previous !== undefined) process.env.KIKI_TICK_RECORD_PATH = previous;
  }
}

export function runTickRecorderSpecs() {
  logTickSummaryWritesEntry();
  recordTickEventAttachesEvent();
  disabledByDefault();
  console.log("tickRecorder specs passed");
}
