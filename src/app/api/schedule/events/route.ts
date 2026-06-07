import { NextRequest, NextResponse } from "next/server";

import {
  applyScheduleEventCommand,
  ScheduleEventCommandError,
} from "@/lib/server/services/scheduleEventCommandService";
import type { AgentEvent } from "@/types/schedule";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

function expectedRevisionFromRequest(request: NextRequest, body: { expectedRevision?: unknown }) {
  const header = request.headers.get("if-match");
  const raw = header ?? body.expectedRevision;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const revision = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(revision) ? revision : undefined;
}

function commandErrorResponse(error: ScheduleEventCommandError) {
  return NextResponse.json({ ok: false, reason: error.message, ...error.details }, { status: error.status });
}

async function POSTHandler(request: NextRequest) {
  try {
    const body = (await request.json()) as { event?: AgentEvent; expectedRevision?: unknown };
    if (!body.event) {
      return NextResponse.json({ ok: false, reason: "缺少日程事件参数" }, { status: 400 });
    }
    const result = applyScheduleEventCommand({
      type: "create_schedule_event",
      event: body.event,
    }, {
      expectedRevision: expectedRevisionFromRequest(request, body),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ScheduleEventCommandError) {
      return commandErrorResponse(error);
    }
    return NextResponse.json({ ok: false, reason: "日程事件创建失败" }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);
