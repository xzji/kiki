import { NextRequest, NextResponse } from "next/server";

import { pollMachineCommands } from "@/lib/server/tunnel/tunnelHub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const POLL_TIMEOUT_MS = 25_000;

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
  const body = (await request.json().catch(() => ({}))) as { fingerprint?: string };
  const outcome = await pollMachineCommands({
    apiKey,
    fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : undefined,
    timeoutMs: POLL_TIMEOUT_MS,
  });
  if ("error" in outcome) {
    return NextResponse.json({ ok: false, reason: outcome.error }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    machineId: outcome.machine.machineId,
    userId: outcome.machine.userId,
    commands: outcome.commands,
  });
}
