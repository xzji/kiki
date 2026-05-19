import { NextRequest, NextResponse } from "next/server";

import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import { cancelRuntimeJobByTaskRun } from "@/lib/server/repositories/runtimeJobsRepository";
import { markGoalInstanceStatusSnapshot } from "@/lib/server/runtime/goalStateSnapshot";
import { readGoalsSnapshot, upsertGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { initialGoals } from "@/mocks/goals";
import type { Goal } from "@/types/kiki";

export const runtime = "nodejs";

type Body = {
  reason?: string;
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
  const body = (await request.json().catch(() => ({}))) as Body;
  const goals = readGoalsSnapshot(initialGoals);
  const located = findInstance(goals, context.params.instanceId);
  if (!located) {
    return NextResponse.json({ reason: "未找到任务实例" }, { status: 404 });
  }
  const statusEvent = appendGoalEventOnce({
    goalId: located.goal.id,
    taskId: located.task.id,
    instanceId: located.instance.id,
    kind: "instance.status_changed",
    producedBy: "user",
    idempotencyKey: request.headers.get("Idempotency-Key") ?? `instance.status_changed:cancel:${located.instance.id}`,
    payload: {
      previousStatus: located.instance.status,
      nextStatus: "paused",
      reason: body.reason ?? "用户取消任务执行",
    },
  });
  if (!statusEvent) {
    return NextResponse.json({ reason: "取消事件写入失败" }, { status: 500 });
  }
  cancelRuntimeJobByTaskRun({
    taskInstanceId: located.instance.id,
    requestId: located.instance.runner?.requestId,
  });
  const nextGoals = markGoalInstanceStatusSnapshot(goals, {
    taskId: located.task.id,
    instanceId: located.instance.id,
    status: "paused",
    reason: body.reason ?? "用户取消任务执行",
  });
  upsertGoalsSnapshot(nextGoals);
  const event = appendGoalEventOnce({
    goalId: located.goal.id,
    taskId: located.task.id,
    instanceId: located.instance.id,
    kind: "instance.user_command",
    producedBy: "user",
    idempotencyKey: `instance.user_command:cancel:${located.instance.id}`,
    payload: {
      command: "cancel",
      reason: body.reason,
    },
  });
  return NextResponse.json({
    ok: true,
    event: statusEvent,
    commandEvent: event,
  });
}
