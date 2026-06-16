import crypto from "crypto";

import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";

export type ToolPermissionAuditEvent =
  | "tool_permission.requested"
  | "tool_permission.auto_allowed"
  | "tool_permission.auto_denied"
  | "tool_permission.user_allowed"
  | "tool_permission.user_denied"
  | "tool_permission.blocked_for_user"
  | "tool_permission.resumed"
  | "tool_permission.rule_persisted"
  | "tool_permission.rule_updated"
  | "tool_permission.rule_deleted"
  | "tool_permission.dispatch_failed"
  | "tool_permission.control_write_failed";

export type ToolPermissionAuditInput = {
  requestId: string;
  event: ToolPermissionAuditEvent;
  runtimeEnvId: string;
  runtimeKind?: string;
  userId?: string;
  conversationId?: string;
  taskInstanceId?: string;
  taskId?: string;
  agentRunId?: string;
  daemonSessionId?: string;
  machineIdHash?: string;
  toolName?: string;
  toolInput?: unknown;
  rule?: string;
  scope?: "once" | "conversation" | "runtime" | "deny";
  decision?: "allow" | "deny";
  matchedBy?: "static_policy" | "runtime_rule" | "session_rule" | "user" | "timeout" | "system";
  blockerId?: string;
  errorCode?: string;
  errorMessage?: string;
};

const SENSITIVE_KEY_PATTERN = /(token|api[-_]?key|password|authorization|cookie|secret)/i;

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactValue(child);
    }
    return output;
  }
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  }
  return value;
}

export function summarizeToolInput(input: unknown) {
  if (input === undefined) return {};
  const raw = JSON.stringify(input);
  const toolInputHash = crypto.createHash("sha256").update(raw).digest("hex");
  const preview = JSON.stringify(redactValue(input));
  return {
    toolInputHash,
    toolInputPreview: preview.length > 1000 ? `${preview.slice(0, 1000)}...` : preview,
  };
}

export function appendToolPermissionAuditLog(input: ToolPermissionAuditInput) {
  const { toolInput, ...rest } = input;
  const payload = {
    ...rest,
    ...summarizeToolInput(toolInput),
    createdAt: new Date().toISOString(),
  };
  appendRuntimeDaemonLog(`[tool.permission.audit] ${JSON.stringify(payload)}`);
}
