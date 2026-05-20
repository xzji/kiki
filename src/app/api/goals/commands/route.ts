import { NextRequest, NextResponse } from "next/server";

import {
  applyGoalCommand,
  GoalCommandConflictError,
  GoalCommandIdempotencyConflictError,
  GoalCommandValidationError,
  type GoalCommand,
} from "@/lib/server/services/goalCommandService";
import type { ExecutionKind, Goal, Task } from "@/types/kiki";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  command?: unknown;
  baseRevision?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readNonEmptyString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseTaskInput(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;
  const title = readNonEmptyString(record, "title");
  const expectedOutcome = readNonEmptyString(record, "expectedOutcome");
  const taskType = readNonEmptyString(record, "taskType") as Task["taskType"] | null;
  const triggerRule = readNonEmptyString(record, "triggerRule");
  const executionKind = readNonEmptyString(record, "executionKind") as ExecutionKind | null;
  if (!title || !expectedOutcome || !taskType || !triggerRule || !executionKind) return null;
  const description = typeof record.description === "string" ? record.description : undefined;
  const deadline = typeof record.deadline === "string" ? record.deadline : undefined;
  return {
    title,
    description,
    expectedOutcome,
    taskType,
    triggerRule,
    deadline,
    executionKind,
  };
}

function parseGoalValue(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;
  const id = readNonEmptyString(record, "id");
  const title = readNonEmptyString(record, "title");
  if (!id || !title || !Array.isArray(record.subGoals)) return null;
  return record as unknown as Goal;
}

function parseGoalCommand(value: unknown): GoalCommand | null {
  const record = asRecord(value);
  const type = record ? readNonEmptyString(record, "type") : null;
  if (!record || !type) return null;
  if (type === "create_goal") {
    const goal = parseGoalValue(record.goal);
    return goal ? { type, goal } : null;
  }
  if (type === "delete_goals_by_conversation") {
    const conversationId = readNonEmptyString(record, "conversationId");
    return conversationId ? { type, conversationId } : null;
  }
  const goalId = readNonEmptyString(record, "goalId");
  if (!goalId) return null;
  switch (type) {
    case "confirm_goal_plan":
      return { type, goalId };
    case "request_goal_plan_revision": {
      const feedback = readNonEmptyString(record, "feedback");
      return feedback ? { type, goalId, feedback } : null;
    }
    case "create_sub_goal": {
      const title = readNonEmptyString(record, "title");
      return title ? { type, goalId, title } : null;
    }
    case "create_task": {
      const subGoalId = readNonEmptyString(record, "subGoalId");
      const task = parseTaskInput(record.task);
      return subGoalId && task ? { type, goalId, subGoalId, task } : null;
    }
    case "update_task": {
      const taskId = readNonEmptyString(record, "taskId");
      const task = parseTaskInput(record.task);
      return taskId && task ? { type, goalId, taskId, task } : null;
    }
    case "delete_task": {
      const taskId = readNonEmptyString(record, "taskId");
      return taskId ? { type, goalId, taskId } : null;
    }
    default:
      return null;
  }
}

export async function POST(request: NextRequest) {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, reason: "缺少 Idempotency-Key" }, { status: 400 });
  }
  const body = (await request.json().catch(() => ({}))) as Body;
  const command = parseGoalCommand(body.command);
  if (!command) {
    return NextResponse.json({ ok: false, reason: "缺少有效目标命令" }, { status: 400 });
  }
  if (body.baseRevision !== undefined && typeof body.baseRevision !== "number") {
    return NextResponse.json({ ok: false, reason: "baseRevision 必须是数字" }, { status: 400 });
  }
  try {
    const result = applyGoalCommand({
      command,
      idempotencyKey,
      baseRevision: body.baseRevision,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof GoalCommandConflictError) {
      return NextResponse.json(
        {
          ok: false,
          reason: error.message,
          currentRevision: error.currentRevision,
          expectedRevision: error.expectedRevision,
        },
        { status: 409 },
      );
    }
    if (error instanceof GoalCommandIdempotencyConflictError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: 409 });
    }
    if (error instanceof GoalCommandValidationError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, reason: "目标命令执行失败" }, { status: 500 });
  }
}
