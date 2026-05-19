import { NextResponse } from "next/server";

const DEFAULT_SUNSET = "Tue, 16 Jun 2026 00:00:00 GMT";

export function withDeprecatedApiHeaders<T extends NextResponse>(response: T, successorPath: string): T {
  response.headers.set("Deprecation", "true");
  response.headers.set("Sunset", DEFAULT_SUNSET);
  response.headers.set("Link", `<${successorPath}>; rel="successor-version"`);
  return response;
}
