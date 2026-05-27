import { NextRequest, NextResponse } from "next/server";

import { readClaudeTrace } from "@/lib/server/claude/traceStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertDevOnly() {
  return process.env.NODE_ENV === "development";
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { traceId: string } },
) {
  if (!assertDevOnly()) {
    return NextResponse.json({ reason: "Not found" }, { status: 404 });
  }

  const trace = readClaudeTrace(params.traceId);
  if (!trace) {
    return NextResponse.json({ reason: "Trace 不存在" }, { status: 404 });
  }

  return NextResponse.json({ trace });
}
