import { NextRequest, NextResponse } from "next/server";

import { readComposedGoalsSnapshotMeta } from "@/lib/server/runtime/instanceComposition";
import { startTaskAttempt } from "@/lib/server/taskExecution/startTaskAttempt";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance?: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  action?: "start" | "resume" | "rerun";
};

async function POSTHandler(request: NextRequest) {
  const requestId =
    request.headers.get("x-goal-request-id")?.trim() ||
    `goal-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const body = (await request.json()) as RequestBody;

    if (!body.goal || !body.subGoal || !body.task || !body.runtimeEnv) {
      return NextResponse.json({ reason: "任务执行参数不完整" }, { status: 400 });
    }
    if (body.runtimeEnv.type !== "local") {
      return NextResponse.json({ reason: "当前没有可用的本地 Claude 环境" }, { status: 400 });
    }
    const result = startTaskAttempt({
      goal: body.goal,
      subGoal: body.subGoal,
      task: body.task,
      instance: body.instance,
      runtimeEnv: body.runtimeEnv,
      triggerSource: body.action === "resume" ? "resume_after_pause" : "user",
      requestId,
    });

    if (result.outcome === "blocked_config") {
      return NextResponse.json({ outcome: result.outcome, reason: result.reason, taskInstanceId: result.taskInstanceId }, { status: 409 });
    }
    const goalsSnapshot = readComposedGoalsSnapshotMeta([]);
    const goals = goalsSnapshot.value;

    if (result.outcome === "awaiting_user") {
      return NextResponse.json({
        outcome: result.outcome,
        requestId: result.requestId,
        taskInstanceId: result.taskInstanceId,
        waitingReason: result.waitingReason,
        progress: result.progress,
        goals,
        revision: goalsSnapshot.revision,
        queued: false,
      });
    }

    if (result.outcome === "already_running") {
      return NextResponse.json({
        outcome: result.outcome,
        requestId: result.requestId ?? requestId,
        taskInstanceId: result.taskInstanceId,
        goals,
        revision: goalsSnapshot.revision,
        queued: true,
      });
    }

    if (result.outcome === "already_completed") {
      return NextResponse.json({
        outcome: result.outcome,
        requestId: result.requestId ?? requestId,
        taskInstanceId: result.taskInstanceId,
        goals,
        revision: goalsSnapshot.revision,
        queued: false,
      });
    }

    return NextResponse.json({
      outcome: result.outcome,
      requestId: result.requestId,
      taskInstanceId: result.taskInstanceId,
      goals,
      revision: goalsSnapshot.revision,
      queued: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "任务执行启动失败";
    console.error("[api/goals/tasks/execute] 任务执行启动异常", { requestId, error });
    return NextResponse.json({ reason, requestId }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);
