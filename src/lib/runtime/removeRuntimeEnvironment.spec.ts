import assert from "node:assert/strict";

import { RuntimeEnvironmentCommandError } from "@/lib/api/runtime-environment-commands";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { RuntimeEnvironment } from "@/types/runtime";

import { removeRuntimeEnvironment } from "./removeRuntimeEnvironment";

type ResolveDeleteCommand = (value: { environments: RuntimeEnvironment[]; revision: number }) => void;

function localEnvironment(id: string): RuntimeEnvironment {
  return {
    id,
    type: "local",
    name: id,
    workingDirectory: "/workspace",
    cliPath: "claude",
    permissionMode: "confirm",
  };
}

export async function runRemoveRuntimeEnvironmentSpecs() {
  await removesEnvironmentBeforeServerCommandFinishes();
  await keepsEnvironmentRemovedWhileRetryingConflict();
}

async function removesEnvironmentBeforeServerCommandFinishes() {
  const environment = localEnvironment("runtime-delete-immediate-spec");
  useRuntimeEnvStore.getState().replaceEnvironments([environment], environment.id, 1);

  let resolveCommand: ResolveDeleteCommand = () => {
    throw new Error("pending delete command resolver was not initialised");
  };
  const pendingCommand = new Promise<{ environments: RuntimeEnvironment[]; revision: number }>((resolve) => {
    resolveCommand = resolve;
  });

  const removal = removeRuntimeEnvironment({
    environment,
    command: () => pendingCommand,
  });

  assert.equal(
    useRuntimeEnvStore.getState().environments.some((item) => item.id === environment.id),
    false,
    "deleted runtime environment should disappear before the server command finishes",
  );

  resolveCommand({ environments: [], revision: 2 });
  await removal;
  assert.deepEqual(useRuntimeEnvStore.getState().environments, []);
}

async function keepsEnvironmentRemovedWhileRetryingConflict() {
  const environment = localEnvironment("runtime-delete-conflict-spec");
  useRuntimeEnvStore.getState().replaceEnvironments([environment], environment.id, 3);

  let calls = 0;
  let resolveRetry: ResolveDeleteCommand = () => {
    throw new Error("retry delete command resolver was not initialised");
  };
  const retryCommand = new Promise<{ environments: RuntimeEnvironment[]; revision: number }>((resolve) => {
    resolveRetry = resolve;
  });

  const removal = removeRuntimeEnvironment({
    environment,
    command: () => {
      calls += 1;
      if (calls === 1) {
        useRuntimeEnvStore.getState().replaceEnvironments([environment], environment.id, 4);
        throw new RuntimeEnvironmentCommandError(409, "conflict", true, 4);
      }
      return retryCommand;
    },
  });

  assert.equal(calls, 2);
  assert.equal(
    useRuntimeEnvStore.getState().environments.some((item) => item.id === environment.id),
    false,
    "conflict retry should not re-show the deleted runtime environment",
  );

  resolveRetry({ environments: [], revision: 5 });
  await removal;
  assert.deepEqual(useRuntimeEnvStore.getState().environments, []);
}
