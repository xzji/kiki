import { NextRequest, NextResponse } from "next/server";

import {
  applyRuntimeEnvironmentCommand,
  RuntimeEnvironmentCommandError,
} from "@/lib/server/services/runtimeEnvironmentCommandService";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

type Params = {
  params: { id: string };
};

function expectedRevisionFromRequest(request: NextRequest) {
  const raw = request.headers.get("if-match");
  if (raw === undefined || raw === null || raw === "") return undefined;
  const revision = Number(raw);
  return Number.isFinite(revision) ? revision : undefined;
}

function commandErrorResponse(error: RuntimeEnvironmentCommandError) {
  return NextResponse.json({ ok: false, reason: error.message, ...error.details }, { status: error.status });
}

async function POSTHandler(request: NextRequest, { params }: Params) {
  try {
    const { id } = params;
    const result = applyRuntimeEnvironmentCommand({
      type: "activate_environment",
      id,
    }, {
      expectedRevision: expectedRevisionFromRequest(request),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RuntimeEnvironmentCommandError) {
      return commandErrorResponse(error);
    }
    return NextResponse.json({ ok: false, reason: "Runtime 环境切换失败" }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);
