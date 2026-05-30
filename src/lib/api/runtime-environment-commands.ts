"use client";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { publishRuntimeStateChange } from "@/lib/runtimeStateChannel";
import { makeId } from "@/lib/utils";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { RuntimeEnvironment, RuntimePermissionMode } from "@/types/runtime";

type RuntimeEnvironmentCommandResponse = {
  ok?: boolean;
  reason?: string;
  conflict?: boolean;
  currentRevision?: number;
  environment?: RuntimeEnvironment;
  environments?: RuntimeEnvironment[];
  revision?: number;
  updatedAt?: string;
};

export class RuntimeEnvironmentCommandError extends Error {
  constructor(
    public status: number,
    public reason: string,
    public conflict = false,
    public currentRevision?: number,
  ) {
    super(reason);
    this.name = "RuntimeEnvironmentCommandError";
  }
}

async function readCommandResponse(response: Response): Promise<RuntimeEnvironmentCommandResponse> {
  try {
    return (await response.json()) as RuntimeEnvironmentCommandResponse;
  } catch {
    return {};
  }
}

async function requestRuntimeEnvironmentCommand(input: {
  url: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey: string;
}) {
  if (!input.idempotencyKey) {
    throw new RuntimeEnvironmentCommandError(400, "缺少 Idempotency-Key");
  }
  const expectedRevision = useRuntimeEnvStore.getState().projectionRevision;
  const body =
    input.body === undefined
      ? { expectedRevision }
      : { ...(input.body as Record<string, unknown>), expectedRevision };
  const response = await fetch(input.url, {
    method: input.method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
      "If-Match": String(expectedRevision),
    },
    body: JSON.stringify(body),
  });
  const data = await readCommandResponse(response);
  if (!response.ok) {
    if (data.conflict) {
      const snapshot = await fetchRuntimeStateSnapshot();
      useRuntimeEnvStore
        .getState()
        .replaceEnvironments(snapshot.runtimeEnvironments, null, snapshot.meta?.revisions?.runtimeEnvironments);
    }
    throw new RuntimeEnvironmentCommandError(
      response.status,
      data.reason || "Runtime 环境命令执行失败",
      Boolean(data.conflict),
      data.currentRevision,
    );
  }
  if (typeof data.revision === "number" && data.updatedAt) {
    publishRuntimeStateChange({
      kind: "runtimeEnvironments",
      revision: data.revision,
      updatedAt: data.updatedAt,
    });
  }
  return data as RuntimeEnvironmentCommandResponse & { ok: true; environments: RuntimeEnvironment[] };
}

export async function createEnvironmentCommand(input: {
  environment: Omit<RuntimeEnvironment, "id"> | RuntimeEnvironment;
  idempotencyKey?: string;
}) {
  const environment: RuntimeEnvironment = {
    ...input.environment,
    id: "id" in input.environment && input.environment.id ? input.environment.id : makeId("runtime-env"),
  };
  const idempotencyKey =
    input.idempotencyKey ?? createIdempotencyKey("runtime_environment.create", environment.id);
  return requestRuntimeEnvironmentCommand({
    url: "/api/runtime/environments",
    method: "POST",
    body: { environment },
    idempotencyKey,
  });
}

export async function updateEnvironmentCommand(input: {
  id: string;
  patch: Partial<RuntimeEnvironment>;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("runtime_environment.update", input.id);
  return requestRuntimeEnvironmentCommand({
    url: `/api/runtime/environments/${input.id}`,
    method: "PATCH",
    body: { patch: input.patch },
    idempotencyKey,
  });
}

export async function removeEnvironmentCommand(input: { id: string; idempotencyKey?: string }) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("runtime_environment.remove", input.id);
  return requestRuntimeEnvironmentCommand({
    url: `/api/runtime/environments/${input.id}`,
    method: "DELETE",
    idempotencyKey,
  });
}

export async function activateEnvironmentCommand(input: { id: string; idempotencyKey?: string }) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("runtime_environment.activate", input.id);
  return requestRuntimeEnvironmentCommand({
    url: `/api/runtime/environments/${input.id}/activate`,
    method: "POST",
    body: {},
    idempotencyKey,
  });
}

export async function setEnvironmentPermissionModeCommand(input: {
  id: string;
  permissionMode: RuntimePermissionMode;
  idempotencyKey?: string;
}) {
  const idempotencyKey =
    input.idempotencyKey ??
    createIdempotencyKey("runtime_environment.set_permission_mode", input.id, input.permissionMode);
  return requestRuntimeEnvironmentCommand({
    url: `/api/runtime/environments/${input.id}/permission-mode`,
    method: "POST",
    body: { permissionMode: input.permissionMode },
    idempotencyKey,
  });
}
