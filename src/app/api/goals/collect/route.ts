import { NextRequest, NextResponse } from "next/server";

import type { EasterEggSettings } from "@/lib/goalSystemConfig";
import {
  beginGoalTelemetry,
  failGoalTelemetry,
  finishGoalTelemetry,
  updateGoalTelemetry,
} from "@/lib/server/goalTelemetry";
import { advanceGoalInfoCollectionWithClaude } from "@/lib/server/goalPlanning";
import type { RuntimeEnvironment } from "@/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
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
  const requestId =
    request.headers.get("x-goal-request-id")?.trim() ||
    `goal-collect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
    beginGoalTelemetry({
      requestId,
      scope: "goal_collect",
      phase: "collecting_info",
      message: "已收到信息收集请求",
    });
    const result = await advanceGoalInfoCollectionWithClaude({
      goalText,
      runtimeEnv: body.runtimeEnv,
      config: body.config,
      conversationId: body.conversationId,
      conversationContext: body.conversationContext,
      history: body.history,
      minRounds: body.minRounds,
      maxRounds: body.maxRounds,
      signal: request.signal,
      requestId,
      onProgress: ({ phase, message, details }) => {
        updateGoalTelemetry({
          requestId,
          scope: "goal_collect",
          phase,
          message,
          details,
        });
      },
    });
    finishGoalTelemetry({
      requestId,
      scope: "goal_collect",
      phase: "collecting_info",
      message: result.status === "complete" ? "信息收集完成，已进入规划前整理" : "信息收集完成，等待用户补充",
    });
    return NextResponse.json(result);
  } catch (error) {
    failGoalTelemetry({
      requestId,
      scope: "goal_collect",
      phase: "error",
      message: "目标信息收集失败",
      error: error instanceof Error ? error.message : "Claude 信息收集失败",
    });
    return NextResponse.json(
      {
        reason: error instanceof Error ? error.message : "Claude 信息收集失败",
      },
      { status: 500 },
    );
  }
}
