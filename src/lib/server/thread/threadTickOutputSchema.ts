/**
 * ThreadTickOutput 运行时校验器 — 计划 §3.3.4。
 *
 * 与 `src/lib/server/thread/threadRunnerPrompt.ts`
 * 形成闭环：prompt 写下 8 条必备约束，本模块在解析模型输出时强制校验，
 * 防止模型在结构化输出里偷偷违反约束（缺字段 / 错 kind / silent 与其他动作并存等）。
 *
 * 设计要点：
 *  - 入参 `unknown`（来自 jsonRepair 已修复的 parsed JSON），不假设上游已强类型化。
 *  - 失败时抛 `ThreadTickOutputValidationError`，由 ThreadRunner 计入 failureCount。
 *  - taskDraft 复用 `goalPlanning/taskDraftSchema.ts` 已有的 sanitize 逻辑；
 *    本模块只负责 ThreadRunner 特有的字段（threadId / kind / severity 等）。
 */

import type { TaskDraft } from "@/lib/server/goalPlanning/taskDraftSchema";
import type { Task } from "@/types/kiki";
import { normalizeTriggerSpec } from "@/types/trigger";
import {
  THREAD_TICK_POST_MESSAGE_TEXT_LIMIT,
  type ThreadTickConfidence,
  type ThreadTickAction,
  type ThreadTickOutput,
  type ThreadTickPostMessageSeverity,
} from "@/types/topic";

const POST_MESSAGE_SEVERITIES: ReadonlySet<ThreadTickPostMessageSeverity> = new Set<ThreadTickPostMessageSeverity>([
  "info",
  "warning",
  "important",
]);

const PAYLOAD_BYTE_LIMIT = 8 * 1024;
const ASSESSMENT_TEXT_LIMIT = 120;
const MAX_ACTIONS_PER_TICK = 5;
const MAX_DISPATCH_ACTIONS_PER_TICK = 2;
const MAX_CANCEL_ACTIONS_PER_TICK = 2;

const CONFIDENCES: ReadonlySet<ThreadTickConfidence> = new Set<ThreadTickConfidence>([
  "high",
  "medium",
  "low",
]);

export type ParseThreadTickOutputContext = {
  expectedThreadId: string;
  terminationCondition?: string;
  currentTasks?: Task[];
};

export class ThreadTickOutputValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_object"
      | "actions_not_array"
      | "actions_empty"
      | "silent_with_others"
      | "unknown_kind"
      | "missing_field"
      | "invalid_severity"
      | "invalid_confidence"
      | "thread_id_mismatch"
      | "post_message_too_long"
      | "payload_too_large"
      | "task_draft_invalid"
      | "unknown_root_field"
      | "assessment_too_long"
      | "too_many_actions"
      | "low_confidence_high_risk"
      | "archive_without_termination_condition"
      | "archive_missing_evidence"
      | "cancel_missing_evidence"
      | "duplicate_dispatch_task",
  ) {
    super(message);
    this.name = "ThreadTickOutputValidationError";
  }
}

function asConfidence(value: unknown): ThreadTickConfidence {
  if (typeof value !== "string" || !CONFIDENCES.has(value as ThreadTickConfidence)) {
    throw new ThreadTickOutputValidationError(
      `confidence 必须是 high / medium / low，实际为 ${String(value)}`,
      "invalid_confidence",
    );
  }
  return value as ThreadTickConfidence;
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff]+/gi, "")
    .trim();
}

function containsMeaningfulOverlap(left: string, right: string): boolean {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);
  if (!a || !b) return false;
  if (a.length >= 4 && b.includes(a)) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  return false;
}

// 任务标题/目标判重阈值：基于字符 bigram 的 Dice 系数。
// 子串包含只能挡完全一致的措辞，挡不住“论文综述”vs“代表性论文综述”这类插词改写，
// 因此 dispatch_task 判重需要近似相似度。
const SIMILAR_TASK_TEXT_THRESHOLD = 0.6;

function countBigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const aGrams = countBigrams(a);
  const bGrams = countBigrams(b);
  let intersection = 0;
  for (const [gram, countA] of Array.from(aGrams.entries())) {
    const countB = bGrams.get(gram);
    if (countB) intersection += Math.min(countA, countB);
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

function isSimilarTaskText(left: string, right: string): boolean {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);
  if (!a || !b) return false;
  // 一方完全包含另一方仍判重（兼容旧的子串规则）。
  if (a.length >= 4 && b.includes(a)) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  return diceCoefficient(a, b) >= SIMILAR_TASK_TEXT_THRESHOLD;
}

/**
 * 判断 dispatch_task 草稿是否与 currentTasks 中既有 Task 实质重复。
 *
 * 与 schema 解析阶段同源（threadTickOutputSchema.ts:471-487）；
 * 暴露给 governanceTickDispatcher 在 apply 阶段做兜底复检：
 * 远端 machine 解析 schema 时若 currentTasks 缺失（云路径快照漏装），
 * 本地一侧拿到 fresh currentTasks 后仍能拒绝重复 dispatch_task。
 */
export function isDispatchTaskDuplicate(
  draft: { title?: unknown; objective?: unknown },
  currentTasks: ReadonlyArray<{ title: string; description: string; expectedOutcome: string }>,
): boolean {
  const title = typeof draft.title === "string" ? draft.title : "";
  const objective = typeof draft.objective === "string" ? draft.objective : "";
  return currentTasks.some(
    (task) =>
      isSimilarTaskText(task.title, title) ||
      isSimilarTaskText(task.description, objective) ||
      isSimilarTaskText(task.expectedOutcome, objective),
  );
}

function hasArchiveEvidence(text: string): boolean {
  return /(taskId|instanceId|task[-_\w]*|inst[-_\w]*|instance[-_\w]*|任务|实例|证据|结果|result)/i.test(text);
}

function hasCancelEvidence(text: string): boolean {
  return (
    /(关注点.*(消失|关闭)|永久|已完成.*无需继续|无需继续)/i.test(text) ||
    /((替代|取代|替换).*(taskId|task[-_\w]+)|(taskId|task[-_\w]+).*(替代|取代|替换))/i.test(text)
  );
}

function assertNoUnknownRootFields(root: Record<string, unknown>) {
  const allowed = new Set(["assessment", "confidence", "actions", "memoryDelta"]);
  for (const key of Object.keys(root)) {
    if (!allowed.has(key)) {
      throw new ThreadTickOutputValidationError(
        `ThreadTickOutput 顶层字段 ${key} 不在白名单 assessment / confidence / actions / memoryDelta 中`,
        "unknown_root_field",
      );
    }
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ThreadTickOutputValidationError(
      `字段 ${field} 必须是非空字符串`,
      "missing_field",
    );
  }
  return value.trim();
}

function asPlainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ThreadTickOutputValidationError(
      `字段 ${field} 必须是对象`,
      "missing_field",
    );
  }
  return value as Record<string, unknown>;
}

function normalizeTaskDraftTriggerSpec(raw: Record<string, unknown>): Record<string, unknown> {
  const triggerSpec = normalizeTriggerSpec(raw.triggerSpec as Parameters<typeof normalizeTriggerSpec>[0]);
  return triggerSpec ? { ...raw, triggerSpec } : raw;
}

function parseAction(raw: unknown, expectedThreadId: string): ThreadTickAction {
  const obj = asPlainObject(raw, "action");
  const kind = obj.kind;
  switch (kind) {
    case "dispatch_task": {
      const threadId = asString(obj.threadId, "action.threadId");
      if (threadId !== expectedThreadId) {
        throw new ThreadTickOutputValidationError(
          `dispatch_task.threadId(${threadId}) 与当前 Thread(${expectedThreadId}) 不一致；禁止跨 Thread 派发`,
          "thread_id_mismatch",
        );
      }
      const reason = asString(obj.reason, "action.reason");
      const taskDraftRaw = asPlainObject(obj.taskDraft, "action.taskDraft");
      const title = asString(taskDraftRaw.title, "action.taskDraft.title");
      // taskDraft 仅做最小校验（必填 title）；
      // 完整字段 sanitize 由下游派发逻辑调用 taskDraftSchema 处理。
      const taskDraft: TaskDraft = {
        ...normalizeTaskDraftTriggerSpec(taskDraftRaw),
        title,
      } as TaskDraft;
      return {
        kind: "dispatch_task",
        threadId,
        reason,
        taskDraft,
      };
    }
    case "update_task": {
      const threadId = asString(obj.threadId, "action.threadId");
      if (threadId !== expectedThreadId) {
        throw new ThreadTickOutputValidationError(
          `update_task.threadId(${threadId}) 与当前 Thread(${expectedThreadId}) 不一致；禁止跨 Thread 修改`,
          "thread_id_mismatch",
        );
      }
      const taskId = asString(obj.taskId, "action.taskId");
      const reason = asString(obj.reason, "action.reason");
      const patchRaw = asPlainObject(obj.patch, "action.patch");
      return {
        kind: "update_task",
        threadId,
        taskId,
        reason,
        patch: normalizeTaskDraftTriggerSpec(patchRaw) as Partial<TaskDraft>,
      };
    }
    case "cancel_task": {
      const threadId = asString(obj.threadId, "action.threadId");
      if (threadId !== expectedThreadId) {
        throw new ThreadTickOutputValidationError(
          `cancel_task.threadId(${threadId}) 与当前 Thread(${expectedThreadId}) 不一致；禁止跨 Thread 删除`,
          "thread_id_mismatch",
        );
      }
      const taskId = asString(obj.taskId, "action.taskId");
      const reason = asString(obj.reason, "action.reason");
      return {
        kind: "cancel_task",
        threadId,
        taskId,
        reason,
      };
    }
    case "archive_thread": {
      const threadId = asString(obj.threadId, "action.threadId");
      if (threadId !== expectedThreadId) {
        throw new ThreadTickOutputValidationError(
          `archive_thread.threadId(${threadId}) 与当前 Thread(${expectedThreadId}) 不一致；禁止跨 Thread 归档`,
          "thread_id_mismatch",
        );
      }
      const reason = asString(obj.reason, "action.reason");
      return {
        kind: "archive_thread",
        threadId,
        reason,
      };
    }
    case "post_message": {
      const threadId = asString(obj.threadId, "action.threadId");
      if (threadId !== expectedThreadId) {
        throw new ThreadTickOutputValidationError(
          `post_message.threadId(${threadId}) 与当前 Thread(${expectedThreadId}) 不一致`,
          "thread_id_mismatch",
        );
      }
      const text = asString(obj.text, "action.text");
      if (text.length > THREAD_TICK_POST_MESSAGE_TEXT_LIMIT) {
        throw new ThreadTickOutputValidationError(
          `post_message.text 长度 ${text.length} 超过 ${THREAD_TICK_POST_MESSAGE_TEXT_LIMIT} 字上限`,
          "post_message_too_long",
        );
      }
      const severity = obj.severity;
      if (typeof severity !== "string" || !POST_MESSAGE_SEVERITIES.has(severity as ThreadTickPostMessageSeverity)) {
        throw new ThreadTickOutputValidationError(
          `post_message.severity 必须是 info / warning / important，实际为 ${String(severity)}`,
          "invalid_severity",
        );
      }
      return {
        kind: "post_message",
        threadId,
        text,
        severity: severity as ThreadTickPostMessageSeverity,
      };
    }
    case "silent": {
      const reason = asString(obj.reason, "action.reason");
      return { kind: "silent", reason };
    }
    default:
      throw new ThreadTickOutputValidationError(
        `未知 action.kind=${String(kind)}；允许值：dispatch_task / update_task / cancel_task / archive_thread / post_message / silent`,
        "unknown_kind",
      );
  }
}

/**
 * 解析并校验 ThreadRunner 决策层输出。
 *
 * @param parsed jsonRepair 后的对象（可能是任何形状）
 * @param expectedThreadId 当前 Thread.id；所有结构化 action 的 threadId
 *                         必须与此一致，否则抛 thread_id_mismatch。
 */
export function parseThreadTickOutput(
  parsed: unknown,
  expectedThreadIdOrContext: string | ParseThreadTickOutputContext,
): ThreadTickOutput {
  const context =
    typeof expectedThreadIdOrContext === "string"
      ? { expectedThreadId: expectedThreadIdOrContext }
      : expectedThreadIdOrContext;
  const { expectedThreadId } = context;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ThreadTickOutputValidationError(
      "ThreadTickOutput 必须是对象",
      "not_object",
    );
  }

  // 8KB payload 守卫（计划 §3.3.4 第 8 条）
  let payloadBytes: number;
  try {
    payloadBytes = Buffer.byteLength(JSON.stringify(parsed), "utf-8");
  } catch {
    throw new ThreadTickOutputValidationError(
      "ThreadTickOutput 序列化失败（含循环引用或不可序列化字段）",
      "payload_too_large",
    );
  }
  if (payloadBytes > PAYLOAD_BYTE_LIMIT) {
    throw new ThreadTickOutputValidationError(
      `ThreadTickOutput payload ${payloadBytes}B 超过 ${PAYLOAD_BYTE_LIMIT}B 硬约束`,
      "payload_too_large",
    );
  }

  const root = parsed as Record<string, unknown>;
  assertNoUnknownRootFields(root);

  const assessment = asString(root.assessment, "assessment");
  if (assessment.length > ASSESSMENT_TEXT_LIMIT) {
    throw new ThreadTickOutputValidationError(
      `assessment 长度 ${assessment.length} 超过 ${ASSESSMENT_TEXT_LIMIT} 字上限`,
      "assessment_too_long",
    );
  }
  const confidence = asConfidence(root.confidence);

  const actionsRaw = root.actions;
  if (!Array.isArray(actionsRaw)) {
    throw new ThreadTickOutputValidationError(
      "ThreadTickOutput.actions 必须是数组",
      "actions_not_array",
    );
  }
  if (actionsRaw.length === 0) {
    throw new ThreadTickOutputValidationError(
      "ThreadTickOutput.actions 不能为空，至少包含 1 个 silent / post_message / dispatch_task",
      "actions_empty",
    );
  }
  if (actionsRaw.length > MAX_ACTIONS_PER_TICK) {
    throw new ThreadTickOutputValidationError(
      `ThreadTickOutput.actions 最多 ${MAX_ACTIONS_PER_TICK} 个，实际 ${actionsRaw.length} 个`,
      "too_many_actions",
    );
  }

  const actions = actionsRaw.map((raw) => parseAction(raw, expectedThreadId));
  enforceRiskGuards(actions, assessment, confidence, context);

  // 计划 §3.3.4 第 3 条：仅当无结构性动作与 post_message 时才允许 silent
  const hasNonSilent = actions.some(
    (a) =>
      a.kind === "dispatch_task" ||
      a.kind === "update_task" ||
      a.kind === "cancel_task" ||
      a.kind === "archive_thread" ||
      a.kind === "post_message",
  );
  const hasSilent = actions.some((a) => a.kind === "silent");
  if (hasSilent && hasNonSilent) {
    throw new ThreadTickOutputValidationError(
      "silent 不能与 dispatch_task / post_message 并存（§3.3.4 第 3 条）",
      "silent_with_others",
    );
  }

  let memoryDelta: Record<string, unknown> | undefined;
  if (root.memoryDelta !== undefined) {
    memoryDelta = asPlainObject(root.memoryDelta, "memoryDelta");
  }

  return memoryDelta ? { assessment, confidence, actions, memoryDelta } : { assessment, confidence, actions };
}

function enforceRiskGuards(
  actions: ThreadTickAction[],
  assessment: string,
  confidence: ThreadTickConfidence,
  context: ParseThreadTickOutputContext,
) {
  const dispatchActions = actions.filter((a): a is Extract<ThreadTickAction, { kind: "dispatch_task" }> => a.kind === "dispatch_task");
  const cancelActions = actions.filter((a): a is Extract<ThreadTickAction, { kind: "cancel_task" }> => a.kind === "cancel_task");
  if (dispatchActions.length > MAX_DISPATCH_ACTIONS_PER_TICK) {
    throw new ThreadTickOutputValidationError(
      `dispatch_task 最多 ${MAX_DISPATCH_ACTIONS_PER_TICK} 个，实际 ${dispatchActions.length} 个`,
      "too_many_actions",
    );
  }
  if (cancelActions.length > MAX_CANCEL_ACTIONS_PER_TICK) {
    throw new ThreadTickOutputValidationError(
      `cancel_task 最多 ${MAX_CANCEL_ACTIONS_PER_TICK} 个，实际 ${cancelActions.length} 个`,
      "too_many_actions",
    );
  }

  for (const action of actions) {
    if (
      confidence === "low" &&
      (action.kind === "archive_thread" || action.kind === "cancel_task" || action.kind === "dispatch_task")
    ) {
      throw new ThreadTickOutputValidationError(
        `confidence=low 时禁止 ${action.kind}，请改用 post_message 或 silent`,
        "low_confidence_high_risk",
      );
    }

    if (action.kind === "archive_thread") {
      const terminationCondition = context.terminationCondition?.trim();
      if (!terminationCondition) {
        throw new ThreadTickOutputValidationError(
          "archive_thread 需要当前 Thread 存在 terminationCondition",
          "archive_without_termination_condition",
        );
      }
      const evidenceText = `${assessment}\n${action.reason}`;
      if (!containsMeaningfulOverlap(evidenceText, terminationCondition) || !hasArchiveEvidence(evidenceText)) {
        throw new ThreadTickOutputValidationError(
          "archive_thread.reason/assessment 必须引用 terminationCondition 且包含 taskId/instanceId/结果等证据",
          "archive_missing_evidence",
        );
      }
    }

    if (action.kind === "cancel_task") {
      const evidenceText = `${assessment}\n${action.reason}`;
      if (!hasCancelEvidence(evidenceText)) {
        throw new ThreadTickOutputValidationError(
          "cancel_task.reason/assessment 必须说明关注点永久消失、已完成且无需继续，或被明确 taskId 替代",
          "cancel_missing_evidence",
        );
      }
    }

    if (action.kind === "dispatch_task") {
      const currentTasks = context.currentTasks ?? [];
      const title = typeof action.taskDraft.title === "string" ? action.taskDraft.title : "";
      const objective = typeof action.taskDraft.objective === "string" ? action.taskDraft.objective : "";
      const hasDuplicate = currentTasks.some(
        (task) =>
          isSimilarTaskText(task.title, title) ||
          isSimilarTaskText(task.description, objective) ||
          isSimilarTaskText(task.expectedOutcome, objective),
      );
      if (hasDuplicate) {
        throw new ThreadTickOutputValidationError(
          "dispatch_task 与当前 Thread 下既有 Task 的 title/objective 相近，请改用 update_task",
          "duplicate_dispatch_task",
        );
      }
    }
  }
}
