import { NextResponse, type NextRequest } from "next/server";

const LEGACY_GOALS_API_PREFIX = "/api/goals";
const LEGACY_GOALS_API_SUNSET = "Tue, 16 Jun 2026 00:00:00 GMT";

function successorPath(pathname: string) {
  return pathname.replace(LEGACY_GOALS_API_PREFIX, "/api/topics");
}

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const { pathname } = request.nextUrl;

  if (pathname === LEGACY_GOALS_API_PREFIX || pathname.startsWith(`${LEGACY_GOALS_API_PREFIX}/`)) {
    response.headers.set("Deprecation", "true");
    response.headers.set("Sunset", LEGACY_GOALS_API_SUNSET);
    response.headers.set("Link", `<${successorPath(pathname)}>; rel="successor-version"`);
  }

  return response;
}

export const config = {
  matcher: ["/api/goals/:path*"],
};
