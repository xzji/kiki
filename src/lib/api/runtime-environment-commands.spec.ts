import assert from "node:assert/strict";

import {
  RuntimeEnvironmentCommandError,
  updateEnvironmentCommand,
} from "@/lib/api/runtime-environment-commands";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import type { RuntimeEnvironment } from "@/types/runtime";

const staleEnvironment: RuntimeEnvironment = {
  id: "runtime-missing-spec",
  type: "local",
  name: "Stale Runtime",
  workingDirectory: "/workspace",
  cliPath: "claude",
  permissionMode: "execute",
};

export async function runRuntimeEnvironmentCommandClientSpecs() {
  const originalFetch = globalThis.fetch;
  const originalState = useRuntimeEnvStore.getState();
  const originalStoreProjection = {
    environments: originalState.environments,
    activeRuntimeEnvId: originalState.activeRuntimeEnvId,
    projectionRevision: originalState.projectionRevision,
  };
  const staleRevision = originalState.projectionRevision + 1;
  const refreshedRevision = staleRevision + 1;
  useRuntimeEnvStore.setState({
    environments: [{ ...staleEnvironment, isDefault: true }],
    activeRuntimeEnvId: staleEnvironment.id,
    projectionRevision: staleRevision,
  });

  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === "/api/runtime/environments/runtime-missing-spec") {
      return new Response(JSON.stringify({ ok: false, reason: "未找到对应 Runtime 环境" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/runtime/state") {
      return new Response(
        JSON.stringify({
          goals: [],
          runtimeEnvironments: INITIAL_RUNTIME_ENVIRONMENTS,
          scheduleEvents: [],
          meta: { revisions: { goals: 0, runtimeEnvironments: refreshedRevision, scheduleEvents: 0 } },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => updateEnvironmentCommand({ id: staleEnvironment.id, patch: { name: "Updated" } }),
      (error) => error instanceof RuntimeEnvironmentCommandError && error.status === 404,
    );
    assert.deepEqual(calls, ["/api/runtime/environments/runtime-missing-spec", "/api/runtime/state"]);
    assert.equal(
      useRuntimeEnvStore.getState().environments.some((environment) => environment.id === staleEnvironment.id),
      false,
    );
    assert.equal(useRuntimeEnvStore.getState().projectionRevision, refreshedRevision);
  } finally {
    globalThis.fetch = originalFetch;
    useRuntimeEnvStore.setState(originalStoreProjection);
  }
}
