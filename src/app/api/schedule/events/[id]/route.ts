import { NextRequest, NextResponse } from "next/server";

import {
  applyScheduleEventCommand,
  ScheduleEventCommandError,
} from "@/lib/server/services/scheduleEventCommandService";
import type { AgentEvent } from "@/types/schedule";

export const runtime = "nodejs";

type Params = {
  params: { id: string };
};

function expectedRevisionFromRequest(request: NextRequest, body?: { expectedRevision?: unknown }) {
  const header = request.headers.get("if-match");
  const raw = header ?? body?.expectedRevision;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const revision = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(revision) ? revision : undefined;
}

function commandErrorResponse(error: ScheduleEventCommandError) {
  return NextResponse.json({ ok: false, reason: error.message, ...error.details }, { status: error.status });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { id } = params;
    const body = (await request.json()) as { event?: AgentEvent; expectedRevision?: unknown };
    if (!body.event || body.event.id !== id) {
      return NextResponse.json({ ok: false, reason: "日程事件参数无效" }, { status: 400 });
    }
    const result = applyScheduleEventCommand({
      type: "update_schedule_event",
      event: body.event,
    }, {
      expectedRevision: expectedRevisionFromRequest(request, body),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ScheduleEventCommandError) {
      return commandErrorResponse(error);
    }
    return NextResponse.json({ ok: false, reason: "日程事件更新失败" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id } = params;
    const result = applyScheduleEventCommand({
      type: "delete_schedule_event",
      id,
    }, {
      expectedRevision: expectedRevisionFromRequest(request),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ScheduleEventCommandError) {
      return commandErrorResponse(error);
    }
    return NextResponse.json({ ok: false, reason: "日程事件删除失败" }, { status: 500 });
  }
}
