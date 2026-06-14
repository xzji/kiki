import { NextRequest, NextResponse } from "next/server";

import { withAuth } from "@/lib/server/http/withAuth";
import { updateUserDisplayName } from "@/lib/server/services/authService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  displayName?: string;
};

export const PATCH = withAuth(async (request: NextRequest, context: { userId: string }) => {
  const body = (await request.json().catch(() => ({}))) as Body;
  const displayName = typeof body.displayName === "string" ? body.displayName : "";

  const result = updateUserDisplayName({
    userId: context.userId,
    displayName,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 400 });
  }

  return NextResponse.json({ ok: true, user: result.user });
});
