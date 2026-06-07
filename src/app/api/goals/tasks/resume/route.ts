import { NextRequest, NextResponse } from "next/server";

import { withDeprecatedApiHeaders } from "@/lib/server/http/deprecation";
import { resumeBlockedTask } from "@/lib/server/taskExecution/resumeBlockedTask";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POSTHandler(request: NextRequest) {
  const body = await request.json();
  const result = await resumeBlockedTask(body);
  return withDeprecatedApiHeaders(
    NextResponse.json(result.body, { status: result.status }),
    "/api/goals/instances/{instanceId}/respond",
  );
}

export const POST = withAuth(POSTHandler);
