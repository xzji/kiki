import { NextRequest, NextResponse } from "next/server";

import { listGovernanceTicksByEntity } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  const kind = request.nextUrl.searchParams.get("kind");
  const entityId = request.nextUrl.searchParams.get("entityId")?.trim();
  const limitRaw = request.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  if (kind !== "thread" && kind !== "topic") {
    return NextResponse.json({ ok: false, reason: "kind must be thread or topic" }, { status: 400 });
  }
  if (!entityId) {
    return NextResponse.json({ ok: false, reason: "entityId required" }, { status: 400 });
  }

  try {
    const entries = listGovernanceTicksByEntity({
      kind,
      entityId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return NextResponse.json({ ok: true, entries });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        reason: error instanceof Error ? error.message : "list governance history failed",
      },
      { status: 500 },
    );
  }
}

export const GET = withAuth(GETHandler);
