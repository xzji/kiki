import { NextRequest, NextResponse } from "next/server";

import type { EasterEggSettings } from "@/lib/goalSystemConfig";
import {
  beginGoalTelemetry,
  failGoalTelemetry,
  finishGoalTelemetry,
  updateGoalTelemetry,
} from "@/lib/server/goalTelemetry";
import {
  generateGoalPlanWithClaude,
  getGoalPlanningCheckpointForResume,
} from "@/lib/server/goalPlanning";
import type { RuntimeEnvironment } from "@/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  conversationId: string;
  runtimeEnv: RuntimeEnvironment;
  config?: EasterEggSettings;
  conversationContext?: string;
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as RequestBody;
  const conversationId = body.conversationId?.trim();
  const requestId =
    request.headers.get("x-goal-request-id")?.trim() ||
    `goal-plan-resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!conversationId) {
    return NextResponse.json({ reason: "conversationId 不能为空" }, { status: 400 });
  }

  if (!body.runtimeEnv || body.runtimeEnv.type !== "local") {
    return NextResponse.json({ reason: "当前没有可用的本地 Claude 环境" }, { status: 400 });
  }

  const checkpoint = getGoalPlanningCheckpointForResume(conversationId);
  if (!checkpoint) {
    return NextResponse.json({ reason: "当前会话没有可恢复的目标规划断点" }, { status: 404 });
  }

  try {
    beginGoalTelemetry({
      requestId,
      scope: "goal_plan",
      phase: checkpoint.stage,
      message: "已收到目标规划断点恢复请求",
    });
    const draft = await generateGoalPlanWithClaude({
      goalText: checkpoint.goalText,
      runtimeEnv: body.runtimeEnv,
      config: body.config,
      conversationId,
      conversationContext: body.conversationContext,
      collectedInfo: checkpoint.collectedInfo,
      resumeFromCheckpoint: true,
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
      message: "目标规划断点恢复完成",
    });
    return NextResponse.json({ draft });
  } catch (error) {
    failGoalTelemetry({
      requestId,
      scope: "goal_plan",
      phase: "error",
      message: "目标规划断点恢复失败",
      error: error instanceof Error ? error.message : "Claude 规划恢复失败",
    });
    return NextResponse.json(
      {
        reason: error instanceof Error ? error.message : "Claude 规划恢复失败",
      },
      { status: 500 },
    );
  }
}
