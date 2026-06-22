import crypto from "crypto";

import type { RuntimeStreamEvent } from "@/lib/server/claude/transport";
import { mapCursorToolNameForPermission } from "@/lib/server/runtime/adapters/cursorToolPolicy";
import type { CursorAcpJsonRpcMessage } from "@/lib/server/runtime/adapters/cursorAcpClient";
import { appendToolPermissionAuditLog } from "@/lib/server/toolPermission/toolPermissionAuditLog";
import { matchToolPermission, suggestToolPermissionRule } from "@/lib/server/toolPermission/matchToolPermission";
import {
  createToolPermissionRequest,
  detachToolPermissionRequest,
  waitForToolPermissionDecision,
} from "@/lib/server/toolPermission/toolPermissionBroker";
import { getSessionToolPermissionRules, getToolPermissionSessionKey } from "@/lib/server/toolPermission/sessionToolPermissionStore";
import type { RuntimeFilePolicy, RuntimePermissionMode } from "@/types/runtime";

type CursorAcpPermissionOption = {
  optionId?: string;
  kind?: string;
};

type CursorAcpPermissionParams = {
  sessionId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    status?: string;
  };
  options?: CursorAcpPermissionOption[];
};

export function extractCursorAcpPermissionToolName(toolCall: CursorAcpPermissionParams["toolCall"]) {
  const kind = typeof toolCall?.kind === "string" ? toolCall.kind.trim() : "";
  if (kind) {
    if (kind === "execute") return mapCursorToolNameForPermission("Shell");
    if (kind === "search") return mapCursorToolNameForPermission("Grep");
    return mapCursorToolNameForPermission(kind);
  }
  const title = typeof toolCall?.title === "string" ? toolCall.title.trim() : "";
  if (title) {
    return mapCursorToolNameForPermission(title.split(":")[0]?.trim() || title);
  }
  return "tool";
}

function pickOptionId(options: CursorAcpPermissionOption[] | undefined, preferred: string[]) {
  if (!options?.length) return preferred[0] ?? "reject-once";
  for (const candidate of preferred) {
    const match = options.find((option) => option.optionId === candidate);
    if (match?.optionId) return match.optionId;
  }
  return options[0]?.optionId ?? preferred[0] ?? "reject-once";
}

export function mapDecisionToAcpOptionId(
  decision: "allow" | "deny",
  scope: "once" | "conversation" | "runtime" | "deny",
  options?: CursorAcpPermissionOption[],
) {
  if (decision === "deny") {
    return pickOptionId(options, ["reject-once", "reject_always", "reject-always", "deny"]);
  }
  if (scope === "runtime" || scope === "conversation") {
    return pickOptionId(options, ["allow-always", "allow_always", "allow"]);
  }
  return pickOptionId(options, ["allow-once", "allow_once", "allow"]);
}

function extractPermissionParams(message: CursorAcpJsonRpcMessage) {
  return (message.params ?? {}) as CursorAcpPermissionParams;
}

export async function resolveCursorAcpPermissionRequest(input: {
  message: CursorAcpJsonRpcMessage;
  permissionMode: RuntimePermissionMode;
  runtimeEnvId?: string;
  filePolicy?: RuntimeFilePolicy;
  conversationId?: string;
  taskInstanceId?: string;
  taskId?: string;
  agentRunId?: string;
  assistantMessageId?: string;
  headless?: boolean;
  emitEvent: (event: RuntimeStreamEvent) => boolean;
  onRequestCreated?: (requestId: string) => void;
  aborted?: () => boolean;
}): Promise<{ outcome: "selected"; optionId: string } | { outcome: "cancelled" }> {
  const params = extractPermissionParams(input.message);
  const toolCall = params.toolCall ?? {};
  const toolName = extractCursorAcpPermissionToolName(toolCall);
  const toolInput = toolCall.rawInput;
  const options = params.options;

  if (input.aborted?.()) {
    return { outcome: "cancelled" };
  }

  if (input.permissionMode === "readonly") {
    return { outcome: "selected", optionId: mapDecisionToAcpOptionId("deny", "deny", options) };
  }

  if (!input.runtimeEnvId) {
    return { outcome: "selected", optionId: mapDecisionToAcpOptionId("deny", "deny", options) };
  }

  const sessionKey = getToolPermissionSessionKey({
    conversationId: input.conversationId,
    taskInstanceId: input.taskInstanceId,
    runtimeEnvId: input.runtimeEnvId,
  });
  const match = matchToolPermission({
    runtimeEnv: { filePolicy: input.filePolicy },
    toolName,
    sessionRules: getSessionToolPermissionRules(sessionKey),
  });

  if (match.matched && match.decision === "deny") {
    appendToolPermissionAuditLog({
      requestId: `cursor-acp-deny-${crypto.randomUUID()}`,
      event: "tool_permission.auto_denied",
      runtimeEnvId: input.runtimeEnvId,
      runtimeKind: "cursor",
      conversationId: input.conversationId,
      taskInstanceId: input.taskInstanceId,
      taskId: input.taskId,
      agentRunId: input.agentRunId,
      toolName,
      toolInput,
      rule: match.rule?.pattern,
      scope: "runtime",
      decision: "deny",
      matchedBy: "runtime_rule",
    });
    return { outcome: "selected", optionId: mapDecisionToAcpOptionId("deny", "deny", options) };
  }

  if (match.matched && match.decision === "allow") {
    appendToolPermissionAuditLog({
      requestId: `cursor-acp-allow-${crypto.randomUUID()}`,
      event: "tool_permission.auto_allowed",
      runtimeEnvId: input.runtimeEnvId,
      runtimeKind: "cursor",
      conversationId: input.conversationId,
      taskInstanceId: input.taskInstanceId,
      taskId: input.taskId,
      agentRunId: input.agentRunId,
      toolName,
      toolInput,
      rule: match.rule?.pattern,
      scope: "runtime",
      decision: "allow",
      matchedBy: match.source === "session_rule" ? "session_rule" : "runtime_rule",
    });
    return {
      outcome: "selected",
      optionId: mapDecisionToAcpOptionId("allow", input.permissionMode === "execute" ? "runtime" : "once", options),
    };
  }

  if (input.permissionMode === "execute") {
    return { outcome: "selected", optionId: mapDecisionToAcpOptionId("allow", "once", options) };
  }

  if (input.headless) {
    appendToolPermissionAuditLog({
      requestId: `cursor-acp-headless-deny-${crypto.randomUUID()}`,
      event: "tool_permission.auto_denied",
      runtimeEnvId: input.runtimeEnvId,
      runtimeKind: "cursor",
      conversationId: input.conversationId,
      taskInstanceId: input.taskInstanceId,
      taskId: input.taskId,
      agentRunId: input.agentRunId,
      toolName,
      toolInput,
      scope: "runtime",
      decision: "deny",
      matchedBy: "system",
    });
    return { outcome: "selected", optionId: mapDecisionToAcpOptionId("deny", "deny", options) };
  }

  const requestId = crypto.randomUUID();
  const suggestedRule = suggestToolPermissionRule(toolName);
  const toolPermissionRequest = {
    id: requestId,
    runtimeEnvId: input.runtimeEnvId,
    runtimeKind: "cursor" as const,
    conversationId: input.conversationId,
    taskInstanceId: input.taskInstanceId,
    taskId: input.taskId,
    agentRunId: input.agentRunId,
    runId: input.assistantMessageId,
    toolName,
    toolInput,
    suggestedRule,
    createdAt: new Date().toISOString(),
  };

  createToolPermissionRequest(toolPermissionRequest);
  input.onRequestCreated?.(requestId);
  appendToolPermissionAuditLog({
    requestId,
    event: "tool_permission.requested",
    runtimeEnvId: input.runtimeEnvId,
    runtimeKind: "cursor",
    conversationId: input.conversationId,
    taskInstanceId: input.taskInstanceId,
    taskId: input.taskId,
    agentRunId: input.agentRunId,
    toolName,
    toolInput,
    rule: suggestedRule,
  });

  if (
    !input.emitEvent({
      type: "tool_permission_request",
      requestId,
      runtimeEnvId: input.runtimeEnvId,
      toolName,
      suggestedRule,
      toolInput,
      conversationId: input.conversationId,
      taskInstanceId: input.taskInstanceId,
      runId: input.assistantMessageId,
    })
  ) {
    detachToolPermissionRequest(requestId, "emitter_closed");
    return { outcome: "cancelled" };
  }

  try {
    const decision = await waitForToolPermissionDecision(toolPermissionRequest);
    if (decision.detached || input.aborted?.()) {
      return { outcome: "cancelled" };
    }
    input.emitEvent({
      type: "tool_permission_resolved",
      requestId,
      decision: decision.decision,
      scope: decision.scope,
      rule: decision.rule,
    });
    return {
      outcome: "selected",
      optionId: mapDecisionToAcpOptionId(decision.decision, decision.scope, options),
    };
  } catch {
    detachToolPermissionRequest(requestId, "cursor_acp_permission_failed");
    return { outcome: "cancelled" };
  }
}
