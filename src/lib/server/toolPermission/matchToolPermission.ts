import { normalizeRuntimeFilePolicy } from "@/lib/runtime/toolPolicy";
import type { RuntimeEnvironment, RuntimeToolPermissionRule } from "@/types/runtime";

export type ToolPermissionMatchSource = "runtime_rule" | "session_rule" | "runtime_deny_rule" | null;

export type ToolPermissionMatch = {
  matched: boolean;
  decision?: "allow" | "deny";
  source: ToolPermissionMatchSource;
  rule?: RuntimeToolPermissionRule;
};

function matchesPattern(pattern: string, toolName: string) {
  if (pattern === toolName) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

export function suggestToolPermissionRule(toolName: string) {
  const mcpMatch = /^mcp__([^_]+)__/.exec(toolName);
  if (mcpMatch) return `mcp__${mcpMatch[1]}__*`;
  return toolName;
}

export function matchToolPermission(input: {
  runtimeEnv: Pick<RuntimeEnvironment, "filePolicy">;
  toolName: string;
  sessionRules?: RuntimeToolPermissionRule[];
}): ToolPermissionMatch {
  const filePolicy = normalizeRuntimeFilePolicy(input.runtimeEnv.filePolicy);
  const denied = filePolicy.deniedToolRules?.find((rule) => matchesPattern(rule.pattern, input.toolName));
  if (denied) return { matched: true, decision: "deny", source: "runtime_deny_rule", rule: denied };

  const allowed = filePolicy.allowedToolRules?.find((rule) => matchesPattern(rule.pattern, input.toolName));
  if (allowed) return { matched: true, decision: "allow", source: "runtime_rule", rule: allowed };

  const sessionRule = input.sessionRules?.find((rule) => matchesPattern(rule.pattern, input.toolName));
  if (sessionRule) return { matched: true, decision: "allow", source: "session_rule", rule: sessionRule };

  return { matched: false, source: null };
}
