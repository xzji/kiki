import assert from "node:assert/strict";

import { NextRequest } from "next/server";

import { config, middleware } from "@/middleware";

export function runMiddlewareSpecs() {
  const legacy = middleware(new NextRequest("https://kiki.local/api/goals/commands"));
  assert.equal(legacy.headers.get("Deprecation"), "true");
  assert.equal(legacy.headers.get("Sunset"), "Tue, 16 Jun 2026 00:00:00 GMT");
  assert.equal(legacy.headers.get("Link"), '</api/topics/commands>; rel="successor-version"');

  const legacyRoot = middleware(new NextRequest("https://kiki.local/api/goals"));
  assert.equal(legacyRoot.headers.get("Link"), '</api/topics>; rel="successor-version"');

  const canonical = middleware(new NextRequest("https://kiki.local/api/topics/commands"));
  assert.equal(canonical.headers.get("Deprecation"), null);
  assert.deepEqual(config.matcher, ["/api/goals/:path*"]);
}
