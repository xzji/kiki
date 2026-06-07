import { NextRequest, NextResponse } from "next/server";

import { withAuth } from "@/lib/server/http/withAuth";
import { deleteMachineForUser } from "@/lib/server/services/machineService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function DELETEHandler(
  _request: NextRequest,
  context: { userId: string; params: { machineId: string } },
) {
  const machineId = context.params.machineId?.trim();
  if (!machineId) {
    return NextResponse.json({ ok: false, error: "缺少 machineId" }, { status: 400 });
  }

  const deleted = deleteMachineForUser({ userId: context.userId, machineId });
  if (!deleted) {
    return NextResponse.json({ ok: false, error: "机器不存在" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

export const DELETE = withAuth(DELETEHandler);
