import { NextRequest, NextResponse } from "next/server";

import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import { getRuntimeJobByTaskInstanceId, updateRuntimeJobExecution } from "@/lib/server/repositories/runtimeJobsRepository";
import { markGoalInstanceStatusSnapshot } from "@/lib/server/runtime/goalStateSnapshot";
import { readGoalsSnapshot, upsertGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { initialGoals } from "@/mocks/goals";
import type { Goal } from "@/types/kiki";

export const runtime = "nodejs";

type Body = {
  responseId?: string;
  responseSummary?: string;
  approved?: boolean;
  fields?: Record<string, string>;
};

function findInstance(goals: Goal[], instanceId: string) {
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        const instance = task.instances.find((entry) => entry.id === instanceId);
        if (instance) return { goal, task, instance };
      }
    }
  }
  return null;
}

export async function POST(
  request: NextRequest,
  context: {
    params: {
      instanceId: string;
    };
  },
) {
  const body = (await request.json()) as Body;
  const goals = readGoalsSnapshot(initialGoals);
  const located = findInstance(goals, context.params.instanceId);
  if (!located) {
    return NextResponse.json({ reason: "未找到任务实例" }, { status: 404 });
  }
  const idempotencyKey =
    request.headers.get("Idempotency-Key") ??
    `instance.user_response:${located.instance.id}:${body.responseId ?? Date.now()}`;
  const event = appendGoalEventOnce({
    goalId: located.goal.id,
    taskId: located.task.id,
    instanceId: located.instance.id,
    kind: "instance.user_response",
    producedBy: "user",
    idempotencyKey,
    payload: {
      responseId: body.responseId,
      responseSummary: body.responseSummary,
    },
  });
  if (!event) {
    return NextResponse.json({ reason: "用户响应事件写入失败" }, { status: 500 });
  }
  const job = getRuntimeJobByTaskInstanceId(located.instance.id);
  if (!job || !job.blocker) {
    return NextResponse.json({
      ok: true,
      event,
      resumed: false,
      reason: "已记录用户响应，但当前任务没有等待恢复的 runtime job。",
    });
  }
  const feedback = body.responseSummary?.trim() || "用户已提交反馈，请继续执行。";
  updateRuntimeJobExecution(job.id, {
    status: "queued",
    payload: {
      ...job.payload,
      resumeContext: [
        `用户对阻塞点 ${job.blocker.resumeToken} 的响应：`,
        feedback,
        body.approved === false ? "用户未确认当前方案，请根据反馈调整后继续。" : "用户已确认/补充信息，请继续执行。",
      ].join("\n"),
    },
    blocker: null,
    result: {
      ...(job.result ?? {}),
      awaitingUser: false,
      awaitingReason: undefined,
      interactionSubmission: {
        type: job.blocker.interactionRequirement.type,
        status: body.approved === false ? "rejected" : "submitted",
        action: body.approved === false ? "要求修改" : "提交反馈",
        approved: body.approved ?? true,
        feedback,
        fields: body.fields,
        submittedAt: new Date().toISOString(),
      },
    },
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    finishedAt: undefined,
  });
  upsertGoalsSnapshot(
    markGoalInstanceStatusSnapshot(goals, {
      taskId: located.task.id,
      instanceId: located.instance.id,
      status: "in_progress",
      reason: "已收到用户响应，等待 daemon 继续执行。",
    }),
  );
  return NextResponse.json({
    ok: true,
    event,
    resumed: true,
  });
}
