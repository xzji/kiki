import { NextRequest, NextResponse } from "next/server";

import { resumeBlockedTask } from "@/lib/server/taskExecution/resumeBlockedTask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const result = await resumeBlockedTask(body);
  return NextResponse.json(result.body, { status: result.status });
}
