import type { GovernanceTickJobPayload, GovernanceTickTargetKind } from "@/lib/server/repositories/governanceTickJobsRepository";
import type { TopicPatch } from "@/lib/server/repositories/topicsRepository";
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
    return typeof value.ok === "boolean" && isRecord(value.patch);
  }
  return false;
}

function isGovernanceTickPayload(value: unknown): value is GovernanceTickJobPayload {
  if (!isRecord(value)) return false;
  if (value.targetKind !== "topic" && value.targetKind !== "thread") return false;
  if (!isNonEmptyString(value.topicId)) return false;
  if (value.targetKind === "thread" && !isNonEmptyString(value.threadId)) return false;
  if (typeof value.baseRevision !== "number" || !Number.isInteger(value.baseRevision) || value.baseRevision < 0) return false;
  return isRecord(value.snapshot);
}

function isThreadTickResult(value: unknown): value is ThreadTickResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return isRecord(value.patch) && isRecord(value.output);
  }
  if (value.ok === false) {
    return isRecord(value.patch) && isRecord(value.error);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
