import assert from "node:assert/strict";

import {
  extractCursorAcpPermissionToolName,
  mapDecisionToAcpOptionId,
} from "@/lib/server/runtime/adapters/cursorAcpPermission";

export function runCursorAcpPermissionSpecs() {
  assert.equal(extractCursorAcpPermissionToolName({ kind: "execute", title: "shell" }), "Bash");
  assert.equal(extractCursorAcpPermissionToolName({ kind: "search", title: "grep foo" }), "Grep");
  assert.equal(extractCursorAcpPermissionToolName({ title: "Write: README.md" }), "Write");

  assert.equal(
    mapDecisionToAcpOptionId("allow", "once", [{ optionId: "allow-once" }, { optionId: "reject-once" }]),
    "allow-once",
  );
  assert.equal(
    mapDecisionToAcpOptionId("deny", "deny", [{ optionId: "allow-once" }, { optionId: "reject-once" }]),
    "reject-once",
  );
  assert.equal(
    mapDecisionToAcpOptionId("allow", "runtime", [{ optionId: "allow-always" }, { optionId: "allow-once" }]),
    "allow-always",
  );
}
