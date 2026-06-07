import type { RuntimeDiscoveryItem, RuntimeEnvironmentCheckInput, RuntimeEnvironmentCheckResult } from "@/types/runtime";

export type TunnelClientMessage =
  | { type: "register"; machineId: string; os?: string; daemonVersion?: string; fingerprint?: string }
  | { type: "heartbeat"; ts: string; runningJobs?: string[] }
  | { type: "event"; jobId: string; kind: string; payload: Record<string, unknown> }
  | { type: "execute_result"; jobId: string; ok: boolean; error?: string }
  | {
      type: "discover_runtimes_result";
      requestId: string;
      ok: boolean;
      items?: RuntimeDiscoveryItem[];
      workingDirectory?: string;
      error?: string;
    }
  | {
      type: "check_runtime_result";
      requestId: string;
      ok: boolean;
      result?: RuntimeEnvironmentCheckResult;
      error?: string;
    };

export type TunnelServerMessage =
  | { type: "registered"; machineId: string; userId: string }
  | { type: "execute"; jobId: string; requestId: string; payload: Record<string, unknown> }
  | { type: "cancel"; jobId: string; requestId: string }
  | { type: "pong"; ts: string }
  | { type: "discover_runtimes"; requestId: string }
  | { type: "check_runtime"; requestId: string; payload: RuntimeEnvironmentCheckInput };

export function parseTunnelMessage(raw: string): TunnelClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as TunnelClientMessage;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function serializeTunnelMessage(message: TunnelServerMessage) {
  return JSON.stringify(message);
}
