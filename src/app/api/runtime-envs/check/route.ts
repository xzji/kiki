import { NextRequest, NextResponse } from "next/server";

import { validateRuntimeEnvironmentForUser } from "@/lib/server/tunnel/remoteRuntimeProxy";
import type { RuntimeEnvironmentCheckInput } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";

async function POSTHandler(request: NextRequest, context: { userId: string }) {
  const body = (await request.json()) as RuntimeEnvironmentCheckInput;
  const result = await validateRuntimeEnvironmentForUser(context.userId, body);

  return NextResponse.json(result, {
    status: result.ok ? 200 : 400,
  });
}

export const POST = withAuth(POSTHandler);
