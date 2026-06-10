import { NextRequest, NextResponse } from "next/server";

import { withDeprecatedApiHeaders } from "@/lib/server/http/deprecation";
import { withAuth } from "@/lib/server/http/withAuth";
import { buildTaskRunView, toTaskRunResponse } from "@/lib/server/taskExecution/taskRunView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get("requestId")?.trim();
  const taskInstanceId = request.nextUrl.searchParams.get("taskInstanceId")?.trim();

  if (!requestId && !taskInstanceId) {
    return withDeprecatedApiHeaders(
      NextResponse.json({ reason: "requestId 或 taskInstanceId 不能为空" }, { status: 400 }),
      "/api/goals/instances/{instanceId}/runtime",
    );
  }

  const view = buildTaskRunView({ taskInstanceId, requestId });
  if (view.isEmpty) {
    return withDeprecatedApiHeaders(
      NextResponse.json(toTaskRunResponse(view), { status: 404 }),
      "/api/goals/instances/{instanceId}/runtime",
    );
  }

  return withDeprecatedApiHeaders(
    NextResponse.json(toTaskRunResponse(view)),
    "/api/goals/instances/{instanceId}/runtime",
  );
}

export const GET = withAuth(GETHandler);
