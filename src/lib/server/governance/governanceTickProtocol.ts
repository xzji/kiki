import type { GovernanceTickJobPayload, GovernanceTickTargetKind } from "@/lib/server/repositories/governanceTickJobsRepository";
import type { TopicPatch } from "@/lib/server/repositories/topicsRepository";
import type { TopicTickOutput } from "@/lib/server/governance/topicRunner";
import type { ThreadTickResult } from "@/lib/server/thread/threadRunner";
import type { Task } from "@/types/kiki";
import type {
  RuntimeEnvironment,
  RuntimeFilePolicy,
  RuntimePermissionMode,
} from "@/types/runtime";

export type GovernanceTickLlmPayload = {
  runtimeEnv: RuntimeEnvironment;
  cwd: string;
  conversationId?: string;
  permissionMode?: RuntimePermissionMode;
  filePolicy?: RuntimeFilePolicy;
};

export type GovernanceTickCommandType = "topic_governance_tick" | "thread_governance_tick";

export type GovernanceTickMachineCommand = {
  type: GovernanceTickCommandType;
  requestId: string;
  governanceJobId: string;
  leaseOwner: string;
  leaseToken: string;
  targetKind: GovernanceTickTargetKind;
  payload: GovernanceTickJobPayload;
  llm?: GovernanceTickLlmPayload;
};

export type GovernanceTickThreadOutcome = {
  governanceJobId: string;
  targetKind: "thread";
  topicId: string;
  threadId: string;
  baseRevision: number;
  result: ThreadTickResult;
  currentTasks?: Task[];
};

export type GovernanceTickTopicOutcome = {
  governanceJobId: string;
  targetKind: "topic";
  topicId: string;
  baseRevision: number;
  patch: TopicPatch;
  ok: boolean;
  error?: string;
  output?: TopicTickOutput;
};

export type GovernanceTickOutcome = GovernanceTickThreadOutcome | GovernanceTickTopicOutcome;

export type GovernanceTickMachineResult = {
  type: GovernanceTickCommandType;
  governanceJobId: string;
  leaseOwner: string;
  leaseToken: string;
  ok: boolean;
  outcome?: GovernanceTickOutcome;
  error?: string;
};

export function commandTypeForGovernanceTarget(targetKind: GovernanceTickTargetKind): GovernanceTickCommandType {
  return targetKind === "topic" ? "topic_governance_tick" : "thread_governance_tick";
}

export function isGovernanceTickCommand(value: unknown): value is GovernanceTickMachineCommand {
  if (!isRecord(value)) return false;
  if (value.type !== "topic_governance_tick" && value.type !== "thread_governance_tick") return false;
  if (!isNonEmptyString(value.requestId)) return false;
  if (!isNonEmptyString(value.governanceJobId)) return false;
  if (!isNonEmptyString(value.leaseOwner)) return false;
  if (!isNonEmptyString(value.leaseToken)) return false;
  if (value.targetKind !== "topic" && value.targetKind !== "thread") return false;
  if (value.type !== commandTypeForGovernanceTarget(value.targetKind)) return false;
  if (!isGovernanceTickPayload(value.payload)) return false;
  return value.payload.targetKind === value.targetKind;
}

export function isGovernanceTickMachineResult(value: unknown): value is GovernanceTickMachineResult {
  if (!isRecord(value)) return false;
  if (value.type !== "topic_governance_tick" && value.type !== "thread_governance_tick") return false;
  if (!isNonEmptyString(value.governanceJobId)) return false;
  if (!isNonEmptyString(value.leaseOwner)) return false;
  if (!isNonEmptyString(value.leaseToken)) return false;
  if (typeof value.ok !== "boolean") return false;
  if (!value.ok) return value.outcome === undefined;
  if (!isGovernanceTickOutcome(value.outcome)) return false;
  return value.type === commandTypeForGovernanceTarget(value.outcome.targetKind) && value.outcome.governanceJobId === value.governanceJobId;
}

export function isGovernanceTickOutcome(value: unknown): value is GovernanceTickOutcome {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.governanceJobId)) return false;
  if (!isNonEmptyString(value.topicId)) return false;
  if (typeof value.baseRevision !== "number" || !Number.isInteger(value.baseRevision) || value.baseRevision < 0) return false;
  if (value.targetKind === "thread") {
    return isNonEmptyString(value.threadId) && isThreadTickResult(value.result);
  }
  if (value.targetKind === "topic") {
    return typeof value.ok === "boolean" && isRecord(value.patch) && (value.output === undefined || isTopicTickOutput(value.output));
  }
  return false;
}

function isGovernanceTickPayload(value: unknown): value is GovernanceTickJobPayload {
  if (!isRecord(value)) return false;
  if (value.targetKind !== "topic" && value.targetKind !== "thread") return false;
  if (!isNonEmptyString(value.topicId)) return false;
  if (value.targetKind === "thread" && !isNonEmptyString(value.threadId)) return false;
  if (typeof value.baseRevision !== "number" || !Number.isInteger(value.baseRevision) || value.baseRevision < 0) return false;
  if (!isRecord(value.snapshot)) return false;
  // P0 修复后新建的 payload 必带这些字段；旧 payload 在 lease 时会被
  // refreshGovernancePayload 重建。两端都没塞才认为是异常 command。
  if (value.targetKind === "thread") {
    if (!isRecord(value.snapshot.topic)) return false;
    if (!isRecord(value.snapshot.thread)) return false;
    if (!Array.isArray(value.snapshot.currentTasks)) return false;
    if (!Array.isArray(value.snapshot.recentTaskInstances)) return false;
  } else {
    if (!isRecord(value.snapshot.topic)) return false;
    if (!Array.isArray(value.snapshot.threads)) return false;
  }
  return true;
}

function isThreadTickResult(value: unknown): value is ThreadTickResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return isRecord(value.patch)
      && isThreadTickPatch(value.patch)
      && isRecord(value.output)
      && isThreadTickOutput(value.output);
  }
  if (value.ok === false) {
    return isRecord(value.patch)
      && isThreadTickPatch(value.patch)
      && isRecord(value.error)
      && isThreadTickFailure(value.error);
  }
  return false;
}

/**
 * §candidate-6 P4：把 patch shape-only 校验升级到 contract 级。
 *
 * ThreadTickPatch 必填：status / lastTickAt / memory / silentCount / failureCount / infraFailureCount。
 * 远端 daemon 序列化的 patch 即使来自被篡改的 JSON，也要在协议边缘就被拒绝，
 * 而不是落到 updateThread 才抛运行时类型错误。
 */
function isThreadTickPatch(patch: Record<string, unknown>): boolean {
  if (patch.status !== "active" && patch.status !== "paused" && patch.status !== "archived") return false;
  if (typeof patch.lastTickAt !== "string" || !patch.lastTickAt) return false;
  if (patch.nextTickAt !== undefined && typeof patch.nextTickAt !== "string") return false;
  if (!isRecord(patch.memory)) return false;
  if (!isNonNegativeInt(patch.silentCount)) return false;
  if (!isNonNegativeInt(patch.failureCount)) return false;
  if (!isNonNegativeInt(patch.infraFailureCount)) return false;
  return true;
}

function isThreadTickFailure(error: Record<string, unknown>): boolean {
  return error.kind === "invoke_error" || error.kind === "validation_error";
}

/**
 * §candidate-6 P4：ThreadTickOutput 的运行时校验。
 *
 * 验证：
 *  - assessment: 非空字符串
 *  - confidence: high | medium | low（之前只检查是字符串）
 *  - actions: 数组，每条 action 走 isThreadTickAction
 */
function isThreadTickOutput(value: Record<string, unknown>): boolean {
  if (typeof value.assessment !== "string") return false;
  if (value.confidence !== "high" && value.confidence !== "medium" && value.confidence !== "low") return false;
  if (!Array.isArray(value.actions)) return false;
  for (const action of value.actions) {
    if (!isThreadTickAction(action)) return false;
  }
  if (value.memoryDelta !== undefined && !isRecord(value.memoryDelta)) return false;
  return true;
}

function isThreadTickAction(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "dispatch_task":
      return isNonEmptyString(value.threadId)
        && isRecord(value.taskDraft)
        && isNonEmptyString(value.reason);
    case "update_task":
      return isNonEmptyString(value.threadId)
        && isNonEmptyString(value.taskId)
        && isRecord(value.patch)
        && isNonEmptyString(value.reason);
    case "cancel_task":
      return isNonEmptyString(value.threadId)
        && isNonEmptyString(value.taskId)
        && isNonEmptyString(value.reason);
    case "archive_thread":
      return isNonEmptyString(value.threadId)
        && isNonEmptyString(value.reason);
    case "post_message":
      return isNonEmptyString(value.threadId)
        && typeof value.text === "string"
        && (value.severity === "info" || value.severity === "warning" || value.severity === "important");
    case "silent":
      return isNonEmptyString(value.reason);
    default:
      return false;
  }
}

/**
 * §candidate-6 P4：TopicTickOutput 的运行时校验。
 *
 * 验证：assessment / confidence enum / actions 数组每条走 isTopicTickAction。
 * 之前只检查是 string + array，会接受 actions: [{}]。
 */
function isTopicTickOutput(value: unknown): value is TopicTickOutput {
  if (!isRecord(value)) return false;
  if (typeof value.assessment !== "string") return false;
  if (value.confidence !== "high" && value.confidence !== "medium" && value.confidence !== "low") return false;
  if (!Array.isArray(value.actions)) return false;
  for (const action of value.actions) {
    if (!isTopicTickAction(action)) return false;
  }
  return true;
}

function isTopicTickAction(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "silent":
    case "mark_running":
    case "mark_completed":
    case "mark_failed":
      return isNonEmptyString(value.reason);
    case "adjust_loop":
      // loop 的细致校验交给 normalizeTriggerSpec；这里只检 reason + loop 是 record
      return isNonEmptyString(value.reason) && isRecord(value.loop);
    default:
      return false;
  }
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
