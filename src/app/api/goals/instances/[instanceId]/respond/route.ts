import { NextRequest, NextResponse } from "next/server";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import { appendGovernanceEvent } from "@/lib/server/repositories/governanceEventOutboxRepository";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import { getRuntimeJobByTaskInstanceId } from "@/lib/server/repositories/runtimeJobsRepository";
import { resumeBlockedTask } from "@/lib/server/taskExecution/resumeBlockedTask";
import { buildTaskRunView, toTaskRunResponse } from "@/lib/server/taskExecution/taskRunView";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import type { Goal } from "@/types/kiki";
import { withAuth } from "@/lib/server/http/withAuth";

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
        if (instance) return { goal, subGoal, task, instance };
      }
    }
  }
  return null;
}

async function POSTHandler(
  request: NextRequest,
  context: {
    params: {
      instanceId: string;
    };
  },
) {
  const body = (await request.json()) as Body;
  const responseId = body.responseId?.trim();
  if (!responseId) {
    return NextResponse.json({ reason: "responseId 不能为空" }, { status: 400 });
  }
  const goals = readGoalsSnapshot([]);
  const located = findInstance(goals, context.params.instanceId);
  if (!located) {
    return NextResponse.json({ reason: "未找到任务实例" }, { status: 404 });
  }
  const job = getRuntimeJobByTaskInstanceId(located.instance.id);
  if (job?.blocker && job.blocker.resumeToken !== responseId) {
    return NextResponse.json({ reason: "恢复令牌不匹配，请刷新后重试" }, { status: 409 });
  }
  const idempotencyKey =
    request.headers.get("Idempotency-Key") ??
    createIdempotencyKey("instance.user_response", located.instance.id, responseId);
  const event = appendGoalEventOnce({
    goalId: located.goal.id,
    taskId: located.task.id,
    instanceId: located.instance.id,
    kind: "instance.user_response",
    producedBy: "user",
    idempotencyKey,
    payload: {
      responseId,
      responseSummary: body.responseSummary,
    },
  });
  if (!event) {
    return NextResponse.json({ reason: "用户响应事件写入失败" }, { status: 500 });
  }
  appendGovernanceEvent({
    eventType: "user_replied",
    source: "user_reply",
    topicId: located.goal.id,
    threadId: located.subGoal.id,
    taskId: located.task.id,
    instanceId: located.instance.id,
    idempotencyKey: createIdempotencyKey("governance.user_replied", event.eventId),
    createdAt: event.createdAt,
    payload: {
      responseId,
      responseSummary: body.responseSummary,
      goalEventId: event.eventId,
    },
  });
  if (!job || !job.blocker) {
    const view = job ? buildTaskRunView({ taskInstanceId: located.instance.id, runtimeJob: job }) : null;
    return NextResponse.json({
      ok: true,
      event,
      resumed: false,
      reason: "已记录用户响应，但当前任务没有等待恢复的 runtime job。",
      ...(view ? toTaskRunResponse(view) : {}),
    });
  }
  const resumeResult = await resumeBlockedTask({
    taskInstanceId: located.instance.id,
    resumeToken: responseId,
    approved: body.approved ?? true,
    feedback: body.responseSummary?.trim() || "用户已提交反馈，请继续执行。",
    fields: body.fields,
    action: body.approved === false ? "要求修改" : "提交反馈",
  });
  if (resumeResult.status < 200 || resumeResult.status >= 300) {
    return NextResponse.json(resumeResult.body, { status: resumeResult.status });
  }
  const view = buildTaskRunView({ taskInstanceId: located.instance.id });
  return NextResponse.json({
    ok: true,
    event,
    resumed: resumeResult.body.resumed ?? false,
    completed: resumeResult.body.completed ?? false,
    alreadyResumed: resumeResult.body.alreadyResumed ?? false,
    ...toTaskRunResponse(view),
  });
}

export const POST = withAuth(POSTHandler);
