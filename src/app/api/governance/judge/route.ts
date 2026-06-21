import { NextRequest, NextResponse } from "next/server";

import { evaluateGovernanceGate } from "@/lib/server/governance/governanceGate";
import { judgeGovernanceIntent } from "@/lib/server/governance/governanceJudge";
import { logGovernanceApply } from "@/lib/server/governance/governanceApplyTelemetry";
import { mergeTaskPatch } from "@/lib/server/governance/taskPatchMerge";
import { readComposedGoalsSnapshot } from "@/lib/server/runtime/instanceComposition";
import { ensureConversationWorkspace } from "@/lib/server/workspace/conversationWorkspace";
import type {
  GovernanceJudgeResult,
  TaskRef,
} from "@/lib/server/governance/governanceIntent";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { ClaudeChatRequest } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function findTaskRef(
  goals: Goal[],
  taskRef?: ClaudeChatRequest["taskRef"] | null,
) {
  if (!taskRef) return null;
  const goal = goals.find((item) => item.id === taskRef.goalId);
  const subGoal = goal?.subGoals.find((item) => item.id === taskRef.subGoalId);
  const task = subGoal?.tasks.find((item) => item.id === taskRef.taskId);
  const instance = task?.instances.find(
    (item) => item.id === taskRef.instanceId,
  );
  if (!goal || !subGoal || !task) return null;
  return { goal, subGoal, task, instance };
}

function findGoal(goals: Goal[], goalId?: string | null) {
  return goalId ? (goals.find((item) => item.id === goalId) ?? null) : null;
}

function buildDiff(task: Task | undefined, judge: GovernanceJudgeResult) {
  if (
    !task ||
    !judge.patch ||
    (judge.intent !== "amend_task" && judge.intent !== "update_task")
  )
    return [];
  const next = mergeTaskPatch(task, judge.patch);
  return [
    { field: "title", before: task.title, after: next.title },
    {
      field: "description",
      before: task.description ?? "",
      after: next.description ?? "",
    },
    {
      field: "expectedOutcome",
      before: task.expectedOutcome,
      after: next.expectedOutcome,
    },
    {
      field: "expectedResult.completionCriteria",
      before: task.expectedResult?.completionCriteria ?? "",
      after: next.expectedResult?.completionCriteria ?? "",
    },
    { field: "triggerRule", before: task.triggerRule, after: next.triggerRule },
  ].filter(
    (item) =>
      normalizeDiffValue(item.before) !== normalizeDiffValue(item.after),
  );
}

function normalizeDiffValue(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildProposal(input: {
  judge: GovernanceJudgeResult;
  goal?: Goal;
  subGoal?: SubGoal;
  task?: Task;
  instance?: TaskInstance;
}) {
  const supported =
    input.judge.intent === "amend_task" ||
    input.judge.intent === "update_task" ||
    input.judge.intent === "create_task" ||
    input.judge.intent === "cancel_task" ||
    input.judge.intent === "rerun_current" ||
    input.judge.intent === "dispatch_task" ||
    input.judge.intent === "pause_task";
  if (!supported) return null;
  return {
    intent: input.judge.intent,
    supported: true,
    confirmLevel:
      input.judge.intent === "rerun_current" ||
      input.judge.intent === "dispatch_task" ||
      input.judge.intent === "pause_task"
        ? "light"
        : "required",
    summary: input.judge.assistantMessage,
    diffs: buildDiff(input.task, input.judge),
    payload: {
      intent: input.judge.intent,
      taskRef: input.judge.targetRef,
      patch: input.judge.patch,
      revisionHint: input.judge.revisionHint,
      applyMode: input.judge.applyMode,
    },
  };
}

async function POSTHandler(request: NextRequest) {
  const body = (await request.json()) as ClaudeChatRequest;
  if (!body.conversationId || !body.message?.trim()) {
    return NextResponse.json(
      { ok: false, reason: "缺少 conversationId 或 message" },
      { status: 400 },
    );
  }
  const goals = readComposedGoalsSnapshot([]);
  const conversation = body.contextSnapshot?.conversation ?? null;
  const gate = evaluateGovernanceGate({
    message: body.message,
    conversation,
    taskRef: body.taskRef,
  });
  if (!gate.pass) {
    return NextResponse.json({
      ok: true,
      shouldHandle: false,
      reason: gate.reason,
    });
  }
  if (
    !body.runtimeEnv ||
    body.runtimeEnv.type !== "local" ||
    body.runtimeEnv.health?.status !== "online"
  ) {
    return NextResponse.json({
      ok: true,
      shouldHandle: false,
      reason: "runtime unavailable",
    });
  }
  const located = findTaskRef(goals, body.taskRef);
  const goal =
    located?.goal ??
    findGoal(goals, body.contextSnapshot?.goal?.id ?? conversation?.goalId);
  if (!goal) {
    return NextResponse.json({
      ok: true,
      shouldHandle: false,
      reason: "goal not found",
    });
  }
  const workspace = ensureConversationWorkspace(body.conversationId);
  const fallbackRef: TaskRef | undefined = body.taskRef
    ? {
        goalId: body.taskRef.goalId,
        subGoalId: body.taskRef.subGoalId,
        taskId: body.taskRef.taskId,
        instanceId: body.taskRef.instanceId,
      }
    : undefined;
  const judge = await judgeGovernanceIntent({
    goal,
    subGoal: located?.subGoal,
    task: located?.task,
    instance: located?.instance,
    userMessage: body.message,
    quotedMessage: body.quotedMessage,
    runtimeEnv: body.runtimeEnv,
    workingDirectory: workspace.workspaceDir,
    conversationId: body.conversationId,
    fallbackRef,
    signal: request.signal,
  });
  const proposal = buildProposal({
    judge,
    goal,
    subGoal: located?.subGoal,
    task: located?.task,
    instance: located?.instance,
  });
  if (judge._downgradedFrom === "replan") {
    logGovernanceApply("replan_downgraded", {
      conversationId: body.conversationId,
      goalId: goal.id,
      confidence: judge.confidence,
      hasRef: Boolean(judge.targetRef),
      msgLen: body.message.length,
    });
  }
  // 被降级的意图（如 replan→clarify）不会进 proposal（shouldHandle=false），
  // 但其引导语应直接展示给用户、而非落回普通 LLM 流。用 notice 单独透出。
  const notice = judge._downgradedFrom ? judge.assistantMessage : undefined;
  return NextResponse.json({
    ok: true,
    shouldHandle: Boolean(proposal),
    notice,
    judge,
    proposal,
  });
}

export const POST = withAuth(POSTHandler);
