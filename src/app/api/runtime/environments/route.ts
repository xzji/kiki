import { NextRequest, NextResponse } from "next/server";

import {
  applyRuntimeEnvironmentCommand,
  RuntimeEnvironmentCommandError,
} from "@/lib/server/services/runtimeEnvironmentCommandService";
import type { RuntimeEnvironment } from "@/types/runtime";

export const runtime = "nodejs";

function expectedRevisionFromRequest(request: NextRequest, body: { expectedRevision?: unknown }) {
  const header = request.headers.get("if-match");
  const raw = header ?? body.expectedRevision;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const revision = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(revision) ? revision : undefined;
}

function commandErrorResponse(error: RuntimeEnvironmentCommandError) {
  return NextResponse.json({ ok: false, reason: error.message, ...error.details }, { status: error.status });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      environment?: Omit<RuntimeEnvironment, "id"> | RuntimeEnvironment;
      expectedRevision?: unknown;
    };
    if (!body.environment) {
      return NextResponse.json({ ok: false, reason: "缺少 Runtime 环境参数" }, { status: 400 });
    }
    const result = applyRuntimeEnvironmentCommand({
      type: "create_environment",
      environment: body.environment,
    }, {
      expectedRevision: expectedRevisionFromRequest(request, body),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RuntimeEnvironmentCommandError) {
      return commandErrorResponse(error);
    }
    return NextResponse.json({ ok: false, reason: "Runtime 环境写入失败" }, { status: 500 });
  }
}
