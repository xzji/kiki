import { NextRequest, NextResponse } from "next/server";

import type { ClaudeStreamEvent } from "@/lib/server/claude/transport";
import { authenticateMachineForResult } from "@/lib/server/tunnel/tunnelHub";
import { pushStreamChunk } from "@/lib/server/tunnel/machineStreamHub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readApiKey(request: NextRequest) {
  const header = request.headers.get("x-machine-api-key");
  if (header) return header.trim();
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return request.nextUrl.searchParams.get("api-key");
}

export async function POST(request: NextRequest) {
  const apiKey = readApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ ok: false, reason: "缺少 machine api-key" }, { status: 401 });
  }
  const machine = authenticateMachineForResult(apiKey);
  if (!machine) {
    return NextResponse.json({ ok: false, reason: "invalid api-key" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as {
    sessionId?: string;
    event?: ClaudeStreamEvent;
  } | null;
  if (!body?.sessionId || !body.event || typeof body.event.type !== "string") {
    return NextResponse.json({ ok: false, reason: "无效的流式分片" }, { status: 400 });
  }
  pushStreamChunk(body.sessionId, body.event);
  return NextResponse.json({ ok: true });
}
