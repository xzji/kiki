import { NextRequest, NextResponse } from "next/server";

import { findSagaInstanceById } from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";
import { listAgentRunsBySaga } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { withAuth } from "@/lib/server/http/withAuth";

/**
 * GET /api/dev/runtime/sagas/[sagaId]/runs — 返回选中 saga 的 agent_runs
 * 时间线（PR15 §12.5.2）。
 *
 * 响应：{ ok: true, saga, runs: AgentRun[] }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(
  _request: NextRequest,
  context: { params: Promise<{ sagaId: string }> },
) {
  const { sagaId } = await context.params;
  if (!sagaId || typeof sagaId !== "string") {
    return NextResponse.json({ ok: false, reason: "缺少 sagaId" }, { status: 400 });
  }
  try {
    const saga = findSagaInstanceById(sagaId);
    if (!saga) {
      return NextResponse.json({ ok: false, reason: "saga not found" }, { status: 404 });
    }
    const runs = listAgentRunsBySaga(sagaId);
    return NextResponse.json({ ok: true, saga, runs });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "list runs failed" },
      { status: 500 },
    );
  }
}

export const GET = withAuth(GETHandler);
