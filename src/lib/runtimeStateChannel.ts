"use client";

export const RUNTIME_STATE_CHANNEL = "kiki.runtime-state.v1";

export type RuntimeStateChannelKind = "runtimeEnvironments" | "scheduleEvents";

export type RuntimeStateChannelMessage = {
  kind: RuntimeStateChannelKind;
  revision: number;
  updatedAt: string;
};

export function isRuntimeStateChannelMessage(value: unknown): value is RuntimeStateChannelMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<RuntimeStateChannelMessage>;
  return (
    (message.kind === "runtimeEnvironments" || message.kind === "scheduleEvents") &&
    typeof message.revision === "number" &&
    typeof message.updatedAt === "string"
  );
}

export function publishRuntimeStateChange(message: RuntimeStateChannelMessage) {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return;
  const channel = new BroadcastChannel(RUNTIME_STATE_CHANNEL);
  try {
    channel.postMessage(message);
  } finally {
    channel.close();
  }
}
