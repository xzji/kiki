import type { ArtifactRef } from "@/types/artifact";

export type RuntimePermissionMode = "readonly" | "confirm" | "execute";
export type LocalRuntimeKind = "claude" | "codex" | "gemini" | "pi";
export const SUPPORTED_RUNTIME_KINDS: LocalRuntimeKind[] = ["claude", "pi"];
export type RuntimeToolCapability =
  | "web"
  | "fileRead"
  | "fileWrite"
  | "shell"
  | "subagent"
  | "schedule"
  | "planMode";
export type RuntimeFilePolicyMode = "all_on" | "all_off" | "custom";

export type RuntimeToolPermissionRule = {
  id: string;
  pattern: string;
  label?: string;
  source: "user";
  createdAt: string;
  updatedAt?: string;
};

export type RuntimeFilePolicy = {
  mode: RuntimeFilePolicyMode;
  custom: Record<RuntimeToolCapability, boolean>;
  allowedToolRules?: RuntimeToolPermissionRule[];
  deniedToolRules?: RuntimeToolPermissionRule[];
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
    fileWrite: true,
    shell: true,
    subagent: false,
    schedule: false,
    planMode: false,
  },
  allowedToolRules: [],
  deniedToolRules: [],
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
  uiAccent?: string;
  uiIcon?: string;
};

export type RuntimeDiscoveryResult = {
  items: RuntimeDiscoveryItem[];
  workingDirectory: string;
};

export type QuotedConversationMessageContext = import("@/types/kiki").ConversationMessageQuote;

export type CliPromptSection = {
  id: string;
  kind: "system" | "context" | "user" | "tool_policy" | "other";
  title: string;
  content: string;
};

export type CliProcessEvent = {
  id: string;
  type: "prompt" | "thinking" | "assistant_trace" | "tool_call" | "subagent_event" | "output" | "status" | "error" | "file_artifact";
  createdAt: string;
  title?: string;
  content?: string;
  toolName?: string;
  summary?: string;
  input?: unknown;
  agentId?: string;
  eventKind?: "thinking" | "tool_call" | "tool_result" | "completed";
};

export type CliProcessEventInput = Omit<CliProcessEvent, "id" | "createdAt"> & {
  promptSection?: CliPromptSection;
  outputDelta?: string;
};

export type ConversationCliProcess = {
  runId: string;
  status: "running" | "completed" | "error" | "aborted";
  startedAt: string;
  finishedAt?: string;
  promptSections: CliPromptSection[];
  events: CliProcessEvent[];
  output: string;
  error?: string;
};

export type ClaudeChatRequest = {
  message: string;
  conversationId: string;
  assistantMessageId?: string;
  assistantCreatedAt?: string;
  runtimeEnv: RuntimeEnvironment;
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
  | { type: "prompt"; sections: CliPromptSection[] }
  | { type: "thinking"; text: string }
  | { type: "assistant_trace"; text: string }
  | { type: "delta"; text: string }
  | { type: "message"; content: string }
  | { type: "tool_call"; toolName: string; summary: string; input?: unknown; index?: number }
  | {
      type: "subagent_event";
      agentId: string;
      eventKind: "thinking" | "tool_call" | "tool_result" | "completed";
      title: string;
      summary?: string;
      content?: string;
      input?: unknown;
      createdAt?: string;
    }
  | { type: "file_artifact"; ref: ArtifactRef }
  | { type: "permission_request"; reason: string }
  | {
      type: "tool_permission_request";
      requestId: string;
      runtimeEnvId: string;
      toolName: string;
      suggestedRule: string;
      toolInput?: unknown;
      conversationId?: string;
      taskInstanceId?: string;
      runId?: string;
    }
  | {
      type: "tool_permission_resolved";
      requestId: string;
      decision: "allow" | "deny";
      scope: "once" | "conversation" | "runtime" | "deny";
      rule?: string;
    }
  | { type: "error"; message: string }
  | { type: "done" };
