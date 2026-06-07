import { NextRequest, NextResponse } from "next/server";

import {
  checkRegisterRateLimit,
  resolveRegisterClientKey,
} from "@/lib/server/auth/registerRateLimit";
import { buildSessionCookie, registerUser } from "@/lib/server/services/authService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  email?: string;
  password?: string;
  confirmPassword?: string;
  displayName?: string;
  inviteCode?: string;
};

export async function POST(request: NextRequest) {
  const rateLimit = checkRegisterRateLimit(resolveRegisterClientKey(request));
  if (!rateLimit.ok) {
    return NextResponse.json({ ok: false, reason: rateLimit.reason }, { status: 429 });
  }

  const body = (await request.json().catch(() => ({}))) as Body;
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
  const displayName = typeof body.displayName === "string" ? body.displayName : undefined;
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode : "";

  const result = registerUser({ email, password, confirmPassword, displayName, inviteCode });
  if (!result.ok) {
    const status = result.field === "email" ? 409 : result.field === "inviteCode" ? 403 : 400;
    return NextResponse.json(
      { ok: false, reason: result.reason, field: result.field },
      { status },
    );
  }

  const response = NextResponse.json({ ok: true, user: result.session.user });
  response.headers.set("Set-Cookie", buildSessionCookie(result.session.token, result.session.expiresAt));
  return response;
}
