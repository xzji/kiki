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

export type RuntimeDaemonStatusPayload = {
  config: RuntimeDaemonConfig | null;
  state: RuntimeDaemonState | null;
  device: RuntimeDaemonDeviceState | null;
  source?: "local" | "remote";
  service?: RuntimeDaemonServiceStatus;
  message?: string;
  launchAgentInstalled: boolean;
  launchAgentPath: string;
};

export type RuntimeDaemonServiceStatus = {
  platform: string;
  kind: "launchd" | "systemd" | "unsupported";
  installed: boolean;
  running: boolean;
  path: string;
};

export type RuntimeDaemonInstallPayload = {
  ok: boolean;
  source?: "local" | "remote";
  service?: RuntimeDaemonServiceStatus;
  launchAgentInstalled: boolean;
  launchAgentPath: string;
  message?: string;
};

export type RuntimeDaemonAutostartPayload = RuntimeDaemonInstallPayload & {
  config: RuntimeDaemonConfig | null;
};

export type LocalDataResetPayload = {
  ok: boolean;
  message?: string;
  result?: {
    ok: boolean;
    stoppedProcesses: Array<{
      pid: number;
      command: string;
      signal: "SIGTERM" | "SIGKILL" | "skipped";
    }>;
    deletedPaths: string[];
    preservedPaths: string[];
    warnings: string[];
  };
};

export async function fetchRuntimeStateSnapshot(): Promise<RuntimeStatePayload> {
  const response = await fetch("/api/runtime/state", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("本地运行时状态获取失败");
  }
  return (await response.json()) as RuntimeStatePayload;
}

export type ThreadRunnerActivity = {
  threadId: string;
  topicId: string | null;
  runningCount: number;
  pendingCount: number;
  failedCount: number;
  completedCount: number;
  totalCount: number;
  latestStartedAt: string;
  latestFinishedAt: string | null;
};

export type SagaActivity = {
  id: string;
  topicId: string;
  type: "topic_init" | "thread_loop";
  status: "pending" | "running" | "awaiting_user" | "completed" | "failed";
  currentStep?: string;
  startedAt: string;
  finishedAt?: string;
};

export type RuntimeJobActivity = {
  jobId: string;
  taskInstanceId: string;
  taskId: string | null;
  goalId: string | null;
  status: "queued" | "running" | "awaiting_user" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type RuntimeActivityPayload = {
  ok: boolean;
  threadRunners: ThreadRunnerActivity[];
  sagas: SagaActivity[];
  jobs: RuntimeJobActivity[];
};

export async function fetchRuntimeActivity(): Promise<RuntimeActivityPayload> {
  const response = await fetch("/api/runtime/activity", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("运行时执行活动获取失败");
  }
  return (await response.json()) as RuntimeActivityPayload;
}

export type GovernanceTickEntry = {
  id: string;
  occurredAt: string;
  kind: string;
  phase: "completed" | "failed" | "dispatch_partial_failure" | "paused" | "unknown";
  dispatchedTaskCount: number;
  updatedTaskCount: number;
  cancelledTaskCount: number;
  sentMessageCount: number;
  silentCount: number;
  failureCount?: number;
  failureReason?: string;
  errorKind?: string;
  assessment?: string;
  confidence?: number | string;
  paused: boolean;
};

export type GovernanceHistoryPayload = {
  ok: boolean;
  entries: GovernanceTickEntry[];
  reason?: string;
};

export async function fetchGovernanceHistory(input: {
  kind: "thread" | "topic";
  entityId: string;
  limit?: number;
}): Promise<GovernanceHistoryPayload> {
  const params = new URLSearchParams({
    kind: input.kind,
    entityId: input.entityId,
  });
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  const response = await fetch(`/api/runtime/governance-history?${params.toString()}`, { cache: "no-store" });
  const payload = (await response.json()) as GovernanceHistoryPayload;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.reason || "治理历史获取失败");
  }
  return payload;
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
    filePolicy?: RuntimeEnvironment["filePolicy"];
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

export async function setRuntimeDaemonMaxConcurrentTasks(
  maxConcurrentTasks: number,
): Promise<RuntimeDaemonConfig | null> {
  const response = await fetch("/api/runtime/daemon/concurrency", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ maxConcurrentTasks }),
  });
  const payload = (await response.json()) as { ok: boolean; message?: string; config: RuntimeDaemonConfig | null };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || "并发上限设置失败");
  }
  return payload.config;
}

export async function resetLocalDevData(): Promise<LocalDataResetPayload> {
  const response = await fetch("/api/dev/runtime/reset-local-data", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });
  const payload = (await response.json()) as LocalDataResetPayload;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || "清空本地测试数据失败");
  }
  return payload;
}
