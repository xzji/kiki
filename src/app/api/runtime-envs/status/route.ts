import { NextRequest, NextResponse } from "next/server";

import { validateRuntimeEnvironmentForUser } from "@/lib/server/tunnel/remoteRuntimeProxy";
import type { LocalRuntimeKind } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

async function GETHandler(request: NextRequest, context: { userId: string }) {
  const workingDirectory = request.nextUrl.searchParams.get("workingDirectory") || "";
  const cliPath = request.nextUrl.searchParams.get("cliPath") || "claude";
  const runtimeKind = (request.nextUrl.searchParams.get("runtimeKind") || "claude") as LocalRuntimeKind;

  const result = await validateRuntimeEnvironmentForUser(context.userId, {
    name: "Runtime Status Check",
    runtimeKind,
    workingDirectory,
    cliPath,
    permissionMode: "execute",
  });

  return NextResponse.json(result, {
    status: result.ok ? 200 : 400,
  });
}

export const GET = withAuth(GETHandler);
