import assert from "node:assert/strict";

import {
  legacyGoalDeliverableRedirectPath,
  legacyGoalDetailRedirectPath,
  legacyGoalTaskRedirectPath,
} from "@/lib/routes";

export function runRoutesSpecs() {
  assert.equal(
    legacyGoalDetailRedirectPath("topic/a b", {
      drawerTaskId: "task/1",
      filter: ["open", "done"],
      empty: undefined,
    }),
    "/topics/topic%2Fa%20b?drawerTaskId=task%2F1&filter=open&filter=done",
  );
  assert.equal(
    legacyGoalDetailRedirectPath("topic%2Fa%20b", { drawerTaskId: "task%2F1" }),
    "/topics/topic%2Fa%20b?drawerTaskId=task%252F1",
    "legacy dynamic params may arrive encoded; path segment must not be double-encoded",
  );

  assert.equal(
    legacyGoalTaskRedirectPath("topic/a b", "task/x y", { view: "exec", instanceId: "inst-1" }),
    "/topics/topic%2Fa%20b/tasks/task%2Fx%20y?view=exec&instanceId=inst-1",
  );
  assert.equal(
    legacyGoalTaskRedirectPath("topic%2Fa%20b", "task%2Fx%20y", { view: "exec" }),
    "/topics/topic%2Fa%20b/tasks/task%2Fx%20y?view=exec",
  );

  assert.equal(
    legacyGoalDeliverableRedirectPath("topic/a b", { from: "legacy" }),
    "/topics/topic%2Fa%20b/deliverable?from=legacy",
  );
}
