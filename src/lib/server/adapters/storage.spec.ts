import assert from "node:assert/strict";

import { LocalFsStorageAdapter } from "@/lib/server/adapters/storage";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";

export function runStorageAdapterSpecs() {
  ensureIsolatedPlanningSpecDataDir();
  const adapter = new LocalFsStorageAdapter();

  const saved = adapter.putBlob("safe/path.txt", "hello");
  assert.equal(saved.ref.adapter, "local-fs");
  assert.equal(adapter.getBlob("safe/path.txt").toString("utf8"), "hello");

  assert.throws(() => adapter.getBlob("../escape.txt"), /非法 storage key/);
}
