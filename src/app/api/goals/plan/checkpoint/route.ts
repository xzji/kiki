import { NextResponse } from "next/server";

import { withAuth } from "@/lib/server/http/withAuth";
import { withDeprecatedApiHeaders } from "@/lib/server/http/deprecation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tombstone: the legacy Goal planning checkpoint has been removed. Planning now
// runs exclusively on the Topic Init Saga (`/api/topics/plan`), which manages
// its own saga-instance resume.
async function GoneHandler() {
  return withDeprecatedApiHeaders(
    NextResponse.json(
      { available: false, reason: "Goal 规划命令已下线，请使用 /topic（POST /api/topics/plan）。" },
      { status: 410 },
    ),
    "/api/topics/plan",
  );
}

export const GET = withAuth(GoneHandler);
