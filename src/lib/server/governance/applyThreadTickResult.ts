/**
 * applyThreadTickResult — Thread tick 结果统一应用模块（共享尾路）。
 *
 * 设计目标：
 *  - in-process（threadGovernor.tickOneThread）和 cloud-orchestrated
 *    （governanceTickDispatcher.applyThreadOutcome）两条路径过去各自
 *    实现"派发动作 → 写回 patch → 记 history → 推通知"四件事，导致 drift：
 *      • record 一边带 actionDetails 一边不带
 *      • pause 一边走 inbox 一边走会话流
 *      • dispatch 错误一边写回 patch 一边不写回
 *  - 本模块把这条 tail 做成一个 deep module：
 *    输入是 ThreadTickResult + callbacks，输出是结构化 ApplyOutcome；
 *    caller 根据 ApplyOutcome 自行决策下一步（如 partial-failure 重试）。
 *
 * 不变量：
 *  1. 派发顺序：dispatchThreadActions（先 task 后 message）→ persist patch →
 *     record → notify；任一步失败仅影响后续步骤的可观测性，不影响已发生的副作用。
 *  2. dispatch 失败（errors.length > 0）时 caller 决定是否 persist；本模块通过
 *     `dispatchHadErrors` 告诉 caller，不强制走单一策略。
 *  3. pause 双通道：thread 因 failure_threshold pause 时同时写 inbox + 会话流，
 *     共享 traceId 便于追溯。
 *  4. record 总是带 actionDetails（如果 result.ok）和 infraFailureCount。
 *
 * 不做的事：
 *  - 不创建 / 不更新 agent_run（caller 负责生命周期；in-process 由 daemon
 *    内部，cloud 由 governanceTickDispatcher.recordDispatcherTickHistory）。
 *  - 不决定重试次数；返回 dispatchHadErrors / staleRevision 让 caller 决策。
 *  - 不重新计算 patch；patch 来自 ThreadTickResult.patch，由 ThreadRunner 决定。
 */

import {
  dispatchThreadActions,
  type CancelTaskCallback,
  type DispatchTaskCallback,
  type DispatchThreadActionsResult,
  type SendThreadMessageCallback,
  type UpdateTaskCallback,
} from "@/lib/server/governance/dispatchActions";
import {
  buildThreadActionDetails,
  type GovernanceActionPresentation,
} from "@/lib/server/governance/governanceActionPresentation";
import { pushGovernanceChangeNotification } from "@/lib/server/governance/governanceChangeNotifications";
import {
  recordEntity as recordLoopEntity,
  type LoopTickPhase,
} from "@/lib/server/observability/loopTickLog";
import { appendInboxMessage } from "@/lib/server/repositories/inboxRepository";
import {
  ThreadRevisionMismatchError,
  updateThread,
} from "@/lib/server/repositories/threadsRepository";
import { buildThreadTickContext } from "@/lib/server/governance/governanceTickContext";
import type { Task } from "@/types/kiki";
import type { Thread, Topic } from "@/types/topic";
import type { ThreadTickResult } from "@/lib/server/thread/threadRunner";

/** 派发回调集合；一份接口同时被 in-process 与 cloud 路径使用。 */
export type ApplyThreadTickResultCallbacks = {
  dispatchTask: DispatchTaskCallback;
  updateTask?: UpdateTaskCallback;
  cancelTask?: CancelTaskCallback;
  sendThreadMessage: SendThreadMessageCallback;
};

export type ApplyThreadTickResultInput = {
  topic: Topic;
  thread: Thread;
  /** Thread tick 输入端的 baseRevision；写回时作乐观锁。 */
  baseRevision: number;
  agentRunId: string;
  result: ThreadTickResult;
  /**
   * fresh currentTasks 列表；caller 提供（dispatcher 已 prefetch / governor 已 collect）。
   * 缺省时本模块从 envelope 现取作兜底。
   */
  currentTasks?: Task[];
  callbacks: ApplyThreadTickResultCallbacks;
  /**
   * tick 起讫时间戳；用于写 loopTickLog；caller 控制时钟。
   */
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /**
   * 是否要写回 thread patch。
   *  - true（默认 / in-process）：dispatch 完成后照常 persist
   *  - false（cloud + partial-failure 重试 < N）：dispatch 完成但不 persist，
   *    let caller 把 job 放回 queued 等下次重试
   *  - "auto-skip-on-dispatch-errors"：自动判 dispatch.errors，errors > 0 时跳过 persist
   *    （cloud 当前默认行为，等 P1 重试机制接入后会换成显式 false）
   */
  persistPatchPolicy?: "always" | "skip" | "auto-skip-on-dispatch-errors";
  /** trace 前缀，便于 inbox / 会话流 / loopTickLog 关联。 */
  traceIdPrefix: string;
};

export type ApplyThreadTickResultOutput = {
  /** 实际执行的 dispatch 结果；result.ok=false 时为 undefined。 */
  dispatch?: DispatchThreadActionsResult;
  /** dispatch 阶段是否产生 errors（caller 可据此决策 partial-failure 重试）。 */
  dispatchHadErrors: boolean;
  /** patch 是否被写回（要么 shouldPersistPatch=false，要么乐观锁冲突）。 */
  patchPersisted: boolean;
  /** 写回时遇到 ThreadRevisionMismatchError。 */
  staleRevision: boolean;
  /** loopTickLog 是否成功写入。 */
  recorded: boolean;
  /** change notification 是否被推送（pause / 实际动作时才推）。 */
  notified: boolean;
  /** 派发详情（用于 caller 进一步可视化）。 */
  actionDetails: GovernanceActionPresentation[];
};

/**
 * 应用一次 ThreadTickResult。
 *
 * 步骤（顺序敏感）：
 *  1. result.ok：dispatchThreadActions（先 task 后 message）
 *  2. shouldPersistPatch：写回 thread patch（带乐观锁）
 *  3. 记录 loopTickLog
 *  4. pause 时双写 inbox + 会话流；其他变化推会话流通知
 */
export async function applyThreadTickResult(
  input: ApplyThreadTickResultInput,
): Promise<ApplyThreadTickResultOutput> {
  const persistPolicy = input.persistPatchPolicy ?? "always";

  // -- 1. dispatch ---------------------------------------------------------
  let dispatch: DispatchThreadActionsResult | undefined;
  if (input.result.ok) {
    // §candidate-3 P5：fallback 走 buildThreadTickContext，与入队侧 / 远端 daemon
    // 共用同一获取入口；之前直调 goalsSnapshotThreadTaskView 是同源不同接口。
    const currentTasks =
      input.currentTasks ??
      (() => {
        const ctx = buildThreadTickContext({ topicId: input.topic.id, threadId: input.thread.id });
        return ctx.ok ? ctx.data.currentTasks : [];
      })();
    dispatch = await dispatchThreadActions({
      topicId: input.topic.id,
      threadId: input.thread.id,
      output: input.result.output,
      currentTasks,
      callbacks: input.callbacks,
    });
  }
  const dispatchHadErrors = (dispatch?.errors.length ?? 0) > 0;

  // -- 2. persist patch -----------------------------------------------------
  // policy:
  //   always              → 任意情况下都写回（in-process 路径）
  //   skip                → 任意情况下都不写回（caller 显式阻断；P1 重试机制用）
  //   auto-skip-on-errors → dispatch 出错时不写回（cloud 当前行为，配合 lease 重试）
  const shouldPersistPatch =
    persistPolicy === "skip"
      ? false
      : persistPolicy === "auto-skip-on-dispatch-errors"
        ? !dispatchHadErrors
        : true;
  let patchPersisted = false;
  let staleRevision = false;
  if (shouldPersistPatch) {
    try {
      updateThread(
        input.thread.id,
        {
          loopInterval: input.result.patch.loopInterval,
          status: input.result.patch.status,
          lastTickAt: input.result.patch.lastTickAt,
          nextTickAt: input.result.patch.nextTickAt,
          memory: input.result.patch.memory,
          silentCount: input.result.patch.silentCount,
          failureCount: input.result.patch.failureCount,
          ...(input.result.patch.infraFailureCount !== undefined
            ? { infraFailureCount: input.result.patch.infraFailureCount }
            : {}),
        },
        input.baseRevision,
      );
      patchPersisted = true;
    } catch (error) {
      if (error instanceof ThreadRevisionMismatchError) {
        staleRevision = true;
      } else {
        throw error;
      }
    }
  }

  // -- 3. record loopTickLog ------------------------------------------------
  const actionDetails = input.result.ok
    ? buildThreadActionDetails({ output: input.result.output, dispatch })
    : [];
  let recorded = false;
  try {
    recordLoopEntity({
      kind: "thread",
      entityId: input.thread.id,
      parentId: input.topic.id,
      agentRunId: input.agentRunId,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      ok: input.result.ok,
      phase: derivePhase(input.result, dispatchHadErrors),
      failureReason: deriveFailureReason(input.result, dispatch),
      errorKind: input.result.ok ? undefined : input.result.error.kind,
      dispatchedTaskCount: dispatch?.dispatchedTasks.length ?? 0,
      updatedTaskCount: dispatch?.updatedTasks.length ?? 0,
      cancelledTaskCount: dispatch?.cancelledTasks.length ?? 0,
      sentMessageCount: dispatch?.sentMessages.length ?? 0,
      silentCount: dispatch?.silentReasons.length ?? 0,
      assessment: input.result.ok ? input.result.output.assessment : undefined,
      confidence: input.result.ok ? input.result.output.confidence : undefined,
      pauseReason:
        input.result.pauseReason === "failure_threshold" ? "failure_threshold" : undefined,
      failureCount: input.result.patch.failureCount,
      actionDetails,
    });
    recorded = true;
  } catch (error) {
    console.warn("[governance] applyThreadTickResult: record loopTickLog failed", error);
  }

  // -- 4. pause + change notification --------------------------------------
  let notified = false;
  if (patchPersisted) {
    const paused = input.result.pauseReason === "failure_threshold";
    notified = await emitChangeNotifications({
      topicId: input.topic.id,
      threadId: input.thread.id,
      threadTitle: input.thread.title,
      failureCount: input.result.patch.failureCount,
      dispatch,
      actionDetails,
      paused,
      agentRunId: input.agentRunId,
      traceIdPrefix: input.traceIdPrefix,
    });
  }

  return {
    dispatch,
    dispatchHadErrors,
    patchPersisted,
    staleRevision,
    recorded,
    notified,
    actionDetails,
  };
}

function derivePhase(
  result: ThreadTickResult,
  dispatchHadErrors: boolean,
): LoopTickPhase {
  if (!result.ok) return "failed";
  if (dispatchHadErrors) return "dispatch_partial_failure";
  return "completed";
}

function deriveFailureReason(
  result: ThreadTickResult,
  dispatch: DispatchThreadActionsResult | undefined,
): string | undefined {
  if (!result.ok) return result.error.kind;
  if (dispatch && dispatch.errors.length > 0) {
    return `dispatch_partial_failure(${dispatch.errors.length})`;
  }
  return undefined;
}

/**
 * 双通道发 pause / change 通知。
 *
 * - paused=true：inbox 卡片（高可见）+ 会话流治理消息（保留语境）
 * - paused=false：仅会话流（dispatched/updated/cancelled 等动作的标准入口）
 *
 * 共享 traceId 便于审计追溯（同一次 pause 在两端 ID 关联）。
 */
async function emitChangeNotifications(input: {
  topicId: string;
  threadId: string;
  threadTitle: string;
  failureCount: number;
  dispatch?: DispatchThreadActionsResult;
  actionDetails: GovernanceActionPresentation[];
  paused: boolean;
  agentRunId: string;
  traceIdPrefix: string;
}): Promise<boolean> {
  const traceId = `${input.traceIdPrefix}:${input.agentRunId}`;
  let notified = false;
  if (input.paused) {
    try {
      appendInboxMessage({
        topicId: input.topicId,
        threadId: input.threadId,
        text: `线程「${input.threadTitle}」连续失败 ${input.failureCount} 次，已自动暂停。`,
        severity: "warning",
        source: "thread_paused",
        traceId,
      });
      notified = true;
    } catch (error) {
      console.warn("[governance] applyThreadTickResult: append inbox pause notice failed", error);
    }
  }
  try {
    const pushed = pushGovernanceChangeNotification({
      topicId: input.topicId,
      threadId: input.threadId,
      dispatch: input.dispatch,
      actionDetails: input.actionDetails,
      paused: input.paused,
      traceId,
    });
    if (pushed) notified = true;
  } catch (error) {
    console.warn("[governance] applyThreadTickResult: push change notification failed", error);
  }
  return notified;
}
