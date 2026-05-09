import { NextRequest, NextResponse } from "next/server";

import { advanceGoalInfoCollectionWithClaude } from "@/lib/server/goalPlanning";
import type { RuntimeEnvironment } from "@/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  conversationId?: string;
  conversationContext?: string;
  history: Array<{
    questions: string[];
    answer?: string;
  }>;
  minRounds?: number;
  maxRounds?: number;
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

  if (!Array.isArray(body.history)) {
    return NextResponse.json({ reason: "history 必须是数组" }, { status: 400 });
  }

  try {
    const result = await advanceGoalInfoCollectionWithClaude({
      goalText,
      runtimeEnv: body.runtimeEnv,
      conversationContext: body.conversationContext,
      history: body.history,
      minRounds: body.minRounds,
      maxRounds: body.maxRounds,
      signal: request.signal,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        reason: error instanceof Error ? error.message : "Claude 信息收集失败",
      },
      { status: 500 },
    );
  }
}
