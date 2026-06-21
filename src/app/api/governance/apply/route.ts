import { NextRequest, NextResponse } from "next/server";

import { applyGovernanceCommand } from "@/lib/server/governance/governanceCommandService";
import type { GovernanceApplyMode, GovernanceIntent, TaskRef } from "@/lib/server/governance/governanceIntent";
import type { TaskPatch } from "@/lib/server/governance/taskPatchMerge";
import type { QuotedConversationMessageContext, RuntimeEnvironment } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  conversationId: string;
  intent: GovernanceIntent;
  taskRef: TaskRef;
  patch?: TaskPatch;
  revisionHint?: string;
  applyMode?: GovernanceApplyMode;
  userMessage: string;
  runtimeEnv?: RuntimeEnvironment;
  quotedMessage?: QuotedConversationMessageContext | null;
};

async function POSTHandler(request: NextRequest) {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, reason: "缺少 Idempotency-Key" }, { status: 400 });
  }
  const body = (await request.json().catch(() => ({}))) as Partial<RequestBody>;
  if (!body.conversationId || !body.intent || !body.taskRef || !body.userMessage) {
    return NextResponse.json({ ok: false, reason: "治理命令参数不完整" }, { status: 400 });
  }
  try {
    const result = await applyGovernanceCommand({
      conversationId: body.conversationId,
      intent: body.intent,
      taskRef: body.taskRef,
      patch: body.patch,
      revisionHint: body.revisionHint,
      applyMode: body.applyMode,
      userMessage: body.userMessage,
      runtimeEnv: body.runtimeEnv,
      quotedMessage: body.quotedMessage,
      idempotencyKey,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "治理命令执行失败" },
      { status: 500 },
    );
  }
}

export const POST = withAuth(POSTHandler);
