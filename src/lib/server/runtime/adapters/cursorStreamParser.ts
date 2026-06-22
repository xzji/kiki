import type { RuntimeStreamEvent } from "@/lib/server/claude/transport";

export type CursorJsonLine = Record<string, unknown>;

export type CursorStreamParseState = {
  sessionEmitted: boolean;
  aggregatedText: string;
  lastModelError?: string;
  terminalResultReceived: boolean;
  terminalIsSuccess: boolean;
};

export function createCursorStreamParseState(): CursorStreamParseState {
  return {
    sessionEmitted: false,
    aggregatedText: "",
    terminalResultReceived: false,
    terminalIsSuccess: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function extractCursorAssistantText(line: CursorJsonLine) {
  const message = asRecord(line.message);
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const record = asRecord(item);
      return typeof record?.text === "string" ? record.text : "";
    })
    .join("");
}

export function extractCursorResultText(line: CursorJsonLine) {
  return typeof line.result === "string" ? line.result : "";
}

export function parseCursorStreamLine(line: CursorJsonLine, state: CursorStreamParseState): RuntimeStreamEvent[] {
  const events: RuntimeStreamEvent[] = [];
  const type = typeof line.type === "string" ? line.type : "";
  const subtype = typeof line.subtype === "string" ? line.subtype : "";

  if (type === "system" && subtype === "init") {
    const sessionId = typeof line.session_id === "string" ? line.session_id : undefined;
    if (sessionId && !state.sessionEmitted) {
      state.sessionEmitted = true;
      events.push({ type: "session", sessionId });
    }
    return events;
  }

  if (type === "connection" || type === "retry") {
    const hint =
      type === "retry"
        ? "Cursor Agent 正在重试连接…"
        : subtype === "reconnecting"
          ? "Cursor Agent 正在重新连接…"
          : "";
    if (hint) events.push({ type: "thinking", text: hint });
    return events;
  }

  if (type === "assistant") {
    const text = extractCursorAssistantText(line);
    if (!text) return events;
    const delta = text.startsWith(state.aggregatedText) ? text.slice(state.aggregatedText.length) : text;
    if (delta) {
      state.aggregatedText = text.startsWith(state.aggregatedText) ? text : state.aggregatedText + delta;
      events.push({ type: "delta", text: delta });
    }
    return events;
  }

  if (type === "tool_call" || type === "tool_call_started") {
    const toolName = typeof line.tool_name === "string" ? line.tool_name : typeof line.name === "string" ? line.name : "tool";
    const summary = typeof line.summary === "string" ? line.summary : toolName;
    events.push({
      type: "tool_call",
      toolName,
      summary,
      input: line.input ?? line.args,
      toolCallId: typeof line.tool_call_id === "string" ? line.tool_call_id : undefined,
    });
    return events;
  }

  if (type === "tool_result" || type === "tool_call_completed") {
    const ok = line.is_error !== true && line.ok !== false;
    events.push({
      type: "tool_result",
      toolName: typeof line.tool_name === "string" ? line.tool_name : undefined,
      toolCallId: typeof line.tool_call_id === "string" ? line.tool_call_id : undefined,
      ok,
      summary: typeof line.summary === "string" ? line.summary : ok ? "完成" : "失败",
      error: typeof line.error === "string" ? line.error : undefined,
    });
    return events;
  }

  if (type === "result") {
    state.terminalResultReceived = true;
    if (subtype === "success" && line.is_error !== true) {
      state.terminalIsSuccess = true;
      const resultText = extractCursorResultText(line).trim();
      if (resultText) state.aggregatedText = resultText;
      return events;
    }
    state.terminalIsSuccess = false;
    state.lastModelError = extractCursorResultText(line).trim() || "Cursor CLI 调用失败";
    return events;
  }

  return events;
}

export function extractCursorJsonResult(stdout: string) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    try {
      const parsed = JSON.parse(line) as CursorJsonLine;
      if (parsed.type === "result") {
        if (parsed.is_error === true) {
          throw new Error(extractCursorResultText(parsed).trim() || "Cursor CLI 调用失败");
        }
        return extractCursorResultText(parsed).trim();
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      if (error instanceof Error && error.message.startsWith("Cursor CLI")) throw error;
    }
  }
  return lines.at(-1) ?? "";
}

export function extractCursorTextResult(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const fromJson = extractCursorJsonResult(stdout);
    if (fromJson.trim()) return fromJson.trim();
  } catch {
    // fall through to raw stdout
  }
  return trimmed;
}
