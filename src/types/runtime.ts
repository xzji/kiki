import type { ArtifactRef } from "@/types/artifact";

export type RuntimePermissionMode = "readonly" | "confirm" | "execute";
export type LocalRuntimeKind = "claude" | "codex" | "gemini";
export type RuntimeToolCapability =
  | "web"
  | "fileRead"
  | "fileWrite"
  | "shell"
  | "subagent"
  | "schedule"
  | "planMode";
export type RuntimeFilePolicyMode = "all_on" | "all_off" | "custom";

export type RuntimeFilePolicy = {
  mode: RuntimeFilePolicyMode;
  custom: Record<RuntimeToolCapability, boolean>;
};

export const RUNTIME_TOOL_CAPABILITIES: RuntimeToolCapability[] = [
  "web",
  "fileRead",
  "fileWrite",
  "shell",
  "subagent",
  "schedule",
  "planMode",
];

export const DEFAULT_RUNTIME_FILE_POLICY: RuntimeFilePolicy = {
  mode: "custom",
  custom: {
    web: true,
    fileRead: true,
    fileWrite: false,
    shell: false,
    subagent: false,
    schedule: false,
    planMode: false,
  },
};

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
  filePolicy?: RuntimeFilePolicy;
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
  filePolicy?: RuntimeFilePolicy;
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

export type QuotedConversationMessageContext = import("@/types/kiki").ConversationMessageQuote;

export type ClaudeChatRequest = {
  message: string;
  conversationId: string;
  runtimeEnv: RuntimeEnvironment;
  claudeSessionId?: string;
  source: "assistant-sidebar" | "conversation";
  workspaceMode?: "conversation" | "task";
  taskRef?: {
    goalId: string;
    subGoalId: string;
    taskId: string;
    instanceId: string;
  };
  contextSnapshot?: {
    conversation: import("@/types/kiki").Conversation;
    goal?: import("@/types/kiki").Goal | null;
  };
  quotedMessage?: QuotedConversationMessageContext | null;
};

export type ClaudeStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "session_invalid"; sessionId: string; message: string }
  | { type: "status"; status: "checking" | "running" | "completed" }
  | { type: "delta"; text: string }
  | { type: "message"; content: string }
  | { type: "file_artifact"; ref: ArtifactRef }
  | { type: "permission_request"; reason: string }
  | { type: "error"; message: string }
  | { type: "done" };
