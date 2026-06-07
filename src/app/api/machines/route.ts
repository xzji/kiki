import { NextRequest, NextResponse } from "next/server";

import { withAuth } from "@/lib/server/http/withAuth";
import { getPublicBaseUrl } from "@/lib/server/http/publicBaseUrl";
import { createMachineForUser, listMachinesForUser } from "@/lib/server/services/machineService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(_request: NextRequest, context: { userId: string }) {
  const machines = listMachinesForUser(context.userId);
  return NextResponse.json({ ok: true, machines });
}

async function POSTHandler(request: NextRequest, context: { userId: string }) {
  const body = (await request.json().catch(() => ({}))) as { name?: string; fingerprint?: string };
  const name = typeof body.name === "string" ? body.name : undefined;
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : undefined;
  const { machine, apiKey } = createMachineForUser({
    userId: context.userId,
    name,
    fingerprint,
  });
  return NextResponse.json({
    ok: true,
    machine,
    apiKey,
    connectCommand: `pnpm daemon:remote --server-url ${getPublicBaseUrl()} --api-key ${apiKey}`,
  });
}

export const GET = withAuth(GETHandler);
export const POST = withAuth(POSTHandler);
