import { NextRequest, NextResponse } from "next/server";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { transitionTaskInstanceProjection } from "@/lib/server/services/goalRuntimeService";
import type { Goal, TaskInstanceStatus } from "@/types/kiki";

export const runtime = "nodejs";

type Body = {
  status: TaskInstanceStatus;
  reason?: string;
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

function toCommand(status: TaskInstanceStatus) {
  if (status === "paused") return "pause";
  if (status === "in_progress") return "resume";
  if (status === "error") return "cancel";
  return "transition";
}

function isTaskInstanceStatus(value: unknown): value is TaskInstanceStatus {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "awaiting_user" ||
    value === "paused" ||
    value === "error"
  );
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
  const validStatuses: TaskInstanceStatus[] = ["pending", "in_progress", "completed", "awaiting_user", "paused", "error"];
  if (!validStatuses.includes(body.status)) {
    return NextResponse.json({ reason: "非法任务实例状态" }, { status: 400 });
  }
  const goals = readGoalsSnapshot([]);
  const located = findInstance(goals, context.params.instanceId);
  if (!located) {
    return NextResponse.json({ reason: "未找到任务实例" }, { status: 404 });
  }
  const idempotencyKey =
    request.headers.get("Idempotency-Key") ??
    createIdempotencyKey("instance.status_changed", located.instance.id, located.instance.status, body.status);
  const statusEvent = appendGoalEventOnce({
    goalId: located.goal.id,
    taskId: located.task.id,
    instanceId: located.instance.id,
    kind: "instance.status_changed",
    producedBy: "user",
    idempotencyKey,
    payload: {
      previousStatus: located.instance.status,
      nextStatus: body.status,
      reason: body.reason,
    },
  });
  if (!statusEvent) {
    return NextResponse.json({ reason: "状态变更事件写入失败" }, { status: 500 });
  }
  appendGoalEventOnce({
    goalId: located.goal.id,
    taskId: located.task.id,
    instanceId: located.instance.id,
    kind: "instance.user_command",
    producedBy: "user",
    idempotencyKey: createIdempotencyKey("instance.user_command", idempotencyKey),
    payload: {
      command: toCommand(body.status),
      reason: body.reason,
    },
  });
  const nextStatus = statusEvent.kind === "instance.status_changed" ? statusEvent.payload.nextStatus : body.status;
  if (!isTaskInstanceStatus(nextStatus) || nextStatus !== body.status) {
    return NextResponse.json({ reason: "Idempotency-Key 已用于不同的状态变更" }, { status: 409 });
  }
  transitionTaskInstanceProjection({
    goals,
    taskId: located.task.id,
    instanceId: located.instance.id,
    status: nextStatus,
    reason: body.reason,
  });
  return NextResponse.json({
    ok: true,
    event: statusEvent,
  });
}
