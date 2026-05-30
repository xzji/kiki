import { NextRequest, NextResponse } from "next/server";

import { ConversationCommandValidationError, readConversationMessages } from "@/lib/server/services/conversationCommandService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: { conversationId: string } }) {
  const { searchParams } = new URL(request.url);
  const afterSeq = Number(searchParams.get("after") ?? 0);
  const limit = Number(searchParams.get("limit") ?? 200);
  try {
    const messages = readConversationMessages(
      params.conversationId,
      Number.isFinite(afterSeq) ? afterSeq : 0,
      Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 200,
    );
    return NextResponse.json({ ok: true, messages });
  } catch (error) {
    if (error instanceof ConversationCommandValidationError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, reason: "读取会话消息失败" }, { status: 500 });
  }
}
