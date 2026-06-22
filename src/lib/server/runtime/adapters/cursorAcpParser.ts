import type { RuntimeStreamEvent } from "@/lib/server/claude/transport";

export type CursorAcpSessionUpdate = Record<string, unknown>;

export type CursorAcpParseState = {
  sessionEmitted: boolean;
  aggregatedText: string;
  toolCallsById: Map<string, { toolName: string; summary: string; input?: unknown }>;
  terminalPromptFinished: boolean;
  lastModelError?: string;
};

export function createCursorAcpParseState(): CursorAcpParseState {
  return {
    sessionEmitted: false,
    aggregatedText: "",
    toolCallsById: new Map(),
    terminalPromptFinished: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function mapAcpToolKind(kind: unknown) {
  if (typeof kind !== "string") return "tool";
  if (kind === "execute") return "Shell";
  if (kind === "search") return "Grep";
  return kind;
}

function extractChunkText(content: unknown) {
  const record = asRecord(content);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  return "";
}

export function parseCursorAcpSessionUpdate(input: {
  sessionId?: string;
  update: CursorAcpSessionUpdate;
  state: CursorAcpParseState;
}): RuntimeStreamEvent[] {
  const events: RuntimeStreamEvent[] = [];
  const { update, state } = input;

  if (input.sessionId && !state.sessionEmitted) {
    state.sessionEmitted = true;
    events.push({ type: "session", sessionId: input.sessionId });
  }

  const sessionUpdate = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  if (sessionUpdate === "agent_message_chunk") {
    const delta = extractChunkText(update.content);
    if (delta) {
      state.aggregatedText += delta;
      events.push({ type: "delta", text: delta });
    }
    return events;
  }

  if (sessionUpdate === "tool_call") {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    const toolName = mapAcpToolKind(update.kind);
    const title = typeof update.title === "string" ? update.title : toolName;
    const rawInput = update.rawInput;
    if (toolCallId) {
      state.toolCallsById.set(toolCallId, { toolName, summary: title, input: rawInput });
    }
    events.push({
      type: "tool_call",
      toolName,
      summary: title,
      input: rawInput,
      toolCallId,
    });
    return events;
  }

  if (sessionUpdate === "tool_call_update") {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    const status = typeof update.status === "string" ? update.status : "";
    const known = toolCallId ? state.toolCallsById.get(toolCallId) : undefined;
    if (status === "completed" || status === "failed") {
      const ok = status === "completed";
      events.push({
        type: "tool_result",
        toolName: known?.toolName,
        toolCallId,
        ok,
        summary: ok ? "完成" : "失败",
        error: ok ? undefined : typeof update.rawOutput === "string" ? update.rawOutput : "工具调用失败",
      });
    }
    return events;
  }

  return events;
}

export function markCursorAcpPromptFinished(state: CursorAcpParseState, stopReason?: string) {
  state.terminalPromptFinished = true;
  if (stopReason && stopReason !== "end_turn") {
    state.lastModelError = `Cursor ACP stopReason=${stopReason}`;
  }
}
