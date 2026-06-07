export type TunnelClientMessage =
  | { type: "register"; machineId: string; os?: string; daemonVersion?: string; fingerprint?: string }
  | { type: "heartbeat"; ts: string; runningJobs?: string[] }
  | { type: "event"; jobId: string; kind: string; payload: Record<string, unknown> }
  | { type: "execute_result"; jobId: string; ok: boolean; error?: string };

export type TunnelServerMessage =
  | { type: "registered"; machineId: string; userId: string }
  | { type: "execute"; jobId: string; requestId: string; payload: Record<string, unknown> }
  | { type: "cancel"; jobId: string; requestId: string }
  | { type: "pong"; ts: string };

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
