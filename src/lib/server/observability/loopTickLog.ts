/**
 * loopTickLog — Loop-kind 化的三层 tick 日志统一入口。
 *
 * L1 daemon.log: 人眼 grep 的 frame/entity 行。
 * L2 agent_events: 结构化 tick outcome，新旧 kind 双写兼容 thread 域。
 * L3 daemon trace: trace 模式下写私密 metadata/payload。
 */

import { createDaemonTrace, logDaemonEvent } from "@/lib/daemon/daemonLogger";
import { appendAgentEvent } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import { recordTickSummary } from "@/lib/server/observability/tickRecorder";
import type { AgentEventType } from "@/types/agentRuntime";

export type LoopKind = "thread" | "topic";

export type LoopTickPhase = "completed" | "failed" | "dispatch_partial_failure";

export type LoopTickRecord = {
  kind: LoopKind;
  entityId: string;
  parentId?: string;
  agentRunId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  phase: LoopTickPhase;
  failureReason?: string;
  errorKind?: string;
  dispatchedTaskCount?: number;
  updatedTaskCount?: number;
  cancelledTaskCount?: number;
  sentMessageCount?: number;
  silentCount?: number;
  assessment?: string;
  confidence?: number | string;
  pauseReason?: "failure_threshold";
  failureCount?: number;
  tracePayload?: Record<string, unknown>;
};

export type LoopFrameSummary = {
  kind: LoopKind;
  ticked: number;
  ok: number;
  frameErrors: number;
  skipReasons?: Record<string, number>;
};

export type LoopFrameError = {
  kind: LoopKind;
  message: string;
};

function namespaceFor(kind: LoopKind): string {
  return `${kind}.tick`;
}

function compactFields(fields: Record<string, string | number | boolean | undefined>) {
  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) delete fields[key];
  }
  return fields as Record<string, string | number | boolean>;
}

export function frameSummary(summary: LoopFrameSummary): void {
  if (summary.ticked === 0 && summary.frameErrors === 0) return;
  const fields: Record<string, string | number> = {
    kind: summary.kind,
    ticked: summary.ticked,
    ok: summary.ok,
    frameErrors: summary.frameErrors,
  };
  if (summary.skipReasons && Object.keys(summary.skipReasons).length > 0) {
    fields.skipReasons = Object.entries(summary.skipReasons)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(",");
  }
  logDaemonEvent("info", "loop", "frame", fields);
  recordTickSummary(namespaceFor(summary.kind), {
    ticked: summary.ticked,
    extra: {
      ok: summary.ok,
      frameErrors: summary.frameErrors,
    },
    skipReasons: summary.skipReasons,
  });
}

export function recordEntity(record: LoopTickRecord): void {
  logDaemonEvent(
    "debug",
    "loop",
    "entity",
    compactFields({
      kind: record.kind,
      entity: record.entityId,
      parent: record.parentId,
      agentRun: record.agentRunId,
      phase: record.phase,
      ok: record.ok,
      dur_ms: record.durationMs,
      dispatched: record.dispatchedTaskCount,
      updated: record.updatedTaskCount,
      cancelled: record.cancelledTaskCount,
      posted: record.sentMessageCount,
      silent: record.silentCount,
      failure: record.failureReason,
    }),
  );

  const newKind = `loop.${record.kind}.tick.${record.phase}`;
  const legacyKind = legacyKindFor(record);
  const sharedPayload = {
    dispatchedTaskCount: record.dispatchedTaskCount ?? 0,
    updatedTaskCount: record.updatedTaskCount ?? 0,
    cancelledTaskCount: record.cancelledTaskCount ?? 0,
    sentMessageCount: record.sentMessageCount ?? 0,
    silentCount: record.silentCount ?? 0,
    failureCount: record.failureCount,
    failureReason: record.failureReason,
    errorKind: record.errorKind ?? record.failureReason,
    assessment: record.assessment,
    confidence: record.confidence,
    pauseReason: record.pauseReason,
  };
  const eventType: AgentEventType = record.phase === "completed" ? "decision" : "error";

  appendAgentEvent({
    agentRunId: record.agentRunId,
    type: eventType,
    payloadJson: JSON.stringify({ kind: newKind, ...sharedPayload }),
  });
  if (legacyKind) {
    appendAgentEvent({
      agentRunId: record.agentRunId,
      type: eventType,
      payloadJson: JSON.stringify({ kind: legacyKind, ...sharedPayload }),
    });
  }

  if (record.pauseReason === "failure_threshold") {
    appendAgentEvent({
      agentRunId: record.agentRunId,
      type: "thread_paused",
      payloadJson: JSON.stringify({
        kind: `loop.${record.kind}.paused.failure_threshold`,
        topicId: record.parentId,
        threadId: record.entityId,
        failureCount: record.failureCount,
      }),
    });
    if (record.kind === "thread") {
      appendAgentEvent({
        agentRunId: record.agentRunId,
        type: "thread_paused",
        payloadJson: JSON.stringify({
          kind: "thread.paused.failure_threshold",
          topicId: record.parentId,
          threadId: record.entityId,
          failureCount: record.failureCount,
        }),
      });
    }
  }

  const trace = createDaemonTrace({
    type: "loop.tick",
    requestId: record.agentRunId,
    metadata: {
      loopKind: record.kind,
      entityId: record.entityId,
      parentId: record.parentId,
      phase: record.phase,
      ok: record.ok,
    },
  });
  if (trace) {
    trace.writePayload({ record, details: record.tracePayload });
    trace.finish(record.ok ? "completed" : "failed", record.failureReason);
  }
}

export function frameError(err: LoopFrameError): void {
  logDaemonEvent("info", "loop", err.message, {
    kind: err.kind,
    event: "frame_error",
  });
}

function legacyKindFor(record: LoopTickRecord): string | null {
  if (record.kind !== "thread") return null;
  if (record.phase === "completed") return "thread.tick.completed";
  if (record.phase === "failed") return "thread.tick.failed";
  if (record.phase === "dispatch_partial_failure") return "thread.tick.dispatch_partial_failure";
  return null;
}
