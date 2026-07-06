import { NextResponse } from "next/server";

import { withAuth } from "@/lib/server/http/withAuth";
import { withDeprecatedApiHeaders } from "@/lib/server/http/deprecation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tombstone: the legacy Goal planning command has been removed. Planning now
// runs exclusively on the Topic Init Saga (`/api/topics/plan`).
async function GoneHandler() {
  return withDeprecatedApiHeaders(
    NextResponse.json(
      { reason: "Goal 规划命令已下线，请使用 /topic（POST /api/topics/plan）。" },
      { status: 410 },
    ),
    "/api/topics/plan",
  );
}

export const POST = withAuth(GoneHandler);
