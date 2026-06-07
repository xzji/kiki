import { NextRequest, NextResponse } from "next/server";

import { withDeprecatedApiHeaders } from "@/lib/server/http/deprecation";
import { cancelRuntimeJobByTaskRun } from "@/lib/server/repositories/runtimeJobsRepository";
import {
  projectRuntimeJobStatusProjection,
  updateGoalRuntimeJobExecution,
} from "@/lib/server/services/goalRuntimeService";
import type { GoalServerProgress } from "@/types/goalTelemetry";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POSTHandler(request: NextRequest) {
  const body = (await request.json()) as {
    requestId?: string;
    taskInstanceId?: string;
  };
  const requestId = body.requestId?.trim();
  const taskInstanceId = body.taskInstanceId?.trim();
  if (!requestId && !taskInstanceId) {
    return withDeprecatedApiHeaders(
      NextResponse.json({ reason: "requestId 或 taskInstanceId 不能为空" }, { status: 400 }),
      "/api/goals/instances/{instanceId}/cancel",
    );
  }

  const job = cancelRuntimeJobByTaskRun({ requestId, taskInstanceId });
  if (!job) {
    return withDeprecatedApiHeaders(
      NextResponse.json({ reason: "未找到可停止的执行任务，可能已结束。" }, { status: 404 }),
      "/api/goals/instances/{instanceId}/cancel",
    );
  }

  const now = new Date().toISOString();
  projectRuntimeJobStatusProjection({
    job,
    status: "cancelled",
    reason: "用户手动停止任务执行",
  });
  const progress: GoalServerProgress = {
    requestId: job.requestId ?? requestId ?? `cancel-${job.id}`,
    scope: "goal_task_execute",
    status: "cancelled",
    phase: "executing",
    message: "用户已手动停止任务执行。",
    startedAt: job.startedAt ?? now,
    updatedAt: now,
    finishedAt: now,
    error: "用户手动停止任务执行",
    goalId: job.goalId,
    taskId: job.taskId,
    taskInstanceId: job.taskInstanceId,
    resultPayload: {
      errorCategory: "aborted",
      errorMessage: "用户手动停止任务执行",
    },
  };

  if (job.taskId && job.taskInstanceId) {
    updateGoalRuntimeJobExecution(job.id, {
      status: "cancelled",
      progress,
      logs: job.logs,
      trajectory: job.trajectory,
      result:
        progress.resultPayload && typeof progress.resultPayload === "object"
          ? progress.resultPayload
          : null,
      finishedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
  }

  return withDeprecatedApiHeaders(
    NextResponse.json({
      ok: true,
      requestId: progress.requestId,
      taskInstanceId: job.taskInstanceId,
      progress,
      logs: job.logs,
      trajectory: job.trajectory,
      waitingReason: undefined,
    }),
    "/api/goals/instances/{instanceId}/cancel",
  );
}

export const POST = withAuth(POSTHandler);
