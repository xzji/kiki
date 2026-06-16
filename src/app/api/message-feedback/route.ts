import { NextRequest, NextResponse } from "next/server";

import {
  clearMessageFeedback,
  listConversationMessageFeedback,
  MessageFeedbackError,
  submitMessageFeedback,
} from "@/lib/server/services/messageFeedbackService";
import { withAuth } from "@/lib/server/http/withAuth";
import {
  MESSAGE_FEEDBACK_REASON_CODES,
  type MessageFeedbackRating,
  type MessageFeedbackReasonCode,
  type MessageFeedbackTargetFallback,
} from "@/types/messageFeedback";
import type { ConversationMessage } from "@/types/kiki";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PostBody = {
  conversationId?: unknown;
  messageId?: unknown;
  rating?: unknown;
  reasonCodes?: unknown;
  comment?: unknown;
  runtimeEnvId?: unknown;
  targetMessageFallback?: unknown;
};

function parseString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function isMessageFeedbackReasonCode(value: unknown): value is MessageFeedbackReasonCode {
  return typeof value === "string" && MESSAGE_FEEDBACK_REASON_CODES.includes(value as MessageFeedbackReasonCode);
}

function parseReasonCodes(value: unknown): MessageFeedbackReasonCode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isMessageFeedbackReasonCode);
}

function parseMessageStatus(value: unknown): ConversationMessage["status"] | undefined {
  if (value === undefined) return undefined;
  return value === "streaming" || value === "done" || value === "error" ? value : undefined;
}

function parseMessageSource(value: unknown): ConversationMessage["source"] | undefined {
  if (value === undefined) return undefined;
  return value === "user" || value === "kiki" || value === "system" ? value : undefined;
}

function parseFallback(value: unknown): MessageFeedbackTargetFallback | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = parseString(record.id);
  const kind = parseString(record.kind);
  const role = parseString(record.role);
  const content = parseString(record.content);
  const createdAt = parseString(record.createdAt);
  if (!id || kind !== "text" || role !== "kiki" || content === undefined || !createdAt) {
    return undefined;
  }
  return {
    id,
    kind,
    role: "kiki",
    content,
    createdAt,
    status: parseMessageStatus(record.status),
    source: parseMessageSource(record.source),
  };
}

async function GETHandler(request: NextRequest) {
  const conversationId = request.nextUrl.searchParams.get("conversationId")?.trim();
  if (!conversationId) {
    return NextResponse.json({ ok: false, reason: "缺少 conversationId" }, { status: 400 });
  }
  try {
    const feedbacks = listConversationMessageFeedback(conversationId);
    return NextResponse.json({ ok: true, feedbacks });
  } catch (error) {
    if (error instanceof MessageFeedbackError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, reason: "读取消息反馈失败" }, { status: 500 });
  }
}

async function POSTHandler(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  const conversationId = parseString(body.conversationId)?.trim();
  const messageId = parseString(body.messageId)?.trim();
  const rating = parseString(body.rating) as MessageFeedbackRating | undefined;
  if (!conversationId || !messageId || !rating) {
    return NextResponse.json({ ok: false, reason: "反馈参数不完整" }, { status: 400 });
  }
  try {
    const feedback = submitMessageFeedback({
      conversationId,
      messageId,
      rating,
      reasonCodes: parseReasonCodes(body.reasonCodes),
      comment: parseString(body.comment),
      runtimeEnvId: parseString(body.runtimeEnvId),
      targetMessageFallback: parseFallback(body.targetMessageFallback),
    });
    return NextResponse.json({ ok: true, feedback });
  } catch (error) {
    if (error instanceof MessageFeedbackError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, reason: "保存消息反馈失败" }, { status: 500 });
  }
}

async function DELETEHandler(request: NextRequest) {
  const conversationId = request.nextUrl.searchParams.get("conversationId")?.trim();
  const messageId = request.nextUrl.searchParams.get("messageId")?.trim();
  if (!conversationId || !messageId) {
    return NextResponse.json({ ok: false, reason: "反馈参数不完整" }, { status: 400 });
  }
  try {
    clearMessageFeedback({ conversationId, messageId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof MessageFeedbackError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, reason: "取消消息反馈失败" }, { status: 500 });
  }
}

export const GET = withAuth(GETHandler);
export const POST = withAuth(POSTHandler);
export const DELETE = withAuth(DELETEHandler);
