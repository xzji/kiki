/**
 * payloadGuard spec — verifies the ≤ 8KB inline cap and off-load behavior.
 * Plan ref: §9.6 + §10.10.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { getStorageRootDir } from "@/lib/server/storage/paths";
import { AGENT_EVENT_PAYLOAD_INLINE_LIMIT_BYTES } from "@/types/agentRuntime";

import {
  guardPayload,
  loadOffloadedPayload,
  purgeOffloadedPayloadsForRun,
} from "./payloadGuard";

function buildLargePayload(): Record<string, unknown> {
  // Force the JSON-encoded length above 8KB.
  const filler = "x".repeat(AGENT_EVENT_PAYLOAD_INLINE_LIMIT_BYTES + 256);
  return { filler };
}

export function runPayloadGuardSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // Case 1 — small payload stays inline.
  const small = guardPayload({
    agentRunId: "run-small-1",
    seq: 1,
    payload: { hello: "world" },
  });
  assert.equal(small.payloadRef, undefined);
  assert.ok(small.inlineJson.includes("hello"));

  // Case 2 — large payload off-loaded.
  const big = guardPayload({
    agentRunId: "run-big-1",
    seq: 7,
    payload: buildLargePayload(),
  });
  assert.equal(big.inlineJson, "{}");
  assert.equal(big.payloadRef, "agent-payloads/run-big-1/7.json");

  const offloadFile = path.join(getStorageRootDir(), big.payloadRef!);
  assert.ok(fs.existsSync(offloadFile), "off-loaded file should exist on disk");

  // Case 3 — round-trip read.
  const reloaded = loadOffloadedPayload(big.payloadRef!);
  assert.ok(reloaded);
  assert.equal(typeof (reloaded as { filler: string }).filler, "string");

  // Case 4 — purge cleans the directory.
  purgeOffloadedPayloadsForRun("run-big-1");
  assert.equal(fs.existsSync(offloadFile), false);
}
