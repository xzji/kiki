import type { TaskPatch } from "./taskPatchMerge";

export const GOVERNANCE_INTENTS = [
  "amend_task",
  "rerun_current",
  "create_task",
  "update_task",
  "cancel_task",
  "dispatch_task",
  "pause_task",
  "chitchat",
  "qa",
  "clarify",
] as const;

export type GovernanceIntent = (typeof GOVERNANCE_INTENTS)[number];

export type TaskRef = {
  goalId: string;
  subGoalId: string;
  taskId: string;
  instanceId?: string;
};

export type GovernanceJudgeResult = {
  intent: GovernanceIntent;
  targetRef: TaskRef | null;
  confidence: number;
  patch?: TaskPatch;
  revisionHint?: string;
  assistantMessage: string;
  reason?: string;
  _degraded?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeIntent(value: unknown): GovernanceIntent {
  return GOVERNANCE_INTENTS.includes(value as GovernanceIntent) ? (value as GovernanceIntent) : "chitchat";
}

function normalizeConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function normalizeTaskRef(value: unknown): TaskRef | null {
  const record = isRecord(value) ? value : null;
  const goalId = text(record?.goalId);
  const subGoalId = text(record?.subGoalId);
  const taskId = text(record?.taskId);
  if (!goalId || !subGoalId || !taskId) return null;
  return {
    goalId,
    subGoalId,
    taskId,
    instanceId: text(record?.instanceId),
  };
}

export function buildDegradedGovernanceResult(message = "我会按普通对话处理这条消息。"): GovernanceJudgeResult {
  return {
    intent: "chitchat",
    targetRef: null,
    confidence: 0,
    assistantMessage: message,
    _degraded: true,
  };
}

export function normalizeGovernanceJudgeResult(value: unknown, fallbackRef?: TaskRef): GovernanceJudgeResult {
  if (!isRecord(value)) {
    return buildDegradedGovernanceResult("治理意图判断结果不是合法对象。");
  }
  const intent = normalizeIntent(value.intent);
  const targetRef = normalizeTaskRef(value.targetRef) ?? fallbackRef ?? null;
  const confidence = normalizeConfidence(value.confidence);
  const patch = isRecord(value.patch) ? (value.patch as TaskPatch) : undefined;
  const revisionHint = text(value.revisionHint) ?? text(value.revision_hint);
  const assistantMessage =
    text(value.assistantMessage) ??
    text(value.assistant_message) ??
    (intent === "clarify" ? "你希望我具体调整哪个任务或结果？" : "我已理解你的诉求。");
  const result: GovernanceJudgeResult = {
    intent,
    targetRef,
    confidence,
    patch,
    revisionHint,
    assistantMessage,
    reason: text(value.reason),
  };
  if (confidence < 0.55 && intent !== "chitchat" && intent !== "qa") {
    return {
      ...result,
      intent: "clarify",
      assistantMessage: "我不太确定你要操作哪个任务。请再明确一下要修改、重跑、新建还是删除。",
    };
  }
  if ((intent === "amend_task" || intent === "update_task" || intent === "create_task") && !patch) {
    return {
      ...result,
      intent: "clarify",
      assistantMessage: "我理解你想调整任务，但还缺少可执行的修改内容。请说明要新增或修改哪些要求。",
    };
  }
  if (intent === "rerun_current" && !revisionHint) {
    return {
      ...result,
      intent: "clarify",
      assistantMessage: "我理解你想重跑当前结果，但还缺少修订要求。请说明这次要重点改哪里。",
    };
  }
  return result;
}
