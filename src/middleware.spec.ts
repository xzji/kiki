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

  const unauthApi = middleware(new NextRequest("https://kiki.local/api/topics/commands"));
  assert.equal(unauthApi.status, 401);

  const unauthPage = middleware(new NextRequest("https://kiki.local/"));
  assert.equal(unauthPage.status, 307);
  assert.equal(unauthPage.headers.get("location"), "https://kiki.local/login");

  const loginPage = middleware(new NextRequest("https://kiki.local/login"));
  assert.equal(loginPage.status, 200);

  assert.ok(config.matcher.length > 0);
}
