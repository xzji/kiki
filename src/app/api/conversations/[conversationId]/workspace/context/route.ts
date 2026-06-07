import { NextRequest, NextResponse } from "next/server";

import {
  buildConversationContextPack,
  pickConversationForPrompt,
  pickGoalForPrompt,
} from "@/lib/server/workspace/contextPack";
import {
  ensureConversationWorkspace,
  getConversationContextFilePath,
  getConversationMessagesFilePath,
  getPlanningStateFilePath,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "@/lib/server/workspace/conversationWorkspace";
import type { Conversation, Goal } from "@/types/kiki";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ContextRequest = {
  conversation: Conversation;
  goal?: Goal | null;
};

async function POSTHandler(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const { conversationId } = await context.params;
    const body = (await request.json()) as ContextRequest;
    if (!body.conversation || body.conversation.id !== conversationId) {
      return NextResponse.json({ ok: false, reason: "会话上下文不匹配" }, { status: 400 });
    }

    ensureConversationWorkspace(conversationId);
    const safeConversation = pickConversationForPrompt(body.conversation);
    const safeGoal = body.goal ? pickGoalForPrompt(body.goal) : null;
    // safeConversation.messages 已经过 sanitize，落盘与 contextPack 共用同一份白名单产物
    writeJsonFileAtomic(
      getConversationMessagesFilePath(conversationId),
      safeConversation.messages,
    );
    writeJsonFileAtomic(getPlanningStateFilePath(conversationId), body.conversation.planningRunState ?? null);
    writeTextFileAtomic(
      getConversationContextFilePath(conversationId),
      buildConversationContextPack({
        conversation: safeConversation,
        goal: safeGoal,
        recentMessages: safeConversation.messages,
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

export const POST = withAuth(POSTHandler);
