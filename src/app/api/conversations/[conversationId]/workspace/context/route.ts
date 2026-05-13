import { NextRequest, NextResponse } from "next/server";

import { buildConversationContextPack, serializeConversationMessages } from "@/lib/server/workspace/contextPack";
import {
  ensureConversationWorkspace,
  getConversationContextFilePath,
  getConversationMessagesFilePath,
  getPlanningStateFilePath,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "@/lib/server/workspace/conversationWorkspace";
import type { Conversation, Goal } from "@/types/kiki";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ContextRequest = {
  conversation: Conversation;
  goal?: Goal | null;
};

export async function POST(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const { conversationId } = await context.params;
    const body = (await request.json()) as ContextRequest;
    if (!body.conversation || body.conversation.id !== conversationId) {
      return NextResponse.json({ ok: false, reason: "会话上下文不匹配" }, { status: 400 });
    }

    ensureConversationWorkspace(conversationId);
    writeJsonFileAtomic(getConversationMessagesFilePath(conversationId), serializeConversationMessages(body.conversation.messages));
    writeJsonFileAtomic(getPlanningStateFilePath(conversationId), body.conversation.planningRunState ?? null);
    writeTextFileAtomic(
      getConversationContextFilePath(conversationId),
      buildConversationContextPack({
        conversation: body.conversation,
        goal: body.goal,
        recentMessages: body.conversation.messages,
      }),
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "写入会话上下文失败" },
      { status: 400 },
    );
  }
}
