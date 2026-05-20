import type { Goal } from "@/types/kiki";
import type { AgentEvent } from "@/types/schedule";
import type { RuntimeEnvironment } from "@/types/runtime";
import type { RuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import type { RuntimeDaemonDeviceState, RuntimeDaemonState } from "@/lib/daemon/daemonState";

export type RuntimeStatePayload = {
  goals: Goal[];
  runtimeEnvironments: RuntimeEnvironment[];
  scheduleEvents: AgentEvent[];
  meta?: {
    revisions?: RuntimeStateRevision;
    updatedAt?: Partial<Record<keyof RuntimeStateRevision, string>>;
  };
};

export type RuntimeStateRevision = {
  goals: number;
  runtimeEnvironments: number;
  scheduleEvents: number;
};

export type RuntimeStateSyncResponse = {
  ok: boolean;
  results?: Partial<Record<keyof RuntimeStateRevision, { ok: boolean; revision: number; updatedAt: string } | null>>;
};

export type RuntimeDaemonStatusPayload = {
  config: RuntimeDaemonConfig | null;
  state: RuntimeDaemonState | null;
  device: RuntimeDaemonDeviceState | null;
  launchAgentInstalled: boolean;
  launchAgentPath: string;
};

export type RuntimeDaemonInstallPayload = {
  ok: boolean;
  launchAgentInstalled: boolean;
  launchAgentPath: string;
  message?: string;
};

export type RuntimeDaemonAutostartPayload = RuntimeDaemonInstallPayload & {
  config: RuntimeDaemonConfig | null;
};

export async function syncRuntimeStateSnapshot(input: Partial<RuntimeStatePayload> & { baseRevision?: Partial<RuntimeStateRevision> }) {
  const response = await fetch("/api/runtime/state/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(response.status === 409 ? "runtime state snapshot 已更新" : "本地运行时状态同步失败");
  }
  return (await response.json()) as RuntimeStateSyncResponse;
}

export async function fetchRuntimeStateSnapshot(): Promise<RuntimeStatePayload> {
  const response = await fetch("/api/runtime/state", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("本地运行时状态获取失败");
  }
  return (await response.json()) as RuntimeStatePayload;
}

export async function fetchRuntimeDaemonStatus(): Promise<RuntimeDaemonStatusPayload> {
  const response = await fetch("/api/runtime/daemon/status", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("本地 Runtime Daemon 状态获取失败");
  }
  return (await response.json()) as RuntimeDaemonStatusPayload;
}

export async function installRuntimeDaemonLaunchAgent(): Promise<RuntimeDaemonInstallPayload> {
  const response = await fetch("/api/runtime/daemon/install", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });
  const payload = (await response.json()) as RuntimeDaemonInstallPayload;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || "LaunchAgent 安装失败");
  }
  return payload;
}

export async function setRuntimeDaemonAutoStart(input: {
  enabled: boolean;
  environment?: {
    name: string;
    workingDirectory: string;
    cliPath: string;
    permissionMode: RuntimeEnvironment["permissionMode"];
  };
}): Promise<RuntimeDaemonAutostartPayload> {
  const response = await fetch("/api/runtime/daemon/autostart", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = (await response.json()) as RuntimeDaemonAutostartPayload;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || "24h 运行设置失败");
  }
  return payload;
}
