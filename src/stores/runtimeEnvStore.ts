"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { makeId } from "@/lib/utils";
import type {
  RuntimeEnvironment,
  RuntimeHealth,
  RuntimePermissionMode,
} from "@/types/runtime";

type RuntimeEnvState = {
  hydrated: boolean;
  environments: RuntimeEnvironment[];
  activeRuntimeEnvId: string | null;
  hydrate: () => void;
  addEnvironment: (environment: Omit<RuntimeEnvironment, "id">) => RuntimeEnvironment;
  updateEnvironment: (id: string, updates: Partial<RuntimeEnvironment>) => void;
  removeEnvironment: (id: string) => void;
  setActiveEnvironment: (id: string) => void;
  setEnvironmentHealth: (id: string, health: RuntimeHealth) => void;
  setPermissionMode: (id: string, permissionMode: RuntimePermissionMode) => void;
  getActiveEnvironment: () => RuntimeEnvironment | null;
};

const STORAGE_KEY = "kiki.runtime.environments";

const INITIAL_ENVIRONMENTS: RuntimeEnvironment[] = [
  {
    id: "env-cloud-kiki",
    type: "cloud",
    name: "KiKi Cloud Agent",
    workingDirectory: "workspace-prod",
    cliPath: "kiki-agent",
    permissionMode: "readonly",
    health: { status: "offline", reason: "云端环境暂未接入真实服务" },
  },
];

function markDefault(environments: RuntimeEnvironment[], activeId: string | null) {
  return environments.map((item) => ({
    ...item,
    isDefault: item.id === activeId,
  }));
}

export const useRuntimeEnvStore = create<RuntimeEnvState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      environments: INITIAL_ENVIRONMENTS,
      activeRuntimeEnvId: null,
      hydrate: () => {
        if (get().hydrated) return;
        set((state) => ({
          hydrated: true,
          environments: markDefault(state.environments, state.activeRuntimeEnvId),
        }));
      },
      addEnvironment: (environment) => {
        const next: RuntimeEnvironment = {
          ...environment,
          id: makeId("runtime-env"),
        };
        set((state) => {
          const activeRuntimeEnvId = next.type === "local" ? next.id : state.activeRuntimeEnvId;
          const environments = markDefault([next, ...state.environments], activeRuntimeEnvId);
          return { environments, activeRuntimeEnvId };
        });
        return next;
      },
      updateEnvironment: (id, updates) => {
        set((state) => ({
          environments: state.environments.map((item) =>
            item.id === id ? { ...item, ...updates } : item,
          ),
        }));
      },
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
      setPermissionMode: (id, permissionMode) => {
        set((state) => ({
          environments: state.environments.map((item) =>
            item.id === id ? { ...item, permissionMode } : item,
          ),
        }));
      },
      getActiveEnvironment: () => {
        const state = get();
        if (!state.activeRuntimeEnvId) return null;
        return state.environments.find((item) => item.id === state.activeRuntimeEnvId) ?? null;
      },
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        environments: state.environments,
        activeRuntimeEnvId: state.activeRuntimeEnvId,
      }),
      onRehydrateStorage: () => (state) => {
        state?.hydrate();
      },
    },
  ),
);
