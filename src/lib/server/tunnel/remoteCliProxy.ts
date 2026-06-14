import type {
  ClaudeJsonToolPolicy,
  ClaudePromptJsonResult,
  ClaudeStreamEvent,
  ClaudeStreamOptions,
} from "@/lib/server/claude/transport";
import { getCurrentUserId } from "@/lib/server/context/userContext";
import { pickOnlineMachineIdForUser } from "@/lib/server/tunnel/remoteRuntimeProxy";
import {
  consumeStreamSession,
  detachStreamConsumer,
  openStreamSession,
} from "@/lib/server/tunnel/machineStreamHub";
import { getTunnelHub } from "@/lib/server/tunnel/tunnelHub";
import type { ToolChannelPolicy } from "@/lib/runtime/toolPolicy";
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
        conversationId: options.conversationId,
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
    await consumeStreamSession(sessionId, (event) => options.onEvent(event), options.signal);
  } finally {
    detachStreamConsumer(sessionId);
  }
}

export type StreamChunkInput = {
  sessionId: string;
  event: ClaudeStreamEvent;
};
