import { NextRequest, NextResponse } from "next/server";

import { validateRuntimeEnvironment } from "@/lib/server/runtimeEnvValidation";
import type { RuntimeEnvironmentCheckInput } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

async function POSTHandler(request: NextRequest) {
  const body = (await request.json()) as RuntimeEnvironmentCheckInput;
  const result = await validateRuntimeEnvironment(body);

  return NextResponse.json(result, {
    status: result.ok ? 200 : 400,
  });
}

export const POST = withAuth(POSTHandler);
