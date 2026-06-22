import assert from "node:assert/strict";
import {
  awaitingCtxFrom,
  buildAwaitingConfirmationFromRaw,
  coerceMissingUserContextBlocker,
  resolveAwaitingUser,
  type AwaitingUserContext,
} from "./awaitingUserResolver";
import type { ParsedTaskRunnerResult } from "./taskRunnerTypes";
import type { InteractionRequirement, Task, TaskInstance } from "@/types/kiki";

/**
 * awaitingUserResolver 三入口的行为契约。验证 grilling 期定下的语义边界:
 *   - resolveAwaitingUser  = coerce + resume 自动解决(repair/acceptance 编排用)
 *   - coerceMissingUserContextBlocker = 只 coerce(验收 needs_user 路径用)
 *   - buildAwaitingConfirmationFromRaw = 从非结构化 raw 构造(unstructured 兜底用)
 *
 * Q12 修正的关键点:验收路径若调 resolveAwaitingUser 而非 coerce-only,
 * 会在 resumeContext 含"确认继续"时把本该 awaiting 的阻塞误自动完成。
 * 此 spec 用专门用例锁定该边界。
 */

function buildCtx(overrides: Partial<{ resumeContext: string; taskTitle: string; expectedOutcome: string }> = {}): AwaitingUserContext {
  return {
    task: {
      id: "task-1",
      title: overrides.taskTitle ?? "整理行程方案",
      expectedOutcome: overrides.expectedOutcome ?? "一份可执行的行程清单",
      expectedResult: { type: "deliverable", completionCriteria: "包含日期与航班" },
      resultViewKind: "generic_result",
      executionKind: "generic_result",
      collaboration: undefined,
    } as unknown as Task,
    instance: { id: "instance-1" } as unknown as TaskInstance,
    resumeContext: overrides.resumeContext,
  };
}

function buildResult(overrides: Partial<ParsedTaskRunnerResult> = {}): ParsedTaskRunnerResult {
  const base: ParsedTaskRunnerResult = {
    summary: "执行中",
    finalMessage: "需要进一步确认",
    resultViewKind: "generic_result",
    awaitingUser: true,
    awaitingReason: "需要用户确认出发城市",
    suggestedActions: [],
    artifacts: [],
    taskResult: null,
    deliverableCheck: null,
    interactionRequirement: {
      type: "provide_context",
      timing: "before_execution",
      reason: "请补充出发城市",
      question: "你从哪个城市出发?",
      options: [],
      suggestedActions: [],
      shouldNotifyUser: true,
    } as InteractionRequirement,
    blocker: null,
    structuredOutput: null,
  };
  return { ...base, ...overrides };
}

export function runAwaitingUserResolverSpecs() {
  // -------------- coerceMissingUserContextBlocker --------------
  // 1. 触发条件:awaitingUser=true 且 interaction.type=provide_context
  //    → 应注入 readiness/blocker/taskResult 等结构化字段
  {
    const ctx = buildCtx();
    const result = buildResult();
    const coerced = coerceMissingUserContextBlocker(ctx, result);
    assert.equal(coerced.awaitingUser, true, "coerce 应保持 awaitingUser");
    assert.equal(coerced.interactionRequirement.type, "provide_context");
    assert.ok(coerced.taskResult, "coerce 应构造 taskResult");
    assert.equal(coerced.taskResult?.status, "pending_user");
    assert.ok(coerced.deliverableCheck, "coerce 应构造 deliverableCheck");
    assert.equal(coerced.deliverableCheck?.matched, false);
    assert.equal(coerced.deliverableCheck?.confidence, "high");
    assert.ok((coerced.structuredOutput as Record<string, unknown>)?.blockedByMissingUserContext, "structuredOutput 应标 blocked");
  }

  // 2. 不触发条件:result 不像缺用户上下文(awaitingUser=false)→ 原样返回
  {
    const ctx = buildCtx();
    const result = buildResult({ awaitingUser: false, interactionRequirement: {
      type: "none", timing: "not_required", reason: "", question: "", options: [], suggestedActions: [], shouldNotifyUser: false,
    } as InteractionRequirement });
    const coerced = coerceMissingUserContextBlocker(ctx, result);
    assert.equal(coerced, result, "不触发时应原样返回(引用相等)");
  }

  // -------------- resolveAwaitingUser (Q12 边界关键测试) --------------
  // 3. resumeContext 含"确认继续"+ after_agent_output provide_context
  //    → resolveAwaitingUser 应触发 resume 自动解决(awaitingUser 变 false)
  {
    const ctx = buildCtx({ resumeContext: "用户对上一次阻塞点的决定：确认继续" });
    const result = buildResult({
      interactionRequirement: {
        type: "provide_context",
        timing: "after_agent_output",
        reason: "请确认行程是否符合预期",
        question: "行程安排是否满意?",
        options: [],
        suggestedActions: [],
        shouldNotifyUser: true,
      } as InteractionRequirement,
    });
    const resolved = resolveAwaitingUser(ctx, result);
    assert.equal(resolved.awaitingUser, false, "resolveAwaitingUser 应触发自动解决");
    assert.equal(resolved.interactionRequirement.type, "none");
    assert.ok((resolved.structuredOutput as Record<string, unknown>)?.autoResolvedRepeatedResumeConfirmation, "应标记 autoResolved");
  }

  // 4. 同样输入用 coerceMissingUserContextBlocker:不做 resume 自动解决
  //    → 这就是 Q12 的核心区分:验收路径不应让 awaiting 被自动解决吞掉
  {
    const ctx = buildCtx({ resumeContext: "用户对上一次阻塞点的决定：确认继续" });
    const result = buildResult({
      interactionRequirement: {
        type: "provide_context",
        timing: "after_agent_output",
        reason: "请确认行程是否符合预期",
        question: "行程安排是否满意?",
        options: [],
        suggestedActions: [],
        shouldNotifyUser: true,
      } as InteractionRequirement,
    });
    const coerced = coerceMissingUserContextBlocker(ctx, result);
    assert.equal(coerced.awaitingUser, true, "coerce-only 不应被 resume 自动解决");
    assert.equal(coerced.interactionRequirement.type, "provide_context");
  }

  // 5. resumeContext 无"确认继续"→ resolveAwaitingUser 行为等同 coerce-only
  {
    const ctx = buildCtx({ resumeContext: "用户提供了出发城市:北京" });
    const result = buildResult();
    const resolved = resolveAwaitingUser(ctx, result);
    assert.equal(resolved.awaitingUser, true, "无重复确认时不应自动解决");
    assert.equal(resolved.interactionRequirement.type, "provide_context");
  }

  // -------------- buildAwaitingConfirmationFromRaw --------------
  // 6. 从 raw 字符串构造 awaiting 结果
  {
    const ctx = buildCtx({ taskTitle: "签证方案对比", expectedOutcome: "选定一种签证方案" });
    const raw = "已生成 3 个签证方案对比表,请用户确认选择。";
    const built = buildAwaitingConfirmationFromRaw(ctx, raw);
    assert.equal(built.awaitingUser, true);
    assert.equal(built.interactionRequirement.type, "confirm");
    assert.equal(built.interactionRequirement.timing, "after_agent_output");
    assert.equal(built.finalMessage, raw);
    assert.equal(built.taskResult?.status, "pending_user");
    assert.equal(built.taskResult?.title, "选定一种签证方案");
    assert.ok((built.structuredOutput as Record<string, unknown>)?.recoveredFromUnstructuredConfirmation);
  }

  // -------------- awaitingCtxFrom 工厂 --------------
  // 7. 工厂从任意带这些字段的对象投影出窄 ctx
  {
    const source = {
      task: { id: "t1" } as Task,
      instance: { id: "i1" } as TaskInstance,
      resumeContext: "...",
      goalId: "g1",  // 额外字段应被忽略
      requestId: "r1",
    };
    const ctx = awaitingCtxFrom(source);
    assert.deepEqual(Object.keys(ctx).sort(), ["instance", "resumeContext", "task"]);
    assert.equal(ctx.resumeContext, "...");
  }

  // -------------- buildFromRaw + resolveAwaitingUser 边界(Code Review #1)--------------
  // 8. 非结构化兜底产出的 confirm 不应被 resume 自动解决吞掉
  //    场景:用户上轮选"确认继续",Agent 本轮返回非结构化候选方案 → buildAwaitingConfirmationFromRaw
  //    兜底产物经 resolveAwaitingUser 应保留 awaiting,而不是被 resume 自动解决标完成。
  {
    const ctx = buildCtx({ resumeContext: "用户对上一次阻塞点的决定：确认继续" });
    const raw = "我已生成两个签证方案,请用户确认选择哪一个。";
    const fromRaw = buildAwaitingConfirmationFromRaw(ctx, raw);
    // 验证兜底产物自身形状
    assert.equal(fromRaw.awaitingUser, true);
    assert.equal(fromRaw.interactionRequirement.type, "confirm");
    assert.equal(fromRaw.interactionRequirement.timing, "after_agent_output");
    assert.ok((fromRaw.structuredOutput as Record<string, unknown>)?.recoveredFromUnstructuredConfirmation);

    // 关键:经 resolveAwaitingUser 后,awaitingUser 仍应为 true(不被 resume 自动解决吞掉)
    const afterResolve = resolveAwaitingUser(ctx, fromRaw);
    assert.equal(afterResolve.awaitingUser, true, "兜底产物不应被 resume 自动解决吞掉(用户必须看到新方案)");
    assert.equal(afterResolve.interactionRequirement.type, "confirm");
    assert.ok(
      !(afterResolve.structuredOutput as Record<string, unknown>)?.autoResolvedRepeatedResumeConfirmation,
      "兜底产物不应被标 autoResolved",
    );
  }

  console.log("awaitingUserResolver specs passed");
}
