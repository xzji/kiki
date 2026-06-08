import { NextResponse } from "next/server";

import { withAuth } from "@/lib/server/http/withAuth";
import { installKikiSkillsForUser } from "@/lib/server/tunnel/remoteRuntimeProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POSTHandler(_request: Request, context: { userId: string }) {
  try {
    const result = await installKikiSkillsForUser(context.userId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "KiKi 默认 skills 安装失败";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);
