"use client";

import { create } from "zustand";

import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { normalizeRuntimeFilePolicy } from "@/lib/runtime/toolPolicy";
import { makeId } from "@/lib/utils";
import type {
  RuntimeFilePolicy,
  RuntimeFilePolicyMode,
  RuntimeEnvironment,
  RuntimeHealth,
  RuntimePermissionMode,
  RuntimeToolCapability,
} from "@/types/runtime";

type RuntimeEnvState = {
  hydrated: boolean;
  environments: RuntimeEnvironment[];
  activeRuntimeEnvId: string | null;
  projectionRevision: number;
  hydrate: () => Promise<void>;
  addEnvironment: (environment: Omit<RuntimeEnvironment, "id">) => RuntimeEnvironment;
  updateEnvironment: (id: string, updates: Partial<RuntimeEnvironment>) => void;
  removeEnvironment: (id: string) => void;
  setActiveEnvironment: (id: string) => void;
  setEnvironmentHealth: (id: string, health: RuntimeHealth) => void;
  setPermissionMode: (id: string, permissionMode: RuntimePermissionMode) => void;
  setFilePolicyMode: (id: string, mode: RuntimeFilePolicyMode) => void;
  setFilePolicyCustomCapability: (id: string, capability: RuntimeToolCapability, enabled: boolean) => void;
  setFilePolicy: (id: string, policy: RuntimeFilePolicy) => void;
  getActiveEnvironment: () => RuntimeEnvironment | null;
  replaceEnvironments: (environments: RuntimeEnvironment[], activeRuntimeEnvId?: string | null, revision?: number) => void;
};

export const INITIAL_ENVIRONMENTS: RuntimeEnvironment[] = INITIAL_RUNTIME_ENVIRONMENTS;

let hydrateRetryTimer: number | null = null;

function markDefault(environments: RuntimeEnvironment[], activeId: string | null) {
  return environments.map((item) => ({
    ...item,
    filePolicy: normalizeRuntimeFilePolicy(item.filePolicy),
    isDefault: item.id === activeId,
  }));
}

function normalizeEnvironment(environment: RuntimeEnvironment): RuntimeEnvironment {
  return {
    ...environment,
    filePolicy: normalizeRuntimeFilePolicy(environment.filePolicy),
  };
}

export const useRuntimeEnvStore = create<RuntimeEnvState>()((set, get) => ({
  hydrated: false,
  environments: INITIAL_ENVIRONMENTS,
  activeRuntimeEnvId: null,
  projectionRevision: 0,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const snapshot = await fetchRuntimeStateSnapshot();
      const revision = snapshot.meta?.revisions?.runtimeEnvironments;
      get().replaceEnvironments(snapshot.runtimeEnvironments, null, revision);
      set({ hydrated: true });
    } catch {
      if (!hydrateRetryTimer && typeof window !== "undefined") {
        hydrateRetryTimer = window.setTimeout(() => {
          hydrateRetryTimer = null;
          if (!get().hydrated) void get().hydrate();
        }, 5000);
      }
    }
  },
  // PROJECTION-ONLY: 服务端命令式 API 是权威，本 mutator 只用于乐观本地反馈。
  addEnvironment: (environment) => {
    const next: RuntimeEnvironment = {
      ...environment,
      filePolicy: normalizeRuntimeFilePolicy(environment.filePolicy),
      id: makeId("runtime-env"),
    };
    set((state) => {
      const activeRuntimeEnvId = next.type === "local" ? next.id : state.activeRuntimeEnvId;
      const environments = markDefault([next, ...state.environments], activeRuntimeEnvId);
      return { environments, activeRuntimeEnvId };
    });
    return next;
  },
  // PROJECTION-ONLY: 服务端命令式 API 是权威，本 mutator 只用于乐观本地反馈。
  updateEnvironment: (id, updates) => {
    set((state) => ({
      environments: state.environments.map((item) =>
        item.id === id ? normalizeEnvironment({ ...item, ...updates }) : item,
      ),
    }));
  },
  // PROJECTION-ONLY: 服务端命令式 API 是权威，本 mutator 只用于乐观本地反馈。
  removeEnvironment: (id) => {
    set((state) => {
      const environments = state.environments.filter((item) => item.id !== id);
      const activeRuntimeEnvId =
        state.activeRuntimeEnvId === id
          ? environments.find((item) => item.type === "local")?.id ?? null
          : state.activeRuntimeEnvId;
      return {
        environments: markDefault(environments, activeRuntimeEnvId),
        activeRuntimeEnvId,
      };
    });
  },
  // PROJECTION-ONLY: 服务端命令式 API 是权威，本 mutator 只用于乐观本地反馈。
  setActiveEnvironment: (id) => {
    set((state) => ({
      activeRuntimeEnvId: id,
      environments: markDefault(state.environments, id),
    }));
  },
  setEnvironmentHealth: (id, health) => {
    set((state) => ({
      environments: state.environments.map((item) =>
        item.id === id
          ? { ...item, health, lastCheckedAt: new Date().toISOString() }
          : item,
      ),
    }));
  },
  // PROJECTION-ONLY: 服务端命令式 API 是权威，本 mutator 只用于乐观本地反馈。
  setPermissionMode: (id, permissionMode) => {
    set((state) => ({
      environments: state.environments.map((item) =>
        item.id === id ? { ...item, permissionMode } : item,
      ),
    }));
  },
  setFilePolicyMode: (id, mode) => {
    set((state) => ({
      environments: state.environments.map((item) =>
        item.id === id
          ? {
              ...item,
              filePolicy: {
                ...normalizeRuntimeFilePolicy(item.filePolicy),
                mode,
              },
            }
          : item,
      ),
    }));
  },
  setFilePolicyCustomCapability: (id, capability, enabled) => {
    set((state) => ({
      environments: state.environments.map((item) => {
        if (item.id !== id) return item;
        const filePolicy = normalizeRuntimeFilePolicy(item.filePolicy);
        return {
          ...item,
          filePolicy: {
            ...filePolicy,
            custom: {
              ...filePolicy.custom,
              [capability]: enabled,
            },
          },
        };
      }),
    }));
  },
  setFilePolicy: (id, policy) => {
    set((state) => ({
      environments: state.environments.map((item) =>
        item.id === id ? { ...item, filePolicy: normalizeRuntimeFilePolicy(policy) } : item,
      ),
    }));
  },
  getActiveEnvironment: () => {
    const state = get();
    if (!state.activeRuntimeEnvId) return null;
    return state.environments.find((item) => item.id === state.activeRuntimeEnvId) ?? null;
  },
  replaceEnvironments: (environments, activeRuntimeEnvId, revision) => {
    set((state) => {
      if (typeof revision === "number" && revision < state.projectionRevision) return state;
      const normalizedEnvironments = environments.map(normalizeEnvironment);
      const nextActiveId =
        activeRuntimeEnvId ??
        normalizedEnvironments.find((item) => item.isDefault)?.id ??
        normalizedEnvironments.find((item) => item.type === "local")?.id ??
        null;
      return {
        environments: markDefault(normalizedEnvironments, nextActiveId),
        activeRuntimeEnvId: nextActiveId,
        ...(typeof revision === "number" ? { projectionRevision: revision } : {}),
      };
    });
  },
}));
