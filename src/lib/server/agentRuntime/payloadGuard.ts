/**
 * payloadGuard — enforce the ≤ 8KB inline payload cap on `agent_events.payload`.
 *
 * Plan ref: §3.1.4 + §9.1 problem 5.
 *
 * Behavior:
 * - If `JSON.stringify(payload)` is within the limit: return `{ inlineJson, payloadRef: undefined }`.
 * - Otherwise: write the full payload to
 *   `${getStorageRootDir()}/agent-payloads/${agentRunId}/${seq}.json`
 *   and return `{ inlineJson: "{}", payloadRef: "agent-payloads/${agentRunId}/${seq}.json" }`.
 *
 * Cleanup of off-loaded files is handled by recoveryWorker (§9.1 problem 5).
 */

import fs from "node:fs";
import path from "node:path";

import { getStorageRootDir } from "@/lib/server/storage/paths";
import { AGENT_EVENT_PAYLOAD_INLINE_LIMIT_BYTES } from "@/types/agentRuntime";

export type GuardedPayload = {
  /** The inline JSON string to write into `agent_events.payload`. ≤ 8KB. */
  inlineJson: string;
  /** Set when the payload was off-loaded; relative path under storage root. */
  payloadRef?: string;
};

export type GuardPayloadInput = {
  agentRunId: string;
  seq: number;
  payload: Record<string, unknown>;
};

const PAYLOAD_DIR_NAME = "agent-payloads";

function buildRelativeRef(agentRunId: string, seq: number) {
  return path.posix.join(PAYLOAD_DIR_NAME, agentRunId, `${seq}.json`);
}

function resolveAbsolutePath(relRef: string) {
  return path.join(getStorageRootDir(), relRef);
}

export function guardPayload(input: GuardPayloadInput): GuardedPayload {
  const inlineJson = JSON.stringify(input.payload ?? {});
  const byteLength = Buffer.byteLength(inlineJson, "utf8");

  if (byteLength <= AGENT_EVENT_PAYLOAD_INLINE_LIMIT_BYTES) {
    return { inlineJson };
  }

  const relRef = buildRelativeRef(input.agentRunId, input.seq);
  const absPath = resolveAbsolutePath(relRef);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, inlineJson, "utf8");

  return { inlineJson: "{}", payloadRef: relRef };
}

/**
 * Resolve an off-loaded payload back into memory. Returns null if the
 * referenced file is missing.
 */
export function loadOffloadedPayload(payloadRef: string): Record<string, unknown> | null {
  const absPath = resolveAbsolutePath(payloadRef);
  if (!fs.existsSync(absPath)) return null;
  const raw = fs.readFileSync(absPath, "utf8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Remove the off-loaded directory of a finished agent run. Best-effort. */
export function purgeOffloadedPayloadsForRun(agentRunId: string): void {
  const dir = path.join(getStorageRootDir(), PAYLOAD_DIR_NAME, agentRunId);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
