import { NextRequest, NextResponse } from "next/server";

import {
  applyTopicCommand,
  TopicCommandConflictError,
  TopicCommandIdempotencyConflictError,
  TopicCommandValidationError,
  type TopicCommand,
} from "@/lib/server/services/topicCommandService";
import { normalizeExecutionKind } from "@/types/kiki";
import type { Goal, Task, TaskExpectedResult } from "@/types/kiki";
import { withAuth } from "@/lib/server/http/withAuth";

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
  const executionKind = normalizeExecutionKind(record.executionKind);
  if (!title || !expectedOutcome || !taskType || !triggerRule) return null;
  const description = typeof record.description === "string" ? record.description : undefined;
  const deadline = typeof record.deadline === "string" ? record.deadline : undefined;
  const expectedResult = asRecord(record.expectedResult) ? (record.expectedResult as TaskExpectedResult) : undefined;
  return {
    title,
    description,
    expectedOutcome,
    expectedResult,
    taskType,
    triggerRule,
    deadline,
    executionKind,
  };
}

function parseTopicValue(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;
  const id = readNonEmptyString(record, "id");
  const title = readNonEmptyString(record, "title");
  if (!id || !title || !Array.isArray(record.subGoals)) return null;
  return record as unknown as Goal;
}

function parseTopicCommand(value: unknown): TopicCommand | null {
  const record = asRecord(value);
  const type = record ? readNonEmptyString(record, "type") : null;
  if (!record || !type) return null;
  if (type === "create_topic") {
    const topic = parseTopicValue(record.topic);
    return topic ? { type, topic } : null;
  }
  if (type === "delete_topics_by_conversation") {
    const conversationId = readNonEmptyString(record, "conversationId");
    return conversationId ? { type, conversationId } : null;
  }
  const topicId = readNonEmptyString(record, "topicId");
  if (!topicId) return null;
  switch (type) {
    case "confirm_topic_plan":
      return { type, topicId };
    case "request_topic_plan_revision": {
      const feedback = readNonEmptyString(record, "feedback");
      return feedback ? { type, topicId, feedback } : null;
    }
    case "create_thread": {
      const title = readNonEmptyString(record, "title");
      return title ? { type, topicId, title } : null;
    }
    case "create_task": {
      const threadId = readNonEmptyString(record, "threadId");
      const task = parseTaskInput(record.task);
      return threadId && task ? { type, topicId, threadId, task } : null;
    }
    case "update_task": {
      const taskId = readNonEmptyString(record, "taskId");
      const task = parseTaskInput(record.task);
      return taskId && task ? { type, topicId, taskId, task } : null;
    }
    case "delete_task": {
      const taskId = readNonEmptyString(record, "taskId");
      return taskId ? { type, topicId, taskId } : null;
    }
    default:
      return null;
  }
}

async function POSTHandler(request: NextRequest) {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, reason: "缺少 Idempotency-Key" }, { status: 400 });
  }
  const body = (await request.json().catch(() => ({}))) as Body;
  const command = parseTopicCommand(body.command);
  if (!command) {
    return NextResponse.json({ ok: false, reason: "缺少有效主题命令" }, { status: 400 });
  }
  if (body.baseRevision !== undefined && typeof body.baseRevision !== "number") {
    return NextResponse.json({ ok: false, reason: "baseRevision 必须是数字" }, { status: 400 });
  }
  try {
    const result = applyTopicCommand({
      command,
      idempotencyKey,
      baseRevision: body.baseRevision,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof TopicCommandConflictError) {
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
    if (error instanceof TopicCommandIdempotencyConflictError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: 409 });
    }
    if (error instanceof TopicCommandValidationError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, reason: "主题命令执行失败" }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);
