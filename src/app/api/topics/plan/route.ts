import { NextRequest, NextResponse } from "next/server";

import { runTopicInitSagaWithDefaults } from "@/lib/server/topicPlanning";
import { adaptTopicInitSagaToGoalDraft } from "@/lib/server/goalPlanning/sagaDraftAdapter";
import type { RuntimeEnvironment } from "@/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  topicText: string;
  runtimeEnv: RuntimeEnvironment;
  conversationContext?: string;
  maxRefineLoops?: number;
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as RequestBody;
  const topicText = body.topicText?.trim();

  if (!topicText) {
    return NextResponse.json({ reason: "topicText 不能为空" }, { status: 400 });
  }

  if (!body.runtimeEnv || body.runtimeEnv.type !== "local") {
    return NextResponse.json({ reason: "当前没有可用的本地 Claude 环境" }, { status: 400 });
  }

  try {
    const requestId =
      request.headers.get("x-topic-saga-request-id")?.trim() ||
      `topic-saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await runTopicInitSagaWithDefaults({
      topicId: `topic-saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      topicText,
      conversationContext: body.conversationContext,
      userContext: {
        command: "/saga",
        initialRequest: topicText,
      },
      cwd: process.cwd(),
      runtimeEnv: body.runtimeEnv,
      signal: request.signal,
      idempotencyKey: requestId,
      maxRefineLoops:
        typeof body.maxRefineLoops === "number" && Number.isFinite(body.maxRefineLoops)
          ? body.maxRefineLoops
          : undefined,
    });

    if (result.status === "awaiting_user") {
      return NextResponse.json({
        kind: "awaiting_user",
        questions: result.awaitingQuestions ?? [],
        sagaId: result.saga.id,
      });
    }

    if (result.status !== "completed") {
      return NextResponse.json({ reason: "5 角色 Saga 执行失败" }, { status: 500 });
    }

    const draft = adaptTopicInitSagaToGoalDraft({ topicText, result });
    return NextResponse.json({
      kind: "planned",
      draft,
      saga: {
        id: result.saga.id,
        refineLoops: result.refineLoops,
        forcedAccept: result.forcedAccept === true,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        reason: error instanceof Error ? error.message : "5 角色 Saga 执行失败",
      },
      { status: 500 },
    );
  }
}
