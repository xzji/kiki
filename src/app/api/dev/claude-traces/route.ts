import { NextRequest, NextResponse } from "next/server";

import { listClaudeTraces } from "@/lib/server/claude/traceStore";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertDevOnly() {
  return process.env.NODE_ENV === "development";
}

async function GETHandler(request: NextRequest) {
  if (!assertDevOnly()) {
    return NextResponse.json({ reason: "Not found" }, { status: 404 });
  }

  const conversationId = request.nextUrl.searchParams.get("conversationId")?.trim() || undefined;
  const limitParam = Number(request.nextUrl.searchParams.get("limit") || "50");
  const traces = listClaudeTraces({
    conversationId,
    limit: Number.isFinite(limitParam) ? limitParam : 50,
  });

  return NextResponse.json({ traces });
}

export const GET = withAuth(GETHandler);
