import type {
  ClaudeJsonToolPolicy,
  ClaudePromptJsonResult,
  ClaudeStreamEvent,
  ClaudeStreamOptions,
} from "@/lib/server/claude/transport";
import crypto from "crypto";
import { getCurrentUserId } from "@/lib/server/context/userContext";
import { pickOnlineMachineIdForUser } from "@/lib/server/tunnel/remoteRuntimeProxy";
import {
  consumeStreamSession,
  detachStreamConsumer,
  openStreamSession,
} from "@/lib/server/tunnel/machineStreamHub";
import { getTunnelHub } from "@/lib/server/tunnel/tunnelHub";
import type { ToolChannelPolicy } from "@/lib/runtime/toolPolicy";
import { appendToolPermissionAuditLog } from "@/lib/server/toolPermission/toolPermissionAuditLog";
import { createToolPermissionRequest, detachToolPermissionRequest } from "@/lib/server/toolPermission/toolPermissionBroker";
import type { RuntimeEnvironment, RuntimeFilePolicy, RuntimePermissionMode } from "@/types/runtime";

type PromptJsonProxyInput = {
  prompt: string;
  runtimeEnv: RuntimeEnvironment;
  cwd: string;
  conversationId?: string;
  permissionMode?: RuntimePermissionMode;
  toolPolicy?: ClaudeJsonToolPolicy;
  filePolicy?: RuntimeFilePolicy;
  channelPolicy?: ToolChannelPolicy;
  traceContext?: {
    requestId?: string;
    scope?: string;
    phase?: string;
    stepLabel?: string;
  };
};

type PromptTextProxyInput = PromptJsonProxyInput;

function resolveMachine() {
  const userId = getCurrentUserId();
  const machineId = pickOnlineMachineIdForUser(userId);
  if (!machineId) {
    throw new Error("请先连接本机电脑并保持在线，再使用本地 Runtime");
  }
  return { machineId, userId };
}

function resolveMachineId() {
  return resolveMachine().machineId;
}

function hashMachineId(machineId: string) {
  return crypto.createHash("sha256").update(machineId).digest("hex").slice(0, 16);
}

export async function proxyRunPromptJson(input: PromptJsonProxyInput): Promise<ClaudePromptJsonResult> {
  const machineId = resolveMachineId();
  return getTunnelHub().requestRunPromptJson({ machineId, payload: input });
}

export async function proxyRunPromptText(input: PromptTextProxyInput): Promise<ClaudePromptJsonResult> {
  const machineId = resolveMachineId();
  return getTunnelHub().requestRunPromptText({ machineId, payload: input });
}

export async function proxyStreamPrompt(options: ClaudeStreamOptions) {
  const { machineId, userId } = resolveMachine();
  const sessionId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const activeToolPermissionRequestIds = new Set<string>();
  openStreamSession(sessionId, {
    userId,
    conversationId: options.conversationId,
    assistantMessageId: options.assistantMessageId,
    assistantCreatedAt: options.assistantCreatedAt,
    runtimeKind: options.runtimeKind,
    startedAt: new Date().toISOString(),
  });
  try {
    getTunnelHub().sendStreamPrompt({
      machineId,
      sessionId,
      payload: {
        message: options.message,
        workingDirectory: options.workingDirectory,
        cliPath: options.cliPath,
        permissionMode: options.permissionMode,
        runtimeKind: options.runtimeKind,
        runtimeEnvId: options.runtimeEnvId,
        conversationId: options.conversationId,
        taskInstanceId: options.taskInstanceId,
        taskId: options.taskId,
        agentRunId: options.agentRunId,
        assistantMessageId: options.assistantMessageId,
        assistantCreatedAt: options.assistantCreatedAt,
        resumeSessionId: options.resumeSessionId,
        contextPack: options.contextPack,
        collectFileArtifacts: options.collectFileArtifacts,
        workspacePolicy: options.workspacePolicy,
        systemPromptMode: options.systemPromptMode,
        quotedMessage: options.quotedMessage,
        filePolicy: options.filePolicy,
        channelPolicy: options.channelPolicy,
      },
    });
    await consumeStreamSession(sessionId, (event) => {
      if (event.type === "tool_permission_request") {
        activeToolPermissionRequestIds.add(event.requestId);
        createToolPermissionRequest({
          id: event.requestId,
          runtimeEnvId: event.runtimeEnvId,
          runtimeKind: options.runtimeKind,
          conversationId: event.conversationId ?? options.conversationId,
          taskInstanceId: event.taskInstanceId ?? options.taskInstanceId,
          taskId: options.taskId,
          agentRunId: options.agentRunId,
          runId: event.runId ?? options.assistantMessageId,
          daemonSessionId: sessionId,
          machineId,
          streamSessionId: sessionId,
          machineIdHash: hashMachineId(machineId),
          toolName: event.toolName,
          toolInput: event.toolInput,
          suggestedRule: event.suggestedRule,
          createdAt: new Date().toISOString(),
        });
        appendToolPermissionAuditLog({
          requestId: event.requestId,
          event: "tool_permission.requested",
          runtimeEnvId: event.runtimeEnvId,
          runtimeKind: options.runtimeKind,
          conversationId: event.conversationId ?? options.conversationId,
          taskInstanceId: event.taskInstanceId ?? options.taskInstanceId,
          taskId: options.taskId,
          agentRunId: options.agentRunId,
          daemonSessionId: sessionId,
          machineIdHash: hashMachineId(machineId),
          toolName: event.toolName,
          toolInput: event.toolInput,
          rule: event.suggestedRule,
        });
      }
      if (event.type === "tool_permission_resolved") {
        activeToolPermissionRequestIds.delete(event.requestId);
      }
      options.onEvent(event);
    }, options.signal);
  } finally {
    for (const requestId of Array.from(activeToolPermissionRequestIds)) {
      detachToolPermissionRequest(requestId, "remote_stream_lost");
    }
    detachStreamConsumer(sessionId);
  }
}

export type StreamChunkInput = {
  sessionId: string;
  event: ClaudeStreamEvent;
};
