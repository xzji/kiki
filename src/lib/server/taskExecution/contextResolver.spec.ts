import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { resolveExecutionContext } from "@/lib/server/taskExecution/contextResolver";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";

const CONVERSATION_ID = "conversation-context-resolver-spec";

function instance(id: string): TaskInstance {
  return {
    id,
    taskId: "task-budget-spec",
    dateLabel: "",
    status: "pending",
    intro: "",
    payload: { kind: "generic_result", summary: "" },
    createdAt: "2026-06-15T00:00:00.000Z",
  };
}

function budgetTask(extra: Partial<Task> = {}): Task {
  return {
    id: "task-budget-spec",
    subGoalId: "sub-context-resolver-spec",
    title: "发起蜜月偏好与预算澄清问卷",
    description: "请填写本次蜜月的总预算与人均预算大致是多少。",
    expectedOutcome: "明确预算约束",
    taskType: "one_shot",
    triggerRule: "立即执行",
    progress: 0,
    instances: [instance("inst-budget-spec")],
    executionKind: "generic_result",
    resultViewKind: "generic_result",
    ...extra,
  };
}

function subGoal(tasks: Task[]): SubGoal {
  return {
    id: "sub-context-resolver-spec",
    goalId: "goal-context-resolver-spec",
    title: "蜜月规划",
    tasks,
  };
}

function goal(tasks: Task[]): Goal {
  return {
    id: "goal-context-resolver-spec",
    title: "2026年国庆蜜月旅行规划与落地",
    deadline: "2026-09-30T00:00:00.000Z",
    progress: 0,
    createdAt: "2026-06-15T00:00:00.000Z",
    conversationId: CONVERSATION_ID,
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
    },
    subGoals: [subGoal(tasks)],
  };
}

function resolve(task: Task, resumeContext?: string) {
  const g = goal([task]);
  return resolveExecutionContext({
    conversationId: CONVERSATION_ID,
    goal: g,
    subGoal: g.subGoals[0]!,
    task: g.subGoals[0]!.tasks[0]!,
    instance: instance("inst-budget-spec"),
    requestId: "req-context-resolver-spec",
    resumeContext,
  });
}

export function runContextResolverSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // 1. 初次执行缺预算时阻塞
  {
    const context = resolve(budgetTask());
    assert.equal(context.readiness.state, "blocked");
    assert.ok(
      context.readiness.blockers.some((blocker) => blocker.id === "budget_constraint"),
      "初次执行应产生 budget_constraint 阻塞",
    );
  }

  // 2. 恢复执行已提交预算时放行
  {
    const resumeContext = [
      "用户对上一次阻塞点的决定：确认继续",
      "用户反馈：预算约束：人均2万元，总预算4万元上下浮动10%",
    ].join("\n");
    const context = resolve(budgetTask(), resumeContext);
    assert.equal(context.readiness.state, "ready");
    assert.ok(
      !context.readiness.blockers.some((blocker) => blocker.id === "budget_constraint"),
      "已提交预算后不应再产生 budget_constraint 阻塞",
    );
    assert.equal(context.resume?.hasResumeContext, true);
  }

  // 3. 非用户输入 blocker（依赖未完成）不被 resumeContext 绕过
  {
    const g = goal([
      budgetTask({ dependencies: ["task-upstream-spec"] }),
    ]);
    g.subGoals[0]!.tasks.unshift({
      id: "task-upstream-spec",
      subGoalId: "sub-context-resolver-spec",
      title: "上游产出",
      description: "",
      expectedOutcome: "",
      taskType: "one_shot",
      triggerRule: "立即执行",
      progress: 0,
      instances: [],
      executionKind: "generic_result",
      resultViewKind: "generic_result",
    });
    const target = g.subGoals[0]!.tasks.find((task) => task.id === "task-budget-spec")!;
    const context = resolveExecutionContext({
      conversationId: CONVERSATION_ID,
      goal: g,
      subGoal: g.subGoals[0]!,
      task: target,
      instance: instance("inst-budget-spec"),
      requestId: "req-context-resolver-spec",
      resumeContext: "用户对上一次阻塞点的决定：确认继续\n用户反馈：预算约束：人均2万元",
    });
    assert.equal(context.readiness.state, "blocked");
    assert.ok(
      context.readiness.blockers.some((blocker) => blocker.kind === "dependency"),
      "依赖未完成时应保留 dependency 阻塞，不被用户反馈绕过",
    );
  }

  // 4. 路径 A：已提交预算后点继续（本轮无字段），累计信息仍使预算就绪
  {
    const resumeContext = [
      "用户对上一次阻塞点的决定：确认继续",
      "用户反馈：用户已确认，请继续执行。",
      "用户已提供的累计信息（最新值优先）：",
      "- 预算约束：人均2万元，总预算4万元上下浮动10%",
    ].join("\n");
    const context = resolve(budgetTask(), resumeContext);
    assert.equal(context.readiness.state, "ready");
    assert.ok(
      !context.readiness.blockers.some((blocker) => blocker.id === "budget_constraint"),
      "携带累计预算信息时不应再阻塞预算",
    );
  }

  console.log("context resolver specs passed");
}
