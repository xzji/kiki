import assert from "node:assert/strict";

import { SUPPORTED_RUNTIME_KINDS } from "@/types/runtime";
import {
  getRegisteredRuntimeKinds,
  getRuntimeAdapter,
  isRuntimeSupported,
  listRuntimeAdapters,
} from "@/lib/server/runtime/adapters/registry";

export function runRuntimeRegistrySpecs() {
  assert.equal(getRuntimeAdapter().kind, "claude");
  assert.equal(getRuntimeAdapter("pi").meta.command, "pi");
  assert.equal(isRuntimeSupported("claude"), true);
  assert.equal(isRuntimeSupported("pi"), true);
  assert.equal(isRuntimeSupported("codex"), false);
  assert.deepEqual(
    listRuntimeAdapters().map((adapter) => adapter.kind),
    SUPPORTED_RUNTIME_KINDS,
  );
  assert.deepEqual(getRegisteredRuntimeKinds().sort(), [...SUPPORTED_RUNTIME_KINDS].sort());
  assert.throws(() => getRuntimeAdapter("codex"), /暂不支持/);
}
