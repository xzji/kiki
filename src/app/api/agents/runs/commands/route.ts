import { NextRequest, NextResponse } from "next/server";

import {
  applyAgentRunCommand,
  AgentRunCommandConflictError,
  AgentRunCommandIdempotencyConflictError,
  AgentRunCommandValidationError,
  type AgentRunCommand,
} from "@/lib/server/services/agentRunCommandService";
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

function parseAgentRunCommand(value: unknown): AgentRunCommand | null {
  const record = asRecord(value);
  const kind = record ? readNonEmptyString(record, "kind") : null;
  if (!record || !kind) return null;
  const agentRunId = readNonEmptyString(record, "agentRunId");
  if (!agentRunId) return null;
  switch (kind) {
    case "pause":
    case "cancel":
    case "retry":
      return { kind, agentRunId };
    case "resume": {
      const input = asRecord(record.input);
      return { kind, agentRunId, input: input ?? undefined };
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
  const command = parseAgentRunCommand(body.command);
  if (!command) {
    return NextResponse.json({ ok: false, reason: "缺少有效 Agent Run 命令" }, { status: 400 });
  }
  if (body.baseRevision !== undefined && typeof body.baseRevision !== "number") {
    return NextResponse.json({ ok: false, reason: "baseRevision 必须是数字" }, { status: 400 });
  }
  try {
    const result = applyAgentRunCommand({
      command,
      idempotencyKey,
      baseRevision: body.baseRevision,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof AgentRunCommandConflictError) {
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
    if (error instanceof AgentRunCommandIdempotencyConflictError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: 409 });
    }
    if (error instanceof AgentRunCommandValidationError) {
      return NextResponse.json({ ok: false, reason: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, reason: "Agent Run 命令执行失败" }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);
