import { NextRequest, NextResponse } from "next/server";

import { clearSessionCookie, logoutSession } from "@/lib/server/services/authService";
import { readSessionToken } from "@/lib/server/http/authCookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  logoutSession(readSessionToken(request));
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", clearSessionCookie());
  return response;
}
