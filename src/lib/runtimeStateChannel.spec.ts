import assert from "node:assert/strict";

import { isRuntimeStateChannelMessage } from "@/lib/runtimeStateChannel";

export function runRuntimeStateChannelSpecs() {
  assert.equal(
    isRuntimeStateChannelMessage({
      kind: "runtimeEnvironments",
      revision: 1,
      updatedAt: "2026-05-30T00:00:00.000Z",
    }),
    true,
  );
  assert.equal(
    isRuntimeStateChannelMessage({
      kind: "unknown",
      revision: 1,
      updatedAt: "2026-05-30T00:00:00.000Z",
    }),
    false,
  );
}
