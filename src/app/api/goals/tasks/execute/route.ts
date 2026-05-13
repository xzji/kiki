import { NextRequest, NextResponse } from "next/server";

import {
  createQueuedRuntimeJob,
  getRuntimeJobByTaskInstanceId,
  updateRuntimeJobExecution,
} from "@/lib/server/repositories/runtimeJobsRepository";
import {
  markGoalInstanceRunStarted,
  upsertGoalTaskInstanceSnapshot,
} from "@/lib/server/runtime/goalStateSnapshot";
import { readGoalsSnapshot, upsertGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { buildGoalTaskRunnerPrompt } from "@/lib/server/goalTaskPrompt";
import {
  ensureConversationWorkspace,
  ensureTaskWorkspace,
  writeTaskPromptFile,
} from "@/lib/server/workspace/conversationWorkspace";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as RequestBody;
  const requestId =
    request.headers.get("x-goal-request-id")?.trim() ||
    `goal-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!body.goal || !body.subGoal || !body.task || !body.instance || !body.runtimeEnv) {
    return NextResponse.json({ reason: "任务执行参数不完整" }, { status: 400 });
  }
  if (body.runtimeEnv.type !== "local") {
    return NextResponse.json({ reason: "当前没有可用的本地 Claude 环境" }, { status: 400 });
  }
  const conversationId = body.goal.conversationId;
  if (!conversationId) {
    return NextResponse.json({ reason: "任务缺少 conversationId，无法创建隔离 workspace" }, { status: 400 });
  }

  const conversationWorkspace = ensureConversationWorkspace(conversationId);
  const taskWorkspaceDir = ensureTaskWorkspace({
    conversationId,
    taskId: body.task.id,
    instanceId: body.instance.id,
  });
  const prompt = buildGoalTaskRunnerPrompt({
    goal: body.goal,
    subGoal: body.subGoal,
    task: body.task,
    instance: body.instance,
  });
  writeTaskPromptFile({
    conversationId,
    taskId: body.task.id,
    instanceId: body.instance.id,
    content: prompt,
  });

  const existing = getRuntimeJobByTaskInstanceId(body.instance.id);
  if (existing && (existing.status === "queued" || existing.status === "running" || existing.status === "awaiting_user")) {
    return NextResponse.json({
      requestId: existing.requestId ?? requestId,
      taskInstanceId: body.instance.id,
      queued: true,
    });
  }

  const currentGoals = readGoalsSnapshot([body.goal]);
  const withInstance = upsertGoalTaskInstanceSnapshot(currentGoals, {
    goal: body.goal,
    subGoal: body.subGoal,
    task: body.task,
    instance: body.instance,
  });
  const nextGoals = markGoalInstanceRunStarted(withInstance, {
    taskId: body.task.id,
    instanceId: body.instance.id,
    requestId,
    runtimeEnvId: body.runtimeEnv.id,
    permissionMode: body.runtimeEnv.permissionMode,
    workingDirectory: taskWorkspaceDir,
  });
  upsertGoalsSnapshot(nextGoals);

  createQueuedRuntimeJob(
    {
      goal: body.goal,
      subGoal: body.subGoal,
      task: body.task,
      instance: body.instance,
      runtimeEnv: body.runtimeEnv,
      conversationWorkspaceDir: conversationWorkspace.workspaceDir,
      taskWorkspaceDir,
    },
    { requestId },
  );
  updateRuntimeJobExecution(`job-${body.instance.id}`, {
    requestId,
    status: "queued",
    progress: null,
    logs: [],
    blocker: null,
    result: null,
    lastError: undefined,
    finishedAt: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
  });

  return NextResponse.json({
    requestId,
    taskInstanceId: body.instance.id,
    workspacePath: taskWorkspaceDir,
    queued: true,
  });
}
