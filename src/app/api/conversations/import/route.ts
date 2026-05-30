import { NextRequest, NextResponse } from "next/server";

import {
  ConversationCommandConflictError,
  ConversationCommandValidationError,
  importConversations,
} from "@/lib/server/services/conversationCommandService";
import type { Conversation } from "@/types/kiki";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { conversations?: unknown };
  if (!Array.isArray(body.conversations)) {
    return NextResponse.json({ ok: false, reason: "缺少 conversations" }, { status: 400 });
  }
  try {
    const conversations = importConversations(body.conversations as Conversation[]);
    return NextResponse.json({ ok: true, conversations });
  } catch (error) {
    if (error instanceof ConversationCommandConflictError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: 409 });
    }
    if (error instanceof ConversationCommandValidationError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, reason: "导入会话失败" }, { status: 500 });
  }
}
