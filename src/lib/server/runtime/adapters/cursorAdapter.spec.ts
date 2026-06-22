import assert from "node:assert/strict";

import { buildCursorArgs } from "@/lib/server/runtime/adapters/cursorAdapter";
import { buildCursorAcpArgs } from "@/lib/server/runtime/adapters/cursorAcpClient";
import {
  createCursorStreamParseState,
  extractCursorJsonResult,
  extractCursorTextResult,
  parseCursorStreamLine,
} from "@/lib/server/runtime/adapters/cursorStreamParser";
import {
  buildCursorPermissionPatterns,
  mapCursorToolNameForPermission,
  stripManagedAllowPatterns,
} from "@/lib/server/runtime/adapters/cursorToolPolicy";
import { DEFAULT_RUNTIME_FILE_POLICY } from "@/types/runtime";
import { resolveRuntimeToolPolicy } from "@/lib/runtime/toolPolicy";

const INIT_LINE = {
  type: "system",
  subtype: "init",
  session_id: "b6ab9e67-c929-46bf-862c-c6ebdc20db2c",
  model: "Composer 2.5 Fast",
  cwd: "/tmp/project",
};

const ASSISTANT_LINE = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  session_id: "b6ab9e67-c929-46bf-862c-c6ebdc20db2c",
};

const RESULT_LINE = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  session_id: "b6ab9e67-c929-46bf-862c-c6ebdc20db2c",
};

export function runCursorAdapterSpecs() {
  const executePolicy = resolveRuntimeToolPolicy({
    filePolicy: DEFAULT_RUNTIME_FILE_POLICY,
    permissionMode: "execute",
    channelPolicy: { mode: "task" },
  });

  assert.ok(buildCursorPermissionPatterns(executePolicy.enabledCapabilities).includes("Shell(**)"));
  assert.equal(mapCursorToolNameForPermission("Shell"), "Bash");
  assert.deepEqual(stripManagedAllowPatterns(["Shell(**)", "Mcp(custom)"]), ["Mcp(custom)"]);
  assert.deepEqual(buildCursorArgs(), [...buildCursorAcpArgs()]);

  const state = createCursorStreamParseState();
  const sessionEvents = parseCursorStreamLine(INIT_LINE, state);
  assert.equal(sessionEvents.length, 1);
  assert.equal(sessionEvents[0]?.type, "session");

  parseCursorStreamLine(ASSISTANT_LINE, state);
  assert.equal(state.aggregatedText, "ok");

  const resultEvents = parseCursorStreamLine(RESULT_LINE, state);
  assert.equal(resultEvents.length, 0);
  assert.equal(state.terminalResultReceived, true);
  assert.equal(state.terminalIsSuccess, true);

  const jsonStdout = `${JSON.stringify(INIT_LINE)}\n${JSON.stringify(RESULT_LINE)}\n`;
  assert.equal(extractCursorJsonResult(jsonStdout), "ok");
  assert.equal(extractCursorTextResult("plain text output\n"), "plain text output");
}
