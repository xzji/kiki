/**
 * agentRunCommandService — execute pause/resume/cancel/retry against an
 * `agent_runs` row, with optimistic locking via `expectedRevision` and
 * idempotency via `idempotency_key` lookup on commands.
 *
 * Plan ref: §3.1.5 + §9.6 problem 20 (resume semantics).
 */

import {
  findAgentRunById,
  updateAgentRun,
} from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { listAgentEvents } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import { appendGuardedEvent } from "@/lib/server/agentRuntime/agentExecutor";
import {
  findSagaInstanceById,
  updateSagaInstance,
} from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";
import type { AgentRun, AgentRunStatus } from "@/types/agentRuntime";

export type AgentRunCommand =
  | { kind: "pause"; agentRunId: string }
  | { kind: "resume"; agentRunId: string; input?: Record<string, unknown> }
  | { kind: "cancel"; agentRunId: string }
  | { kind: "retry"; agentRunId: string };

export type ApplyAgentRunCommandInput = {
  command: AgentRunCommand;
  idempotencyKey: string;
  baseRevision?: number;
};

export type ApplyAgentRunCommandResult = {
  agentRun: AgentRun;
};

export class AgentRunCommandConflictError extends Error {
  constructor(
    public currentRevision: number,
    public expectedRevision: number,
  ) {
    super("Agent Run 已被更新，请刷新后重试");
    this.name = "AgentRunCommandConflictError";
  }
}

export class AgentRunCommandIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key 已用于不同命令，请更换后重试");
    this.name = "AgentRunCommandIdempotencyConflictError";
  }
}

export class AgentRunCommandValidationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentRunCommandValidationError";
  }
}

function assertTransition(current: AgentRunStatus, next: AgentRunStatus, command: AgentRunCommand["kind"]) {
  if (current === next) return;
  const allowed: Record<AgentRunCommand["kind"], AgentRunStatus[]> = {
    pause: ["pending", "running"],
    resume: ["paused"],
    cancel: ["pending", "running", "paused"],
    retry: ["failed"],
  };
  if (!allowed[command].includes(current)) {
    throw new AgentRunCommandValidationError(
      409,
      `Agent Run 当前状态 ${current} 不允许执行 ${command}`,
    );
  }
}

export function applyAgentRunCommand(
  input: ApplyAgentRunCommandInput,
): ApplyAgentRunCommandResult {
  const { command, baseRevision, idempotencyKey } = input;
  if (!idempotencyKey) {
    throw new AgentRunCommandValidationError(400, "缺少 Idempotency-Key");
  }
  const existing = findAgentRunById(command.agentRunId);
  if (!existing) {
    throw new AgentRunCommandValidationError(404, "未找到 Agent Run");
  }

  // Idempotency 短路：扫最近事件 payload.idempotencyKey；命中同 key + 同 kind 直接
  // 返回当前 run 状态；命中同 key + 不同 kind 视为冲突。
  // §9.6 problem 20 — 命令通过事件留痕，事件 payload 是天然的去重锚点。
  const recentEvents = listAgentEvents({ agentRunId: command.agentRunId, limit: 200 });
  for (let i = recentEvents.length - 1; i >= 0; i -= 1) {
    const ev = recentEvents[i];
    if (ev.type !== "decision" && ev.type !== "message") continue;
    const evKey = ev.payload?.idempotencyKey;
    if (typeof evKey !== "string" || evKey !== idempotencyKey) continue;
    const evCommand = ev.payload?.command;
    if (evCommand !== command.kind) {
      throw new AgentRunCommandIdempotencyConflictError();
    }
    return { agentRun: existing };
  }

  let nextStatus: AgentRunStatus;
  switch (command.kind) {
    case "pause":
      nextStatus = "paused";
      break;
    case "resume":
      nextStatus = "running";
      break;
    case "cancel":
      nextStatus = "failed";
      break;
    case "retry":
      nextStatus = "pending";
      break;
  }
  assertTransition(existing.status, nextStatus, command.kind);

  const updated = updateAgentRun({
    id: command.agentRunId,
    status: nextStatus,
    expectedRevision: baseRevision,
    finishedAt: nextStatus === "failed" ? new Date().toISOString() : undefined,
  });

  if (!updated) {
    const refreshed = findAgentRunById(command.agentRunId);
    throw new AgentRunCommandConflictError(
      refreshed?.revision ?? -1,
      baseRevision ?? -1,
    );
  }

  // 先完成 revision 校验与状态更新，再记录 command event。否则 stale
  // baseRevision 会返回冲突却留下 phantom command event。
  appendGuardedEvent({
    agentRunId: command.agentRunId,
    type: command.kind === "resume" ? "message" : "decision",
    payload:
      command.kind === "resume"
        ? { command: "resume", input: command.input ?? null, idempotencyKey }
        : { command: command.kind, idempotencyKey },
  });
  const refreshedAfterEvent = findAgentRunById(command.agentRunId) ?? updated;

  // If the run is bound to a saga, mirror cancel/pause/resume to the saga so the
  // coordinator/resumeManager observes a consistent state.
  if (refreshedAfterEvent.sagaInstanceId) {
    const saga = findSagaInstanceById(refreshedAfterEvent.sagaInstanceId);
    if (saga) {
      if (command.kind === "pause" && saga.status !== "completed" && saga.status !== "failed") {
        updateSagaInstance({ id: saga.id, status: "awaiting_user" });
      }
      if (command.kind === "cancel" && saga.status !== "completed" && saga.status !== "failed") {
        updateSagaInstance({
          id: saga.id,
          status: "failed",
          finishedAt: new Date().toISOString(),
        });
      }
      if (command.kind === "resume" && saga.status === "awaiting_user") {
        updateSagaInstance({ id: saga.id, status: "running" });
      }
    }
  }

  return { agentRun: refreshedAfterEvent };
}
