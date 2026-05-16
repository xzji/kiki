import { NextRequest, NextResponse } from "next/server";

import type { EasterEggSettings } from "@/lib/goalSystemConfig";
import {
  beginGoalTelemetry,
  failGoalTelemetry,
  finishGoalTelemetry,
  updateGoalTelemetry,
} from "@/lib/server/goalTelemetry";
import { generateGoalPlanWithClaude } from "@/lib/server/goalPlanning";
import type { RuntimeEnvironment } from "@/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  goalText: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationId?: string;
  conversationContext?: string;
  collectedInfo?: string;
  resumeFromCheckpoint?: boolean;
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as RequestBody;
  const goalText = body.goalText?.trim();
  const requestId =
    request.headers.get("x-goal-request-id")?.trim() ||
    `goal-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!goalText) {
    return NextResponse.json({ reason: "goalText 不能为空" }, { status: 400 });
  }

  if (!body.runtimeEnv || body.runtimeEnv.type !== "local") {
    return NextResponse.json({ reason: "当前没有可用的本地 Claude 环境" }, { status: 400 });
  }

  try {
    beginGoalTelemetry({
      requestId,
      scope: "goal_plan",
      phase: "collecting_info",
      message: "已收到目标规划请求",
    });
    const draft = await generateGoalPlanWithClaude({
      goalText,
      runtimeEnv: body.runtimeEnv,
      config: body.config,
      conversationId: body.conversationId,
      conversationContext: body.conversationContext,
      collectedInfo: body.collectedInfo,
      resumeFromCheckpoint: body.resumeFromCheckpoint,
      signal: request.signal,
      requestId,
      onProgress: ({ phase, message, details }) => {
        updateGoalTelemetry({
          requestId,
          scope: "goal_plan",
          phase,
          message,
          details,
        });
      },
    });
    finishGoalTelemetry({
      requestId,
      scope: "goal_plan",
      phase: "presenting_plan",
      message: "目标规划生成完成",
    });
    return NextResponse.json({ draft });
  } catch (error) {
    failGoalTelemetry({
      requestId,
      scope: "goal_plan",
      phase: "error",
      message: "目标规划生成失败",
      error: error instanceof Error ? error.message : "Claude 规划生成失败",
    });
    return NextResponse.json(
      {
        reason: error instanceof Error ? error.message : "Claude 规划生成失败",
      },
      { status: 500 },
    );
  }
}
