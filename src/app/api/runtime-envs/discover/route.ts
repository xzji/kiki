import { NextResponse } from "next/server";

import { discoverRuntimesForUser } from "@/lib/server/tunnel/remoteRuntimeProxy";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

async function GETHandler(_request: Request, context: { userId: string }) {
  try {
    const result = await discoverRuntimesForUser(context.userId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runtime 扫描失败";
    return NextResponse.json({ ok: false, reason: message }, { status: 400 });
  }
}

export const GET = withAuth(GETHandler);
