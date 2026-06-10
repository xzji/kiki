import { NextResponse } from "next/server";

import { withAuth } from "@/lib/server/http/withAuth";
import { buildTaskRunView, toTaskRunResponse } from "@/lib/server/taskExecution/taskRunView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(
  request: Request,
  context: {
    params: {
      instanceId: string;
    };
  },
) {
  const requestUrl = new URL(request.url);
  const requestId = requestUrl.searchParams.get("requestId")?.trim();
  const taskInstanceId = context.params.instanceId.trim();
  if (!taskInstanceId) {
    return NextResponse.json({ reason: "instanceId 不能为空" }, { status: 400 });
  }

  const view = buildTaskRunView({ taskInstanceId, requestId });

  if (view.isEmpty) {
    return NextResponse.json(toTaskRunResponse(view), { status: 404 });
  }

  return NextResponse.json(toTaskRunResponse(view));
}

export const GET = withAuth(GETHandler);
