import { NextRequest, NextResponse } from "next/server";

import { generateGoalPlanWithClaude } from "@/lib/server/goalPlanning";
import type { RuntimeEnvironment } from "@/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  conversationContext?: string;
  collectedInfo?: string;
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as RequestBody;
  const goalText = body.goalText?.trim();

  if (!goalText) {
    return NextResponse.json({ reason: "goalText 不能为空" }, { status: 400 });
  }

  if (!body.runtimeEnv || body.runtimeEnv.type !== "local") {
    return NextResponse.json({ reason: "当前没有可用的本地 Claude 环境" }, { status: 400 });
  }

  try {
    const draft = await generateGoalPlanWithClaude({
      goalText,
      runtimeEnv: body.runtimeEnv,
      conversationContext: body.conversationContext,
      collectedInfo: body.collectedInfo,
      signal: request.signal,
    });
    return NextResponse.json({ draft });
  } catch (error) {
    return NextResponse.json(
      {
        reason: error instanceof Error ? error.message : "Claude 规划生成失败",
      },
      { status: 500 },
    );
  }
}
