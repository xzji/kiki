import assert from "node:assert/strict";

import { runWithUserContext } from "@/lib/server/context/userContext";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";

import {
  readUserRuntimeSettings,
  writeUserRuntimeSettings,
} from "./userRuntimeSettingsRepository";

export function runUserRuntimeSettingsRepositorySpecs() {
  ensureIsolatedPlanningSpecDataDir();

  writeUserRuntimeSettings({ maxConcurrentTasks: 1 });
  assert.equal(readUserRuntimeSettings().maxConcurrentTasks, 1);

  writeUserRuntimeSettings({ maxConcurrentTasks: 99 });
  assert.equal(readUserRuntimeSettings().maxConcurrentTasks, 10);

  runWithUserContext("spec-other-user", () => {
    assert.equal(
      readUserRuntimeSettings().maxConcurrentTasks,
      3,
      "runtime settings are scoped to the current account database",
    );
    writeUserRuntimeSettings({ maxConcurrentTasks: 2 });
    assert.equal(readUserRuntimeSettings().maxConcurrentTasks, 2);
  });

  runWithUserContext("spec-test-user", () => {
    assert.equal(readUserRuntimeSettings().maxConcurrentTasks, 10);
  });
}
