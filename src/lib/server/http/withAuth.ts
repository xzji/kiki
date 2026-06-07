import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, isDevRoutesDisabled } from "@/lib/server/auth/authConfig";
import { runWithUserContext } from "@/lib/server/context/userContext";
import { resolveSessionFromToken } from "@/lib/server/services/authService";

type AuthenticatedHandler = (
  request: NextRequest,
  // Route handlers 的 context 形态不一（params 同步/异步、额外字段），保持宽松以兼容 App Router。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
) => Promise<Response> | Response;

function isMutatingMethod(method: string) {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isSameOriginRequest(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) {
    const fetchSite = request.headers.get("sec-fetch-site");
    return fetchSite === "same-origin" || fetchSite === "none";
  }
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

function unauthorizedResponse(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, reason: "未登录" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

function forbiddenDevResponse() {
  return NextResponse.json({ ok: false, reason: "开发接口已禁用" }, { status: 403 });
}

export function withAuth(handler: AuthenticatedHandler) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (request: NextRequest, routeContext: any = {}) => {
    if (request.nextUrl.pathname.startsWith("/api/dev/") && isDevRoutesDisabled()) {
      return forbiddenDevResponse();
    }

    if (isMutatingMethod(request.method) && !isSameOriginRequest(request)) {
      return NextResponse.json({ ok: false, reason: "跨站请求被拒绝" }, { status: 403 });
    }

    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const user = resolveSessionFromToken(token);
    if (!user) {
      return unauthorizedResponse(request);
    }

    return runWithUserContext(user.id, async () =>
      handler(request, { ...routeContext, userId: user.id }),
    );
  };
}
