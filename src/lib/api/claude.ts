import type { ClaudeChatRequest, ClaudeStreamEvent } from "@/types/runtime";

type StreamHandlers = {
  onEvent: (event: ClaudeStreamEvent) => void;
};

function parseEventType(raw: string): ClaudeStreamEvent["type"] | null {
  switch (raw) {
    case "session":
    case "session_invalid":
    case "status":
    case "delta":
    case "message":
    case "file_artifact":
    case "permission_request":
    case "error":
    case "done":
      return raw;
    default:
      return null;
  }
}

export async function streamClaudeChat(
  request: ClaudeChatRequest,
  handlers: StreamHandlers,
  options?: { signal?: AbortSignal },
) {
  const response = await fetch("/api/claude/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal: options?.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(text || "Claude 对话启动失败");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: ClaudeStreamEvent["type"] | null = null;

  const flushBlock = (block: string) => {
    const lines = block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    if (!lines.length) return;

    let eventType = currentEvent;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = parseEventType(line.slice(6).trim());
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (!eventType) return;

    const payload = dataLines.join("\n");
    const parsed = payload ? (JSON.parse(payload) as ClaudeStreamEvent) : ({ type: eventType } as ClaudeStreamEvent);
    handlers.onEvent(parsed);
    currentEvent = null;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      flushBlock(block);
      index = buffer.indexOf("\n\n");
    }

    if (done) {
      if (buffer.trim()) flushBlock(buffer);
      break;
    }
  }
}

export async function deleteClaudeSession(input: {
  sessionId: string;
  workingDirectory?: string;
}) {
  const response = await fetch("/api/claude/session/delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const data = (await response.json()) as {
    ok: boolean;
    deleted?: boolean;
    deletedCount?: number;
    reason?: string;
  };
  if (!response.ok || !data.ok) {
    throw new Error(data.reason || "删除 Claude session 失败");
  }
  return data;
}
