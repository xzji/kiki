import { NextRequest, NextResponse } from "next/server";

import { validateRuntimeEnvironment } from "@/lib/server/runtimeEnvValidation";
import type { RuntimeEnvironmentCheckInput } from "@/types/runtime";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as RuntimeEnvironmentCheckInput;
  const result = await validateRuntimeEnvironment(body);

  return NextResponse.json(result, {
    status: result.ok ? 200 : 400,
  });
}
