import { NextRequest, NextResponse } from "next/server";

import { authenticateMachineForResult, submitMachineResult, type MachineResult } from "@/lib/server/tunnel/tunnelHub";

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
  const body = (await request.json().catch(() => null)) as MachineResult | null;
  if (!body || typeof body.type !== "string") {
    return NextResponse.json({ ok: false, reason: "无效的结果体" }, { status: 400 });
  }
  submitMachineResult(body, { userId: machine.userId, machineId: machine.machineId });
  return NextResponse.json({ ok: true });
}
