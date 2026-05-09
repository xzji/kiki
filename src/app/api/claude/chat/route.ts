import { NextRequest } from "next/server";

import { streamClaudeCli } from "@/lib/server/claudeCli";
import { createSseHeaders, writeSseEvent } from "@/lib/server/sse";
import type { ClaudeChatRequest } from "@/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as ClaudeChatRequest;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await streamClaudeCli({
          message: body.message,
          workingDirectory: body.runtimeEnv.workingDirectory,
          cliPath: body.runtimeEnv.cliPath,
          permissionMode: body.runtimeEnv.permissionMode,
          claudeSessionId: body.claudeSessionId,
          quotedMessage: body.quotedMessage,
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
