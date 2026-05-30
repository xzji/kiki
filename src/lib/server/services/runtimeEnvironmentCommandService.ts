import { makeId } from "@/lib/utils";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { normalizeRuntimeFilePolicy } from "@/lib/runtime/toolPolicy";
import {
  readRuntimeEnvironmentsSnapshot,
  upsertRuntimeEnvironmentsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
import type { RuntimeEnvironment, RuntimePermissionMode } from "@/types/runtime";

type CreateEnvironmentCommand = {
  type: "create_environment";
  environment: Omit<RuntimeEnvironment, "id"> | RuntimeEnvironment;
};

type UpdateEnvironmentCommand = {
  type: "update_environment";
  id: string;
  patch: Partial<RuntimeEnvironment>;
};

type RemoveEnvironmentCommand = {
  type: "remove_environment";
  id: string;
};

type ActivateEnvironmentCommand = {
  type: "activate_environment";
  id: string;
};

type SetPermissionModeCommand = {
  type: "set_permission_mode";
  id: string;
  permissionMode: RuntimePermissionMode;
};

export type RuntimeEnvironmentCommand =
  | CreateEnvironmentCommand
  | UpdateEnvironmentCommand
  | RemoveEnvironmentCommand
  | ActivateEnvironmentCommand
  | SetPermissionModeCommand;

export type RuntimeEnvironmentCommandResult = {
  environment?: RuntimeEnvironment;
  environments: RuntimeEnvironment[];
  revision: number;
  updatedAt: string;
};

export class RuntimeEnvironmentCommandError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuntimeEnvironmentCommandError";
  }
}

function normalizeEnvironment(environment: RuntimeEnvironment): RuntimeEnvironment {
  return {
    ...environment,
    filePolicy: normalizeRuntimeFilePolicy(environment.filePolicy),
  };
}

function markDefault(environments: RuntimeEnvironment[], activeId: string | null) {
  return environments.map((environment) => ({
    ...normalizeEnvironment(environment),
    isDefault: Boolean(activeId && environment.id === activeId),
  }));
}

function readCurrentEnvironments() {
  return readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS).map(normalizeEnvironment);
}

function activeEnvironmentId(environments: RuntimeEnvironment[]) {
  return (
    environments.find((environment) => environment.isDefault)?.id ??
    environments.find((environment) => environment.type === "local")?.id ??
    environments[0]?.id ??
    null
  );
}

function writeEnvironments(
  environments: RuntimeEnvironment[],
  environment?: RuntimeEnvironment,
  expectedRevision?: number,
): RuntimeEnvironmentCommandResult {
  const result = upsertRuntimeEnvironmentsSnapshot(environments, expectedRevision);
  if (!result.ok) {
    throw new RuntimeEnvironmentCommandError(409, "runtime environment snapshot 已更新，请刷新后重试", {
      conflict: true,
      currentRevision: result.revision,
      expectedRevision,
      updatedAt: result.updatedAt,
    });
  }
  return {
    environment,
    environments,
    revision: result.revision,
    updatedAt: result.updatedAt,
  };
}

function requireEnvironment(environments: RuntimeEnvironment[], id: string) {
  const environment = environments.find((item) => item.id === id);
  if (!environment) {
    throw new RuntimeEnvironmentCommandError(404, "未找到对应 Runtime 环境");
  }
  return environment;
}

export function applyRuntimeEnvironmentCommand(
  command: RuntimeEnvironmentCommand,
  options: { expectedRevision?: number } = {},
): RuntimeEnvironmentCommandResult {
  const current = readCurrentEnvironments();

  if (command.type === "create_environment") {
    const environment = normalizeEnvironment({
      ...command.environment,
      id: "id" in command.environment && command.environment.id ? command.environment.id : makeId("runtime-env"),
    });
    if (current.some((item) => item.id === environment.id)) {
      throw new RuntimeEnvironmentCommandError(409, "Runtime 环境已存在，请通过更新流程修改", {
        conflict: true,
        currentRevision: undefined,
        duplicateId: environment.id,
      });
    }
    const activeId = environment.type === "local" ? environment.id : activeEnvironmentId(current);
    const next = markDefault([environment, ...current], activeId);
    return writeEnvironments(next, next.find((item) => item.id === environment.id), options.expectedRevision);
  }

  if (command.type === "update_environment") {
    requireEnvironment(current, command.id);
    const previousActiveId = activeEnvironmentId(current);
    const nextRaw = current.map((environment) =>
      environment.id === command.id
        ? normalizeEnvironment({
            ...environment,
            ...command.patch,
            id: environment.id,
          })
        : environment,
    );
    // 锁定 update 路径不允许漂移 active：优先沿用旧 active，如果旧 active 已被删除才回退兜底。
    const preservedActiveId =
      previousActiveId && nextRaw.some((item) => item.id === previousActiveId)
        ? previousActiveId
        : activeEnvironmentId(nextRaw);
    const next = markDefault(nextRaw, preservedActiveId);
    return writeEnvironments(next, next.find((item) => item.id === command.id), options.expectedRevision);
  }

  if (command.type === "remove_environment") {
    requireEnvironment(current, command.id);
    const remaining = current.filter((environment) => environment.id !== command.id);
    const currentActiveId = activeEnvironmentId(current);
    const nextActiveId = currentActiveId === command.id ? activeEnvironmentId(remaining) : currentActiveId;
    return writeEnvironments(markDefault(remaining, nextActiveId), undefined, options.expectedRevision);
  }

  if (command.type === "activate_environment") {
    requireEnvironment(current, command.id);
    const next = markDefault(current, command.id);
    return writeEnvironments(next, next.find((item) => item.id === command.id), options.expectedRevision);
  }

  requireEnvironment(current, command.id);
  const nextRaw = current.map((environment) =>
    environment.id === command.id ? { ...environment, permissionMode: command.permissionMode } : environment,
  );
  const next = markDefault(nextRaw, activeEnvironmentId(nextRaw));
  return writeEnvironments(next, next.find((item) => item.id === command.id), options.expectedRevision);
}
