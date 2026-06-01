import { NextRequest, NextResponse } from "next/server";

import {
  countSagaInstances,
  listSagaInstances,
  type ListSagaInstancesInput,
} from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";
import type { SagaStatus, SagaType } from "@/types/agentRuntime";

/**
 * GET /api/dev/runtime/sagas — DevPanel saga 列表（PR15 §12.5.2）。
 *
 * Query:
 *  - status: 逗号分隔（pending/running/awaiting_user/completed/failed），默认全部
 *  - type:   逗号分隔（topic_init/thread_loop），默认全部
 *  - topicId
 *  - sinceIso（ISO8601；默认最近 24h，§12.5.5）
 *  - limit（默认 50，最大 200）
 *  - offset
 *
 * 响应：{ ok: true, items: SagaInstance[], total, limit, offset }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STATUSES: SagaStatus[] = [
  "pending",
  "running",
  "awaiting_user",
  "completed",
  "failed",
];
const VALID_TYPES: SagaType[] = ["topic_init", "thread_loop"];

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseStatuses(value: string | null): SagaStatus[] | undefined {
  const parts = splitCsv(value);
  if (parts.length === 0) return undefined;
  const filtered = parts.filter((p): p is SagaStatus =>
    (VALID_STATUSES as string[]).includes(p),
  );
  return filtered.length > 0 ? filtered : undefined;
}

function parseTypes(value: string | null): SagaType[] | undefined {
  const parts = splitCsv(value);
  if (parts.length === 0) return undefined;
  const filtered = parts.filter((p): p is SagaType =>
    (VALID_TYPES as string[]).includes(p),
  );
  return filtered.length > 0 ? filtered : undefined;
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const statuses = parseStatuses(sp.get("status"));
  const types = parseTypes(sp.get("type"));
  const topicId = sp.get("topicId")?.trim() || undefined;
  const sinceIsoRaw = sp.get("sinceIso")?.trim();
  const sinceIso =
    sinceIsoRaw && !Number.isNaN(Date.parse(sinceIsoRaw))
      ? sinceIsoRaw
      : new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  const limit = parsePositiveInt(sp.get("limit"), 50, 200);
  const offset = parsePositiveInt(sp.get("offset"), 0, 1_000_000);

  const filter: ListSagaInstancesInput = { statuses, types, topicId, sinceIso, limit, offset };
  try {
    const items = listSagaInstances(filter);
    const total = countSagaInstances({ statuses, types, topicId, sinceIso });
    return NextResponse.json({ ok: true, items, total, limit, offset });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "list sagas failed" },
      { status: 500 },
    );
  }
}
