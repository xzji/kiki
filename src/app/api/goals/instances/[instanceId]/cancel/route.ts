import { NextRequest, NextResponse } from "next/server";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import { cancelRuntimeJobByTaskRun } from "@/lib/server/repositories/runtimeJobsRepository";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { transitionTaskInstanceProjection } from "@/lib/server/services/goalRuntimeService";
import { buildTaskRunView, toTaskRunResponse } from "@/lib/server/taskExecution/taskRunView";
import type { Goal } from "@/types/kiki";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

type Body = {
  reason?: string;
  mode?: "pause" | "terminate";
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

async function POSTHandler(
  request: NextRequest,
  context: {
    params: {
      instanceId: string;
    };
  },
) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const mode = body.mode === "pause" ? "pause" : "terminate";
  const nextStatus = mode === "pause" ? "paused" : "terminated";
  const command = mode === "pause" ? "pause" : "cancel";
  const reason = body.reason ?? (mode === "pause" ? "用户暂停任务执行" : "用户终止任务执行");
  const runtimeCancelReason = mode === "pause" ? reason : "用户终止任务执行";
  // allow-raw-goals-snapshot: 用户取消命令写路径，用 raw projection 定位结构并写回状态；运行态取消另走 runtime_jobs。
  const goals = readGoalsSnapshot([]);
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
    idempotencyKey:
      request.headers.get("Idempotency-Key") ??
      createIdempotencyKey("instance.status_changed.cancel", located.instance.id, mode),
    payload: {
      previousStatus: located.instance.status,
      nextStatus,
      reason,
    },
  });
  if (!statusEvent) {
    return NextResponse.json({ reason: "取消事件写入失败" }, { status: 500 });
  }
  transitionTaskInstanceProjection({
    goals,
    taskId: located.task.id,
    instanceId: located.instance.id,
    status: nextStatus,
    reason,
  });
  const job = cancelRuntimeJobByTaskRun({
    taskInstanceId: located.instance.id,
    requestId: located.instance.runner?.requestId,
    reason: runtimeCancelReason,
  });
  const event = appendGoalEventOnce({
    goalId: located.goal.id,
    taskId: located.task.id,
    instanceId: located.instance.id,
    kind: "instance.user_command",
    producedBy: "user",
    idempotencyKey: createIdempotencyKey("instance.user_command.cancel", located.instance.id),
    payload: {
      command,
      reason,
    },
  });
  const view = job
    ? buildTaskRunView({
        taskInstanceId: located.instance.id,
        requestId: located.instance.runner?.requestId,
        runtimeJob: job,
      })
    : null;
  return NextResponse.json({
    ok: true,
    event: statusEvent,
    commandEvent: event,
    ...(view ? toTaskRunResponse(view) : {}),
  });
}

export const POST = withAuth(POSTHandler);
