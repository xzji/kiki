import { NextRequest, NextResponse } from "next/server";

import { withAuth } from "@/lib/server/http/withAuth";
import { changeUserPassword } from "@/lib/server/services/authService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
};

export const PATCH = withAuth(async (request: NextRequest, context: { userId: string }) => {
  const body = (await request.json().catch(() => ({}))) as Body;
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

  const result = changeUserPassword({
    userId: context.userId,
    currentPassword,
    newPassword,
    confirmPassword,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, reason: result.reason, field: result.field },
      { status: result.field === "currentPassword" ? 403 : 400 },
    );
  }

  return NextResponse.json({ ok: true });
});
