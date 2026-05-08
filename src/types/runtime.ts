export type RuntimePermissionMode = "readonly" | "confirm" | "execute";
export type LocalRuntimeKind = "claude" | "codex" | "gemini";

export type RuntimeHealth =
  | { status: "checking" }
  | { status: "online"; cliPath: string; claudeVersion?: string }
  | { status: "offline"; reason: string }
  | { status: "misconfigured"; reason: string };

export type RuntimeEnvironment = {
  id: string;
  type: "cloud" | "local";
  runtimeKind?: LocalRuntimeKind;
  name: string;
  workingDirectory: string;
  cliPath: string;
  permissionMode: RuntimePermissionMode;
  isDefault?: boolean;
  lastCheckedAt?: string;
  health?: RuntimeHealth;
};

export type RuntimeEnvironmentCheckInput = {
  name: string;
  runtimeKind?: LocalRuntimeKind;
  workingDirectory: string;
  cliPath: string;
  permissionMode: RuntimePermissionMode;
};

export type RuntimeEnvironmentCheckResult = {
  ok: boolean;
  runtimeKind?: LocalRuntimeKind;
  cliPath: string;
  workingDirectoryExists: boolean;
  authenticated: boolean;
  version?: string;
  reason?: string;
};

export type RuntimeDiscoveryItem = {
  runtimeKind: LocalRuntimeKind;
  label: string;
  command: string;
  cliPath?: string;
  installed: boolean;
  version?: string;
  installHint?: string;
};

export type RuntimeDiscoveryResult = {
  items: RuntimeDiscoveryItem[];
  workingDirectory: string;
};

export type ClaudeChatRequest = {
  message: string;
  conversationId?: string;
  runtimeEnv: RuntimeEnvironment;
  claudeSessionId?: string;
  source: "assistant-sidebar" | "conversation";
  quotedMessage?: {
    roleLabel: string;
    content: string;
  } | null;
};

export type ClaudeStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "status"; status: "checking" | "running" | "completed" }
  | { type: "delta"; text: string }
  | { type: "message"; content: string }
  | { type: "permission_request"; reason: string }
  | { type: "error"; message: string }
  | { type: "done" };
