export type ToolPermissionScope = "once" | "conversation" | "runtime" | "deny";

export type ToolPermissionDecision = {
  requestId: string;
  decision: "allow" | "deny";
  scope: ToolPermissionScope;
  rule?: string;
  detached?: boolean;
};

export type ToolPermissionRequest = {
  id: string;
  runtimeEnvId: string;
  runtimeKind?: string;
  conversationId?: string;
  taskInstanceId?: string;
  taskId?: string;
  agentRunId?: string;
  runId?: string;
  daemonSessionId?: string;
  machineId?: string;
  streamSessionId?: string;
  machineIdHash?: string;
  toolName: string;
  toolInput?: unknown;
  suggestedRule: string;
  createdAt: string;
  detachedAt?: string;
  detachedReason?: string;
};
