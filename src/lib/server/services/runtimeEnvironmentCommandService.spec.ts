import assert from "node:assert/strict";

import { readRuntimeEnvironmentsSnapshotMeta } from "@/lib/server/runtime/stateSnapshot";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  applyRuntimeEnvironmentCommand,
  RuntimeEnvironmentCommandError,
} from "@/lib/server/services/runtimeEnvironmentCommandService";
import type { RuntimeEnvironment } from "@/types/runtime";

function localEnvironment(id: string): RuntimeEnvironment {
  return {
    id,
    type: "local",
    name: id,
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "confirm",
  };
}

export function runRuntimeEnvironmentCommandServiceSpecs() {
  ensureIsolatedPlanningSpecDataDir();
  const before = readRuntimeEnvironmentsSnapshotMeta([]);
  const created = applyRuntimeEnvironmentCommand(
    { type: "create_environment", environment: localEnvironment("runtime-create-spec") },
    { expectedRevision: before.revision },
  );
  assert.equal(created.environment?.id, "runtime-create-spec");

  assert.throws(
    () =>
      applyRuntimeEnvironmentCommand(
        { type: "create_environment", environment: localEnvironment("runtime-create-spec") },
        { expectedRevision: created.revision },
      ),
    (error) => error instanceof RuntimeEnvironmentCommandError && error.status === 409,
  );
}
