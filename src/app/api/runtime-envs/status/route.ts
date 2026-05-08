import { NextRequest, NextResponse } from "next/server";

import { validateRuntimeEnvironment } from "@/lib/server/runtimeEnvValidation";
import type { LocalRuntimeKind } from "@/types/runtime";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const workingDirectory = request.nextUrl.searchParams.get("workingDirectory") || "";
  const cliPath = request.nextUrl.searchParams.get("cliPath") || "claude";
  const runtimeKind = (request.nextUrl.searchParams.get("runtimeKind") || "claude") as LocalRuntimeKind;

  const result = await validateRuntimeEnvironment({
    name: "Runtime Status Check",
    runtimeKind,
    workingDirectory,
    cliPath,
    permissionMode: "confirm",
  });

  return NextResponse.json(result, {
    status: result.ok ? 200 : 400,
  });
}
