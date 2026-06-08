import { NextRequest } from "next/server";

import { streamClaudeCli } from "@/lib/server/claudeCli";
import { createSseHeaders, writeSseEvent } from "@/lib/server/sse";
import {
  buildConversationContextPack,
  sanitizeConversationMessages,
} from "@/lib/server/workspace/contextPack";
import {
  ensureConversationWorkspace,
  getConversationContextFilePath,
  getConversationMessagesFilePath,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "@/lib/server/workspace/conversationWorkspace";
import type { ConversationMessage } from "@/types/kiki";
import type { ClaudeChatRequest } from "@/types/runtime";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POSTHandler(request: NextRequest) {
  const body = (await request.json()) as ClaudeChatRequest;
  if (!body.conversationId) {
    return new Response(JSON.stringify({ ok: false, reason: "缺少 conversationId" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const workspace = ensureConversationWorkspace(body.conversationId);
        let contextPack: string | undefined;
        if (body.contextSnapshot?.conversation?.id === body.conversationId) {
          const recentMessages = sanitizeConversationMessages(
            body.contextSnapshot.conversation.messages.slice(-20) as ConversationMessage[],
          );
          contextPack = buildConversationContextPack({
            conversation: body.contextSnapshot.conversation,
            goal: body.contextSnapshot.goal ?? null,
            recentMessages,
            quotedMessage: body.quotedMessage,
          });
          writeJsonFileAtomic(getConversationMessagesFilePath(body.conversationId), recentMessages);
          writeTextFileAtomic(getConversationContextFilePath(body.conversationId), contextPack);
        }

        await streamClaudeCli({
          message: body.message,
          workingDirectory: workspace.workspaceDir,
          cliPath: body.runtimeEnv.cliPath,
          permissionMode: body.runtimeEnv.permissionMode,
          filePolicy: body.runtimeEnv.filePolicy,
          claudeSessionId: body.claudeSessionId,
          conversationId: body.conversationId,
          quotedMessage: body.quotedMessage,
          contextPack,
          workspacePolicy: body.workspaceMode || "conversation",
          signal: request.signal,
          onEvent: (event) => {
            writeSseEvent(controller, event.type, event);
          },
        });
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
