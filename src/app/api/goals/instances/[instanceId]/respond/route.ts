import { NextRequest, NextResponse } from "next/server";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import { getRuntimeJobByTaskInstanceId } from "@/lib/server/repositories/runtimeJobsRepository";
import { resumeBlockedTask } from "@/lib/server/taskExecution/resumeBlockedTask";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
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
    createIdempotencyKey("instance.user_response", located.instance.id, body.responseId ?? `${Date.now()}`);
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
  const resumeResult = await resumeBlockedTask({
    taskInstanceId: located.instance.id,
    resumeToken: job.blocker.resumeToken,
    approved: body.approved ?? true,
    feedback: body.responseSummary?.trim() || "用户已提交反馈，请继续执行。",
    fields: body.fields,
    action: body.approved === false ? "要求修改" : "提交反馈",
  });
  return NextResponse.json({
    ok: true,
    event,
    resumed: resumeResult.body.resumed ?? false,
    completed: resumeResult.body.completed ?? false,
    progress: resumeResult.body.progress ?? null,
    trajectory: resumeResult.body.trajectory ?? [],
  });
}
