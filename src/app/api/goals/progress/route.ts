import { NextResponse } from "next/server";

import { withAuth } from "@/lib/server/http/withAuth";
import { withDeprecatedApiHeaders } from "@/lib/server/http/deprecation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tombstone: the legacy Goal planning progress poll has been removed. Planning
// now runs exclusively on the Topic Init Saga (`/api/topics/plan`), which
// streams progress via CLI events. Task-execution progress lives at
// `/api/goals/tasks/progress` and is unaffected.
async function GoneHandler() {
  return withDeprecatedApiHeaders(
    NextResponse.json(
      { progress: null, reason: "Goal 规划命令已下线，请使用 /topic（POST /api/topics/plan）。" },
      { status: 410 },
    ),
    "/api/topics/plan",
  );
}

export const GET = withAuth(GoneHandler);
