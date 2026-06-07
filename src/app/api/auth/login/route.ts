import { NextRequest, NextResponse } from "next/server";

import { buildSessionCookie, loginUser } from "@/lib/server/services/authService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  email?: string;
  password?: string;
};

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  const result = loginUser({ email, password });
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, user: result.session.user });
  response.headers.set("Set-Cookie", buildSessionCookie(result.session.token, result.session.expiresAt));
  return response;
}
