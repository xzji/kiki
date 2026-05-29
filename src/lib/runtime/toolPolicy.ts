import {
  DEFAULT_RUNTIME_FILE_POLICY,
  RUNTIME_TOOL_CAPABILITIES,
  type RuntimeFilePolicy,
  type RuntimeFilePolicyMode,
  type RuntimePermissionMode,
  type RuntimeToolCapability,
} from "@/types/runtime";

export type ToolChannelPolicyMode = "inherit" | "conversation" | "task" | "readonly_json";

export type ToolChannelPolicy = {
  mode?: ToolChannelPolicyMode;
  allow?: string[];
  disallow?: string[];
};

export type ResolvedToolPolicy = {
  allowedTools: string[];
  disallowedTools: string[];
  enabledCapabilities: RuntimeToolCapability[];
  disabledCapabilities: RuntimeToolCapability[];
};

export const TOOL_CAPABILITY_MAP: Record<RuntimeToolCapability, string[]> = {
  web: ["WebFetch", "WebSearch"],
  fileRead: ["Read", "Glob", "Grep"],
  fileWrite: ["Write", "Edit", "NotebookEdit"],
  shell: ["Bash"],
  subagent: ["Task", "TaskOutput", "TaskStop", "Skill"],
  schedule: ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"],
  planMode: ["EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree"],
};

export const ALWAYS_ALLOWED_TOOLS = ["AskUserQuestion", "TodoWrite"];

export const RUNTIME_MANAGED_TOOLS = Array.from(
  new Set([...Object.values(TOOL_CAPABILITY_MAP).flat(), ...ALWAYS_ALLOWED_TOOLS, "MultiEdit"]),
);

const JSON_CHANNEL_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Task",
  "TaskOutput",
  "TaskStop",
  "Skill",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
];

function isPolicyMode(value: unknown): value is RuntimeFilePolicyMode {
  return value === "all_on" || value === "all_off" || value === "custom";
}

function isCapability(value: string): value is RuntimeToolCapability {
  return (RUNTIME_TOOL_CAPABILITIES as string[]).includes(value);
}

export function normalizeRuntimeFilePolicy(input?: RuntimeFilePolicy | null): RuntimeFilePolicy {
  const mode = isPolicyMode(input?.mode) ? input.mode : DEFAULT_RUNTIME_FILE_POLICY.mode;
  const custom = { ...DEFAULT_RUNTIME_FILE_POLICY.custom };
  const inputCustom = input?.custom && typeof input.custom === "object" ? input.custom : null;
  if (inputCustom) {
    for (const [key, value] of Object.entries(inputCustom)) {
      if (isCapability(key)) custom[key] = Boolean(value);
    }
  }
  return { mode, custom };
}

function resolveCapabilities(policy: RuntimeFilePolicy) {
  const normalized = normalizeRuntimeFilePolicy(policy);
  const enabled = new Set<RuntimeToolCapability>();

  for (const capability of RUNTIME_TOOL_CAPABILITIES) {
    if (normalized.mode === "all_on") {
      enabled.add(capability);
      continue;
    }
    if (normalized.mode === "custom" && normalized.custom[capability]) {
      enabled.add(capability);
    }
  }

  return enabled;
}

function sortTools(tools: Iterable<string>) {
  return Array.from(new Set(tools)).sort((a, b) => a.localeCompare(b));
}

function applyPermissionModeConstraints(
  enabledCapabilities: Set<RuntimeToolCapability>,
  permissionMode: RuntimePermissionMode,
) {
  const next = new Set(enabledCapabilities);
  if (permissionMode === "readonly") {
    next.delete("fileWrite");
    next.delete("shell");
  }
  if (permissionMode !== "execute") {
    next.delete("shell");
  }
  return next;
}

export function resolveRuntimeToolPolicy(input: {
  filePolicy?: RuntimeFilePolicy | null;
  permissionMode: RuntimePermissionMode;
  channelPolicy?: ToolChannelPolicy;
}): ResolvedToolPolicy {
  const normalized = normalizeRuntimeFilePolicy(input.filePolicy);
  const runtimeCapabilities = applyPermissionModeConstraints(
    resolveCapabilities(normalized),
    input.permissionMode,
  );
  const enabledCapabilities = RUNTIME_TOOL_CAPABILITIES.filter((capability) =>
    runtimeCapabilities.has(capability),
  );
  const disabledCapabilities = RUNTIME_TOOL_CAPABILITIES.filter(
    (capability) => !runtimeCapabilities.has(capability),
  );

  const allowed = new Set<string>(ALWAYS_ALLOWED_TOOLS);
  for (const capability of enabledCapabilities) {
    for (const tool of TOOL_CAPABILITY_MAP[capability]) {
      allowed.add(tool);
    }
  }

  const channelDisallowed = new Set<string>(input.channelPolicy?.disallow ?? []);
  if (input.channelPolicy?.mode === "readonly_json") {
    for (const tool of JSON_CHANNEL_DISALLOWED_TOOLS) {
      channelDisallowed.add(tool);
    }
  }
  for (const tool of Array.from(channelDisallowed)) {
    allowed.delete(tool);
  }
  const channelAllowed = input.channelPolicy?.allow?.length
    ? new Set(input.channelPolicy.allow)
    : null;
  if (channelAllowed) {
    for (const tool of Array.from(allowed)) {
      if (ALWAYS_ALLOWED_TOOLS.includes(tool)) continue;
      if (!channelAllowed.has(tool)) allowed.delete(tool);
    }
  }

  const disallowed = new Set<string>(RUNTIME_MANAGED_TOOLS);
  for (const tool of Array.from(allowed)) {
    disallowed.delete(tool);
  }
  for (const tool of Array.from(channelDisallowed)) {
    disallowed.add(tool);
  }

  return {
    allowedTools: sortTools(allowed),
    disallowedTools: sortTools(disallowed),
    enabledCapabilities,
    disabledCapabilities,
  };
}

export function describeRuntimeToolPolicy(policy: ResolvedToolPolicy) {
  const labels: Record<RuntimeToolCapability, string> = {
    web: "联网",
    fileRead: "读取文件",
    fileWrite: "写入文件",
    shell: "终端命令",
    subagent: "子代理",
    schedule: "定时任务",
    planMode: "Plan Mode",
  };
  return {
    allowed: policy.enabledCapabilities.map((capability) => labels[capability]),
    disabled: policy.disabledCapabilities.map((capability) => labels[capability]),
  };
}
