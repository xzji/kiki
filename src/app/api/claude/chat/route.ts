import { NextRequest } from "next/server";
import path from "path";

import { streamClaudeCli } from "@/lib/server/claudeCli";
import { createSseHeaders, writeSseEvent } from "@/lib/server/sse";
import { persistFileArtifact, toArtifactRef } from "@/lib/server/workspace/artifactStorage";
import {
  buildConversationContextPack,
  pickConversationForPrompt,
  pickGoalForPrompt,
  sanitizeConversationMessages,
} from "@/lib/server/workspace/contextPack";
import { pickTaskResultDigestsForPrompt } from "@/lib/server/workspace/taskResultDigestForPrompt";
import {
  ensureConversationWorkspace,
  getConversationContextFilePath,
  getConversationMessagesFilePath,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "@/lib/server/workspace/conversationWorkspace";
import { getCurrentUserId, runWithUserContext } from "@/lib/server/context/userContext";
import { readSessionMemoryForPrompt } from "@/lib/server/memory/conversationMemoryService";
import { shouldRunMemoryDigest } from "@/lib/server/memory/memoryDigestGate";
import { runMemoryDigest } from "@/lib/server/memory/memoryDigest";
import { readRelevantUserProfileMemoryForPrompt } from "@/lib/server/memory/userMemoryService";
import { getConversation } from "@/lib/server/repositories/conversationsRepository";
import { applyConversationCommand } from "@/lib/server/services/conversationCommandService";
import { listConversationMessages } from "@/lib/server/repositories/conversationMessagesRepository";
import type { ClaudeChatRequest, RuntimeInputAttachment } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";
import { normalizeWorkingDirectory } from "@/lib/server/runtimePath";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MEMORY_PRESSURE_PROMPT_BYTES = 96 * 1024;
const MAX_INPUT_IMAGE_COUNT = 8;
const MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_INPUT_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function normalizeInputAttachments(value: unknown): RuntimeInputAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: RuntimeInputAttachment[] = [];
  let totalBytes = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const filename = typeof record.filename === "string" ? record.filename.trim() : "";
    const mime = typeof record.mime === "string" ? record.mime.trim().toLowerCase() : "";
    const contentBase64 = typeof record.contentBase64 === "string" ? record.contentBase64.trim() : "";
    const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0;
    if (!filename || !contentBase64 || !SUPPORTED_INPUT_IMAGE_MIME.has(mime)) continue;
    totalBytes += Math.max(0, size);
    if (totalBytes > MAX_INPUT_IMAGE_BYTES) break;
    attachments.push({
      id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `attachment-${attachments.length + 1}`,
      filename,
      mime,
      size,
      contentBase64,
    });
    if (attachments.length >= MAX_INPUT_IMAGE_COUNT) break;
  }
  return attachments;
}

/**
 * 服务端单点持久化某会话在指定 runtimeKind 下的 resume session id。
 * sessionId 为 null 表示清除（如 session 失效）。写入会进入 conversation_event_log，
 * 前端通过 RuntimeEventBridge 的事件游标被动同步，避免前端双写。
 */
function persistRuntimeSession(
  userId: string,
  conversationId: string,
  runtimeKind: string,
  sessionId: string | null,
) {
  try {
    runWithUserContext(userId, () => {
      const current = getConversation(conversationId)?.conversation;
      // 幂等短路：目标值与现状一致则跳过，避免无意义的事件与 revision 抖动。
      const existing = current?.runtimeSessions?.[runtimeKind];
      if (sessionId === null ? existing === undefined : existing === sessionId) {
        return;
      }
      applyConversationCommand({
        command: { type: "set_runtime_session", conversationId, runtimeKind, sessionId },
        idempotencyKey: `conversation.runtime_session.set:${conversationId}:${runtimeKind}:${sessionId ?? "__cleared__"}:${Date.now()}`,
        producedBy: "system",
      });
    });
  } catch (error) {
    console.error("persist runtime session failed", error);
  }
}

async function POSTHandler(request: NextRequest) {
  const body = (await request.json()) as ClaudeChatRequest;
  if (!body.conversationId) {
    return new Response(JSON.stringify({ ok: false, reason: "缺少 conversationId" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const userId = getCurrentUserId();
  const runtimeKind = body.runtimeEnv.runtimeKind || "claude";
  const attachments = normalizeInputAttachments(body.attachments);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let finalAssistantText = "";
      let streamCompleted = false;
      const workspace = ensureConversationWorkspace(body.conversationId);
      try {
        let contextPack: string | undefined;
        const serverConversation = getConversation(body.conversationId)?.conversation;
        const conversation = serverConversation ?? body.contextSnapshot?.conversation;
        // SSOT：resume session 由服务端按当前 runtimeKind 从持久化状态解析，不再信任前端传入的 claudeSessionId。
        const resumeSessionId = serverConversation?.runtimeSessions?.[runtimeKind];
        if (conversation?.id === body.conversationId) {
          const dbMessages = listConversationMessages({ conversationId: body.conversationId, limit: 20 });
          const sourceMessages =
            dbMessages.length > 0 ? dbMessages : (body.contextSnapshot?.conversation.messages.slice(-20) ?? []);
          const recentMessages = sanitizeConversationMessages(sourceMessages);
          const userMemory = readRelevantUserProfileMemoryForPrompt(body.message);
          const sessionMemory = readSessionMemoryForPrompt(body.conversationId);
          const goalSnapshot = body.contextSnapshot?.goal;
          contextPack = buildConversationContextPack({
            conversation: pickConversationForPrompt(conversation),
            goal: goalSnapshot ? pickGoalForPrompt(goalSnapshot) : null,
            recentMessages,
            userMemory: userMemory.content,
            sessionMemory,
            quotedMessage: body.quotedMessage,
            taskResultDigests: goalSnapshot
              ? pickTaskResultDigestsForPrompt({ conversationId: body.conversationId, goal: goalSnapshot })
              : undefined,
          });
          writeJsonFileAtomic(getConversationMessagesFilePath(body.conversationId), recentMessages);
          writeTextFileAtomic(getConversationContextFilePath(body.conversationId), contextPack);
        }

        const cliWorkingDirectory = body.runtimeEnv.workingDirectory || workspace.workspaceDir;
        const collectFileArtifacts =
          path.resolve(normalizeWorkingDirectory(cliWorkingDirectory)) === path.resolve(workspace.workspaceDir);
        await streamClaudeCli({
          message: body.message,
          workingDirectory: cliWorkingDirectory,
          cliPath: body.runtimeEnv.cliPath,
          permissionMode: body.runtimeEnv.permissionMode,
          runtimeKind: body.runtimeEnv.runtimeKind,
          runtimeEnvId: body.runtimeEnv.id,
          filePolicy: body.runtimeEnv.filePolicy,
          resumeSessionId: resumeSessionId,
          conversationId: body.conversationId,
          assistantMessageId: body.assistantMessageId,
          assistantCreatedAt: body.assistantCreatedAt,
          collectFileArtifacts,
          quotedMessage: body.quotedMessage,
          attachments,
          contextPack,
          workspacePolicy: body.workspaceMode || "conversation",
          systemPromptMode: "conversation",
          signal: request.signal,
          onEvent: (event) => {
            if (event.type === "message") {
              finalAssistantText = event.content;
            }
            if (event.type === "status" && event.status === "completed") {
              streamCompleted = true;
            }
            // SSOT：session id 在服务端按 runtimeKind 单点持久化（事件流驱动前端被动同步，避免前端双写）。
            if (event.type === "session" && event.sessionId) {
              persistRuntimeSession(userId, body.conversationId, runtimeKind, event.sessionId);
            }
            if (event.type === "session_invalid") {
              // 失效的 session 从持久化状态清除当前 runtimeKind 的归属，打破死循环。
              persistRuntimeSession(userId, body.conversationId, runtimeKind, null);
            }
            if (event.type === "file") {
              try {
                const artifact = persistFileArtifact({
                  conversationId: body.conversationId,
                  label: event.filename,
                  summary: event.summary,
                  filename: event.filename,
                  mime: event.mime,
                  bytes: Buffer.from(event.contentBase64, "base64"),
                });
                writeSseEvent(controller, "file_artifact", {
                  type: "file_artifact",
                  ref: toArtifactRef(artifact),
                });
              } catch (error) {
                console.error("persist conversation file artifact failed", error);
              }
              return;
            }
            writeSseEvent(controller, event.type, event);
          },
        });
        const gate = shouldRunMemoryDigest({
          conversationId: body.conversationId,
          userMessage: body.message,
          assistantText: finalAssistantText,
          aborted: request.signal.aborted || !streamCompleted,
          force: Boolean(contextPack && Buffer.byteLength(contextPack, "utf8") > MEMORY_PRESSURE_PROMPT_BYTES),
        });
        if (gate.shouldRun) {
          void runWithUserContext(userId, async () => {
            try {
              await runMemoryDigest({
                conversationId: body.conversationId,
                userMessage: body.message,
                assistantText: finalAssistantText,
                runtimeEnv: body.runtimeEnv,
                cwd: cliWorkingDirectory,
                explicitMemoryIntent: gate.explicitMemoryIntent,
              });
            } catch (error) {
              console.error("memory digest failed", error);
            }
          });
        }
      } catch (error) {
        writeSseEvent(controller, "error", {
          type: "error",
          message: error instanceof Error ? error.message : "Claude 服务端桥接失败",
        });
        writeSseEvent(controller, "done", {
          type: "done",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: createSseHeaders(),
  });
}

export const POST = withAuth(POSTHandler);
