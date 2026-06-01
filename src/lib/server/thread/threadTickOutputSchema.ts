/**
 * ThreadTickOutput 运行时校验器 — 计划 §3.3.4。
 *
 * 与 [threadRunnerPrompt.ts](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/server/thread/threadRunnerPrompt.ts)
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
import {
  THREAD_TICK_POST_MESSAGE_TEXT_LIMIT,
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
      | "thread_id_mismatch"
      | "post_message_too_long"
      | "payload_too_large"
      | "task_draft_invalid",
  ) {
    super(message);
    this.name = "ThreadTickOutputValidationError";
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
      // 计划 §3.3.4 第 5 条：taskDraft 中禁止携带 taskType（由 ThreadRunner 固定写入）
      if ("taskType" in taskDraftRaw) {
        throw new ThreadTickOutputValidationError(
          "taskDraft 中禁止包含 taskType 字段（由 ThreadRunner 固定写入 one_shot）",
          "task_draft_invalid",
        );
      }
      // taskDraft 仅做最小校验（必填 title + 禁止 taskType）；
      // 完整字段 sanitize 由下游派发逻辑调用 taskDraftSchema 处理。
      const taskDraft: TaskDraft = {
        ...(taskDraftRaw as Record<string, unknown>),
        title,
      } as TaskDraft;
      return {
        kind: "dispatch_task",
        threadId,
        reason,
        taskDraft,
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
        `未知 action.kind=${String(kind)}；允许值：dispatch_task / post_message / silent`,
        "unknown_kind",
      );
  }
}

/**
 * 解析并校验 ThreadRunner 决策层输出。
 *
 * @param parsed jsonRepair 后的对象（可能是任何形状）
 * @param expectedThreadId 当前 Thread.id；所有 dispatch_task / post_message 的 threadId
 *                         必须与此一致，否则抛 thread_id_mismatch。
 */
export function parseThreadTickOutput(
  parsed: unknown,
  expectedThreadId: string,
): ThreadTickOutput {
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

  const actions = actionsRaw.map((raw) => parseAction(raw, expectedThreadId));

  // 计划 §3.3.4 第 3 条：仅当无 dispatch_task 与 post_message 时才允许 silent
  const hasNonSilent = actions.some(
    (a) => a.kind === "dispatch_task" || a.kind === "post_message",
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

  return memoryDelta ? { actions, memoryDelta } : { actions };
}
