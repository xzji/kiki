import { NextResponse, type NextRequest } from "next/server";

const LEGACY_GOALS_API_PREFIX = "/api/goals";
const LEGACY_GOALS_API_SUNSET = "Tue, 16 Jun 2026 00:00:00 GMT";
const SESSION_COOKIE_NAME = process.env.KIKI_AUTH_COOKIE_NAME?.trim() || "kiki_session";

const PUBLIC_PATH_PREFIXES = [
  "/api/auth/",
  "/api/machine-tunnel/",
  "/login",
  "/register",
  "/_next/",
  "/favicon",
];

function successorPath(pathname: string) {
  return pathname.replace(LEGACY_GOALS_API_PREFIX, "/api/topics");
}

function isPublicPath(pathname: string) {
  if (pathname === "/favicon.ico") return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

function hasSessionCookie(request: NextRequest) {
  return Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === LEGACY_GOALS_API_PREFIX || pathname.startsWith(`${LEGACY_GOALS_API_PREFIX}/`)) {
    const response = NextResponse.next();
    response.headers.set("Deprecation", "true");
    response.headers.set("Sunset", LEGACY_GOALS_API_SUNSET);
    response.headers.set("Link", `<${successorPath(pathname)}>; rel="successor-version"`);
    return response;
  }

  if (isPublicPath(pathname)) {
    if ((pathname === "/login" || pathname === "/register") && hasSessionCookie(request)) {
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = "/";
      homeUrl.search = "";
      return NextResponse.redirect(homeUrl);
    }
    return NextResponse.next();
  }

  if (!hasSessionCookie(request)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, reason: "未登录" }, { status: 401 });
    }
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|fonts|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
