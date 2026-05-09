import { NextRequest, NextResponse } from "next/server";

import { deleteClaudeSessionFile } from "@/lib/server/claudeSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DeleteClaudeSessionRequest = {
  sessionId?: string;
  workingDirectory?: string;
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DeleteClaudeSessionRequest;
    if (!body.sessionId) {
      return NextResponse.json({ ok: false, reason: "缺少 Claude sessionId" }, { status: 400 });
    }

    const result = await deleteClaudeSessionFile({
      sessionId: body.sessionId,
      workingDirectory: body.workingDirectory,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        reason: error instanceof Error ? error.message : "删除 Claude session 失败",
      },
      { status: 400 },
    );
  }
}
