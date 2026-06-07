import { NextRequest } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/server/auth/authConfig";

export function readSessionToken(request: NextRequest) {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}
