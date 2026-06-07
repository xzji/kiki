import { NextRequest, NextResponse } from "next/server";

import type { EasterEggSettings } from "@/lib/goalSystemConfig";
import { generateGoalClarificationQuestionsWithClaude } from "@/lib/server/goalPlanning";
import type { RuntimeEnvironment } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationId?: string;
  conversationContext?: string;
};

async function POSTHandler(request: NextRequest) {
  const body = (await request.json()) as RequestBody;
  const goalText = body.goalText?.trim();

  if (!goalText) {
    return NextResponse.json({ reason: "goalText 不能为空" }, { status: 400 });
  }

  if (!body.runtimeEnv || body.runtimeEnv.type !== "local") {
    return NextResponse.json({ reason: "当前没有可用的本地 Claude 环境" }, { status: 400 });
  }

  try {
    const result = await generateGoalClarificationQuestionsWithClaude({
      goalText,
      runtimeEnv: body.runtimeEnv,
      config: body.config,
      conversationId: body.conversationId,
      conversationContext: body.conversationContext,
      signal: request.signal,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        reason: error instanceof Error ? error.message : "Claude 澄清问题生成失败",
      },
      { status: 500 },
    );
  }
}

export const POST = withAuth(POSTHandler);
