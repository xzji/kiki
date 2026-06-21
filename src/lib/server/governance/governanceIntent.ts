import type { TaskPatch } from "./taskPatchMerge";

export const GOVERNANCE_INTENTS = [
  "amend_task",
  "rerun_current",
  "create_task",
  "update_task",
  "cancel_task",
  "dispatch_task",
  "pause_task",
  "replan",
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

/**
 * §4.5-②：amend/update 改的是任务定义，本身不触发执行。判官据用户语气区分两类语义：
 * - redo_now：用户盯着错误结果要求"改成 X"，改完应立刻按新定义重跑一次。
 * - next_time：用户调整长期标准，仅改定义、下次执行生效，不重跑。
 * 未指定时按 next_time 处理（保守：不擅自消耗执行）。
 */
export type GovernanceApplyMode = "redo_now" | "next_time";

export type GovernanceJudgeResult = {
  intent: GovernanceIntent;
  targetRef: TaskRef | null;
  confidence: number;
  patch?: TaskPatch;
  revisionHint?: string;
  applyMode?: GovernanceApplyMode;
  assistantMessage: string;
  reason?: string;
  _degraded?: boolean;
  /** §4.5-④：原判官想要的意图，被归一化降级后保留原值，仅供埋点统计（如 replan→clarify）。 */
  _downgradedFrom?: GovernanceIntent;
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

function normalizeApplyMode(value: unknown): GovernanceApplyMode | undefined {
  return value === "redo_now" || value === "next_time" ? value : undefined;
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
  const applyMode = normalizeApplyMode(value.applyMode) ?? normalizeApplyMode(value.apply_mode);
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
    applyMode,
    assistantMessage,
    reason: text(value.reason),
  };
  // §4.5-④：整盘重规划（replan）会清空所有任务历史、且执行中目标直接 409，与「保留历史」初衷冲突。
  // 按用户实际频率分布（绝大多数是单任务调整），这里把 replan 降级为 clarify 引导用户逐项调整，
  // 不走破坏性整盘替换；_downgradedFrom 保留原意图供埋点统计「用户多久想要一次整盘 replan」。
  if (intent === "replan") {
    return {
      ...result,
      intent: "clarify",
      _downgradedFrom: "replan",
      assistantMessage:
        "整盘重新规划暂不支持对进行中的目标直接整体替换（会丢失已有执行记录）。你具体想调整哪几个任务？告诉我，我可以逐个帮你改标准、重跑或新建。",
    };
  }
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
