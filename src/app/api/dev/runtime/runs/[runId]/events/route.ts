import { NextRequest, NextResponse } from "next/server";

import { findAgentRunById } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { listAgentEvents } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import { withAuth } from "@/lib/server/http/withAuth";

/**
 * GET /api/dev/runtime/runs/[runId]/events — 增量拉取 agent_events（PR15 §12.5.2）。
 *
 * Query:
 *  - fromSeq（默认 0；客户端拉取后传 lastSeq 实现增量）
 *  - limit（默认 1000，最大 5000）
 *
 * 响应：{ ok: true, run: AgentRun, events: AgentEvent[], nextSeq }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseNonNegativeInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

async function GETHandler(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  if (!runId || typeof runId !== "string") {
    return NextResponse.json({ ok: false, reason: "缺少 runId" }, { status: 400 });
  }
  const sp = request.nextUrl.searchParams;
  const fromSeq = parseNonNegativeInt(sp.get("fromSeq"), 0, Number.MAX_SAFE_INTEGER);
  const limit = parseNonNegativeInt(sp.get("limit"), 1000, 5000);
  try {
    const run = findAgentRunById(runId);
    if (!run) {
      return NextResponse.json({ ok: false, reason: "run not found" }, { status: 404 });
    }
    const events = listAgentEvents({ agentRunId: runId, fromSeq, limit });
    const nextSeq =
      events.length > 0 ? events[events.length - 1]!.seq : fromSeq;
    return NextResponse.json({ ok: true, run, events, nextSeq });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "list events failed" },
      { status: 500 },
    );
  }
}

export const GET = withAuth(GETHandler);
