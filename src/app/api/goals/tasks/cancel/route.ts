import { NextRequest, NextResponse } from "next/server";

import { withDeprecatedApiHeaders } from "@/lib/server/http/deprecation";
import { cancelRuntimeJobByTaskRun } from "@/lib/server/repositories/runtimeJobsRepository";
import { cancelActiveTunnelDispatch } from "@/lib/server/scheduling/taskDispatcher";
import { projectRuntimeJobStatusProjection } from "@/lib/server/services/goalRuntimeService";
import { withAuth } from "@/lib/server/http/withAuth";
import { buildTaskRunView, toTaskRunResponse } from "@/lib/server/taskExecution/taskRunView";

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

  cancelActiveTunnelDispatch(job.id, { reason: "用户手动停止任务执行" });
  projectRuntimeJobStatusProjection({
    job,
    status: "cancelled",
    reason: "用户手动停止任务执行",
  });
  const view = buildTaskRunView({
    taskInstanceId: job.taskInstanceId ?? taskInstanceId,
    requestId: job.requestId ?? requestId,
    runtimeJob: job,
  });

  return withDeprecatedApiHeaders(
    NextResponse.json({
      ok: true,
      requestId: view.progress?.requestId ?? job.requestId ?? requestId,
      taskInstanceId: job.taskInstanceId,
      ...toTaskRunResponse(view),
    }),
    "/api/goals/instances/{instanceId}/cancel",
  );
}

export const POST = withAuth(POSTHandler);
