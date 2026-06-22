import assert from "node:assert/strict";

import {
  createCursorStreamParseState,
  extractCursorAssistantText,
  parseCursorStreamLine,
} from "@/lib/server/runtime/adapters/cursorStreamParser";

const FIXTURE_INIT = {
  type: "system",
  subtype: "init",
  apiKeySource: "login",
  cwd: "/workspace/kiki",
  session_id: "b6ab9e67-c929-46bf-862c-c6ebdc20db2c",
  model: "Composer 2.5 Fast",
  permissionMode: "default",
};

const FIXTURE_ASSISTANT = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  session_id: "b6ab9e67-c929-46bf-862c-c6ebdc20db2c",
};

export function runCursorStreamParserSpecs() {
  assert.equal(extractCursorAssistantText(FIXTURE_ASSISTANT), "ok");
  const state = createCursorStreamParseState();
  const initEvents = parseCursorStreamLine(FIXTURE_INIT, state);
  assert.deepEqual(initEvents, [{ type: "session", sessionId: "b6ab9e67-c929-46bf-862c-c6ebdc20db2c" }]);
  const deltaEvents = parseCursorStreamLine(FIXTURE_ASSISTANT, state);
  assert.equal(deltaEvents[0]?.type, "delta");
  if (deltaEvents[0]?.type === "delta") {
    assert.equal(deltaEvents[0].text, "ok");
  }
}
