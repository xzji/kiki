import { NextRequest, NextResponse } from "next/server";

import { resolveSessionFromToken } from "@/lib/server/services/authService";
import { readSessionToken } from "@/lib/server/http/authCookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = resolveSessionFromToken(readSessionToken(request));
  if (!user) {
    return NextResponse.json({ ok: false, reason: "未登录" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, user });
}
