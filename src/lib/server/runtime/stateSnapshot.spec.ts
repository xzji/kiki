import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { enterUserContext } from "@/lib/server/context/userContext";
import {
  readRuntimeEnvironmentsSnapshotMeta,
  upsertRuntimeEnvironmentsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
import type { RuntimeEnvironment } from "@/types/runtime";

const PLANNING_SPEC_USER_ID = "spec-test-user";

let isolatedDataDirInitialized = false;

export function ensureIsolatedPlanningSpecDataDir() {
  if (!isolatedDataDirInitialized) {
    process.env.KIKI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-planning-spec-"));
    isolatedDataDirInitialized = true;
  }
  enterUserContext(PLANNING_SPEC_USER_ID);
}

function environment(id: string): RuntimeEnvironment {
  return {
    id,
    type: "local",
    name: id,
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "confirm",
  };
}

export function runStateSnapshotSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  const first = upsertRuntimeEnvironmentsSnapshot([environment("runtime-A")], 0);
  assert.equal(first.ok, true);
  assert.equal(first.revision, 1);

  const conflict = upsertRuntimeEnvironmentsSnapshot([environment("runtime-B")], 0);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.revision, 1);

  const snapshot = readRuntimeEnvironmentsSnapshotMeta([]);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.value[0]?.id, "runtime-A");
}
