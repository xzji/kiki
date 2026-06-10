import assert from "node:assert/strict";

import { buildPiToolArgs } from "@/lib/server/runtime/adapters/piAdapter";

export function runPiAdapterSpecs() {
  assert.deepEqual(buildPiToolArgs([]), ["-nt"]);
  assert.deepEqual(buildPiToolArgs(["fileRead"]), ["--tools", "find,grep,ls,read"]);
  assert.deepEqual(buildPiToolArgs(["fileWrite", "shell"]), ["--tools", "bash,edit,write"]);
  assert.deepEqual(buildPiToolArgs(["web", "subagent", "schedule", "planMode"]), ["-nt"]);
}
