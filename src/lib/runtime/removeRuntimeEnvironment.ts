"use client";

import {
  removeEnvironmentCommand,
  RuntimeEnvironmentCommandError,
} from "@/lib/api/runtime-environment-commands";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { RuntimeEnvironment } from "@/types/runtime";

type RemoveEnvironmentCommandResult = {
  environments: RuntimeEnvironment[];
  revision?: number;
};

type RemoveEnvironmentCommandFn = (input: { id: string }) => Promise<RemoveEnvironmentCommandResult>;

export async function removeRuntimeEnvironment(input: {
  environment: RuntimeEnvironment;
  command?: RemoveEnvironmentCommandFn;
}) {
  const command = input.command ?? removeEnvironmentCommand;
  const beforeRemove = useRuntimeEnvStore.getState();
  const previousEnvironments = beforeRemove.environments;
  const previousActiveRuntimeEnvId = beforeRemove.activeRuntimeEnvId;
  const previousRevision = beforeRemove.projectionRevision;
  const removeFromProjection = () => useRuntimeEnvStore.getState().removeEnvironment(input.environment.id);
  const removeOnce = () => command({ id: input.environment.id });
  let result: RemoveEnvironmentCommandResult;

  removeFromProjection();
  try {
    result = await removeOnce();
  } catch (error) {
    if (!(error instanceof RuntimeEnvironmentCommandError) || !error.conflict) {
      useRuntimeEnvStore
        .getState()
        .replaceEnvironments(previousEnvironments, previousActiveRuntimeEnvId, previousRevision);
      throw error;
    }
    removeFromProjection();
    result = await removeOnce();
  }

  useRuntimeEnvStore.getState().replaceEnvironments(result.environments, null, result.revision);
}
