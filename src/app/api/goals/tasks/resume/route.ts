import { NextRequest, NextResponse } from "next/server";

import { withDeprecatedApiHeaders } from "@/lib/server/http/deprecation";
import { resumeBlockedTask } from "@/lib/server/taskExecution/resumeBlockedTask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const result = await resumeBlockedTask(body);
  return withDeprecatedApiHeaders(
    NextResponse.json(result.body, { status: result.status }),
    "/api/goals/instances/{instanceId}/respond",
  );
}
