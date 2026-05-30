import { NextRequest, NextResponse } from "next/server";

import {
  applyConversationCommand,
  ConversationCommandConflictError,
  ConversationCommandIdempotencyConflictError,
  ConversationCommandValidationError,
  type ConversationCommand,
} from "@/lib/server/services/conversationCommandService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  command?: unknown;
  expectedRevision?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseConversationCommand(value: unknown): ConversationCommand | null {
  const record = asRecord(value);
  const type = typeof record?.type === "string" ? record.type : null;
  if (!record || !type) return null;
  if (type === "create_conversation") {
    const conversation = asRecord(record.conversation);
    if (!conversation || typeof conversation.id !== "string" || typeof conversation.title !== "string") return null;
    return record as unknown as ConversationCommand;
  }
  if (typeof record.conversationId !== "string" || !record.conversationId.trim()) return null;
  return record as unknown as ConversationCommand;
}

export async function POST(request: NextRequest) {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, reason: "缺少 Idempotency-Key" }, { status: 400 });
  }
  const body = (await request.json().catch(() => ({}))) as Body;
  const command = parseConversationCommand(body.command);
  if (!command) {
    return NextResponse.json({ ok: false, reason: "缺少有效会话命令" }, { status: 400 });
  }
  if (body.expectedRevision !== undefined && typeof body.expectedRevision !== "number") {
    return NextResponse.json({ ok: false, reason: "expectedRevision 必须是数字" }, { status: 400 });
  }
  try {
    const result = applyConversationCommand({
      command,
      idempotencyKey,
      expectedRevision: body.expectedRevision,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ConversationCommandConflictError) {
      return NextResponse.json(
        {
          ok: false,
          reason: error.message,
          currentRevision: error.currentRevision,
          expectedRevision: error.expectedRevision,
        },
        { status: 409 },
      );
    }
    if (error instanceof ConversationCommandIdempotencyConflictError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: 409 });
    }
    if (error instanceof ConversationCommandValidationError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, reason: "会话命令执行失败" }, { status: 500 });
  }
}
