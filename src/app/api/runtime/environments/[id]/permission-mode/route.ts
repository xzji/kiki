import { NextRequest, NextResponse } from "next/server";

import {
  applyRuntimeEnvironmentCommand,
  RuntimeEnvironmentCommandError,
} from "@/lib/server/services/runtimeEnvironmentCommandService";
import type { RuntimePermissionMode } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

type Params = {
  params: { id: string };
};

function isPermissionMode(value: unknown): value is RuntimePermissionMode {
  return value === "readonly" || value === "confirm" || value === "execute";
}

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

async function POSTHandler(request: NextRequest, { params }: Params) {
  try {
    const { id } = params;
    const body = (await request.json()) as { permissionMode?: unknown; expectedRevision?: unknown };
    if (!isPermissionMode(body.permissionMode)) {
      return NextResponse.json({ ok: false, reason: "权限模式参数无效" }, { status: 400 });
    }
    const result = applyRuntimeEnvironmentCommand({
      type: "set_permission_mode",
      id,
      permissionMode: body.permissionMode,
    }, {
      expectedRevision: expectedRevisionFromRequest(request, body),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RuntimeEnvironmentCommandError) {
      return commandErrorResponse(error);
    }
    return NextResponse.json({ ok: false, reason: "Runtime 权限模式更新失败" }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);
