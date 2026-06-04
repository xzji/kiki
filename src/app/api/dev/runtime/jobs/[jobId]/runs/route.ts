import { NextRequest, NextResponse } from "next/server";

import { listAgentRunsByRuntimeJobId } from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { getRuntimeJob } from "@/lib/server/repositories/runtimeJobsRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  if (!jobId || typeof jobId !== "string") {
    return NextResponse.json({ ok: false, reason: "缺少 jobId" }, { status: 400 });
  }
  try {
    const job = getRuntimeJob(jobId);
    if (!job) {
      return NextResponse.json({ ok: false, reason: "job not found" }, { status: 404 });
    }
    const runs = listAgentRunsByRuntimeJobId(jobId);
    return NextResponse.json({ ok: true, job, runs });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "list job runs failed" },
      { status: 500 },
    );
  }
}
