import type {
  ClaudePromptInput,
  ClaudePromptJsonResult,
  ClaudeStreamOptions,
} from "@/lib/server/claude/transport";
import type { LocalRuntimeKind, RuntimeFilePolicy } from "@/types/runtime";

export type RuntimeCapabilities = {
  sessionResume: boolean;
  permissionModes: boolean;
  toolSelection: "allow" | "deny" | "both" | "none";
  fileArtifacts: boolean;
};

export type RuntimeDiscoveryMeta = {
  label: string;
  command: string;
  packageName?: string;
  versionArgs: string[];
  installHint: string;
  uiAccent: string;
  uiIcon: string;
};

export type RuntimeStreamOptions = ClaudeStreamOptions;
export type RuntimePromptJsonInput = ClaudePromptInput;
export type RuntimePromptTextInput = ClaudePromptInput;
export type RuntimePromptResult = ClaudePromptJsonResult;

export type RuntimeHealthCheckInput = {
  cliPath: string;
  workingDirectory: string;
  filePolicy?: RuntimeFilePolicy;
};

export type RuntimeAdapter = {
  kind: LocalRuntimeKind;
  meta: RuntimeDiscoveryMeta;
  capabilities: RuntimeCapabilities;
  streamPrompt(options: RuntimeStreamOptions): Promise<void>;
  runPromptJson(input: RuntimePromptJsonInput): Promise<RuntimePromptResult>;
  runPromptText(input: RuntimePromptTextInput): Promise<RuntimePromptResult>;
  healthCheck(input: RuntimeHealthCheckInput): Promise<{ authenticated: boolean; result: string }>;
};
