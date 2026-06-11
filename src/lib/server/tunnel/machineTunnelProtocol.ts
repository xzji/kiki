import type { ClaudeStreamEvent } from "@/lib/server/claude/transport";
import type { MachineCommand, MachineResult } from "@/lib/server/tunnel/tunnelHub";

export const MACHINE_TUNNEL_WS_PATH = "/api/machine-tunnel/ws";

export type MachineTunnelHello = {
  kind: "hello";
  daemonVersion: string;
  fingerprint: string;
  capabilities: string[];
  runningJobIds: string[];
  activeStreamSessionIds: string[];
};

export type MachineTunnelHelloAck = {
  kind: "hello_ack";
  machineId: string;
  userId: string;
};

export type MachineTunnelCommandEnvelope = {
  kind: "command";
  command: MachineCommand;
};

export type MachineTunnelResultEnvelope = {
  kind: "result";
  result: MachineResult;
};

export type MachineTunnelStreamEnvelope = {
  kind: "stream";
  sessionId: string;
  event: ClaudeStreamEvent;
  seq?: number;
};

export type MachineTunnelPingEnvelope = {
  kind: "ping";
  nonce?: string;
};

export type MachineTunnelPongEnvelope = {
  kind: "pong";
  nonce?: string;
};

export type MachineTunnelEnvelope =
  | MachineTunnelHello
  | MachineTunnelHelloAck
  | MachineTunnelCommandEnvelope
  | MachineTunnelResultEnvelope
  | MachineTunnelStreamEnvelope
  | MachineTunnelPingEnvelope
  | MachineTunnelPongEnvelope;

export function isMachineTunnelEnvelope(value: unknown): value is MachineTunnelEnvelope {
  return Boolean(value && typeof value === "object" && "kind" in value && typeof (value as { kind?: unknown }).kind === "string");
}
