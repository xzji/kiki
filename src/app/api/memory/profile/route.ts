import { NextRequest, NextResponse } from "next/server";

import {
  readUserProfileMemory,
  writeUserProfileMemoryManual,
} from "@/lib/server/memory/userMemoryService";
import { getLatestMemoryAuditSource } from "@/lib/server/memory/memoryAudit";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler() {
  const memory = readUserProfileMemory();
  return NextResponse.json({
    ok: true,
    memory,
    source: getLatestMemoryAuditSource({ target: "profile" }) ?? "用户手动",
  });
}

async function PUTHandler(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    content?: string;
    expectedHash?: string;
  };
  const result = await writeUserProfileMemoryManual({
    content: body.content ?? "",
    expectedHash: body.expectedHash,
  });
  if ("conflict" in result && result.conflict) {
    return NextResponse.json({ ok: false, reason: "记忆已被更新，请刷新后重试", ...result }, { status: 409 });
  }
  if ("overLimit" in result && result.overLimit) {
    return NextResponse.json({ ok: false, reason: "用户记忆超过 24KB 上限", ...result }, { status: 413 });
  }
  return NextResponse.json({ ok: true, ...result });
}

export const GET = withAuth(GETHandler);
export const PUT = withAuth(PUTHandler);
