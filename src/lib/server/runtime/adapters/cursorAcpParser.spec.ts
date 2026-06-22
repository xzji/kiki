import assert from "node:assert/strict";

import {
  createCursorAcpParseState,
  markCursorAcpPromptFinished,
  parseCursorAcpSessionUpdate,
} from "@/lib/server/runtime/adapters/cursorAcpParser";
import { mapPermissionModeToAcpMode } from "@/lib/server/runtime/adapters/cursorAcpClient";

export function runCursorAcpParserSpecs() {
  assert.equal(mapPermissionModeToAcpMode("readonly"), "ask");
  assert.equal(mapPermissionModeToAcpMode("confirm"), "agent");
  assert.equal(mapPermissionModeToAcpMode("execute"), "agent");

  const state = createCursorAcpParseState();
  const sessionEvents = parseCursorAcpSessionUpdate({
    sessionId: "sess-1",
    update: { sessionUpdate: "session_info_update", title: "Hello" },
    state,
  });
  assert.equal(sessionEvents.length, 1);
  assert.equal(sessionEvents[0]?.type, "session");

  const chunkEvents = parseCursorAcpSessionUpdate({
    sessionId: "sess-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    },
    state,
  });
  assert.equal(chunkEvents[0]?.type, "delta");
  assert.equal(state.aggregatedText, "hello");

  parseCursorAcpSessionUpdate({
    sessionId: "sess-1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "grep",
      kind: "search",
      status: "pending",
      rawInput: { pattern: "foo" },
    },
    state,
  });
  const toolDone = parseCursorAcpSessionUpdate({
    sessionId: "sess-1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { totalMatches: 1 },
    },
    state,
  });
  assert.equal(toolDone[0]?.type, "tool_result");
  assert.equal(toolDone[0]?.ok, true);

  markCursorAcpPromptFinished(state, "end_turn");
  assert.equal(state.terminalPromptFinished, true);
}
