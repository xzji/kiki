import { NextRequest, NextResponse } from "next/server";

import {
  applyRuntimeEnvironmentCommand,
  RuntimeEnvironmentCommandError,
} from "@/lib/server/services/runtimeEnvironmentCommandService";
import type { RuntimeEnvironment } from "@/types/runtime";

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

function commandErrorResponse(error: RuntimeEnvironmentCommandError) {
  return NextResponse.json({ ok: false, reason: error.message, ...error.details }, { status: error.status });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { id } = params;
    const body = (await request.json()) as { patch?: Partial<RuntimeEnvironment>; expectedRevision?: unknown };
    if (!body.patch) {
      return NextResponse.json({ ok: false, reason: "缺少 Runtime 环境更新参数" }, { status: 400 });
    }
    const result = applyRuntimeEnvironmentCommand({
      type: "update_environment",
      id,
      patch: body.patch,
    }, {
      expectedRevision: expectedRevisionFromRequest(request, body),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RuntimeEnvironmentCommandError) {
      return commandErrorResponse(error);
    }
    return NextResponse.json({ ok: false, reason: "Runtime 环境更新失败" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id } = params;
    const result = applyRuntimeEnvironmentCommand({
      type: "remove_environment",
      id,
    }, {
      expectedRevision: expectedRevisionFromRequest(request),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RuntimeEnvironmentCommandError) {
      return commandErrorResponse(error);
    }
    return NextResponse.json({ ok: false, reason: "Runtime 环境删除失败" }, { status: 500 });
  }
}
