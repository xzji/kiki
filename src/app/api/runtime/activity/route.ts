import { NextRequest, NextResponse } from "next/server";

import {
  aggregateThreadRunnerActivity,
  type ThreadRunnerActivityRow,
} from "@/lib/server/repositories/agentRuntime/agentRunsRepository";
import { listSagaInstances } from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";
import {
  listOpenRuntimeJobActivity,
  type RuntimeJobActivityRow,
} from "@/lib/server/repositories/runtimeJobsRepository";
import type { SagaInstance } from "@/types/agentRuntime";
import { withAuth } from "@/lib/server/http/withAuth";

/**
 * GET /api/runtime/activity — 任务执行情况监控面板的运行时执行源。
 *
 * 聚合「Goal 任务实例」之外、或其快照滞后的执行活动：
 *  - ThreadRunner 治理循环（agent_runs role=thread_runner，按 thread 折叠）
 *  - Topic/Saga 多角色规划执行（saga_instances）
 *  - 运行时 job 实时状态（runtime_jobs，用于校正 goals 快照滞后导致的「执行中」漏显）
 *
 * Query:
 *  - sinceIso（ISO8601；默认最近 24h）
 *
 * 响应：{ ok, threadRunners, sagas, jobs }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

async function GETHandler(request: NextRequest) {
  const sinceIsoRaw = request.nextUrl.searchParams.get("sinceIso")?.trim();
  const sinceIso =
    sinceIsoRaw && !Number.isNaN(Date.parse(sinceIsoRaw))
      ? sinceIsoRaw
      : new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();

  try {
    const threadRunners: ThreadRunnerActivityRow[] = aggregateThreadRunnerActivity(sinceIso);
    const sagas: SagaInstance[] = listSagaInstances({ sinceIso, limit: 200 });
    const jobs: RuntimeJobActivityRow[] = listOpenRuntimeJobActivity();
    return NextResponse.json({ ok: true, threadRunners, sagas, jobs });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        reason: error instanceof Error ? error.message : "list runtime activity failed",
      },
      { status: 500 },
    );
  }
}

export const GET = withAuth(GETHandler);
