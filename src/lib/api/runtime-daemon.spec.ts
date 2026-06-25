import assert from "node:assert/strict";

import {
  fetchRuntimeStateSnapshot,
  isRuntimeStateUnchangedPayload,
} from "@/lib/api/runtime-daemon";

export async function runRuntimeDaemonApiSpecs() {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return new Response(
      JSON.stringify({
        unchanged: true,
        meta: {
          revisions: { goals: 1, runtimeEnvironments: 2, scheduleEvents: 3 },
          etags: { goals: "goals-v1", runtimeEnvironments: "envs-v1", scheduleEvents: "events-v1" },
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const payload = await fetchRuntimeStateSnapshot({
      knownEtags: {
        goals: "goals-v1",
        runtimeEnvironments: "envs-v1",
        scheduleEvents: "events-v1",
      },
    });
    assert.equal(
      calls[0],
      "/api/runtime/state?goalsEtag=goals-v1&runtimeEnvironmentsEtag=envs-v1&scheduleEventsEtag=events-v1",
    );
    assert.equal(isRuntimeStateUnchangedPayload(payload), true);
    if (!isRuntimeStateUnchangedPayload(payload)) throw new Error("expected unchanged runtime state");
    assert.equal(payload.meta.etags?.goals, "goals-v1");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
