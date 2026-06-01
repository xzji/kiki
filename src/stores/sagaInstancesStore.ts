"use client";

import { create } from "zustand";

import type { SagaInstance } from "@/types/agentRuntime";

/**
 * sagaInstancesStore — read-only browser projection of `saga_instances`.
 *
 * Plan ref: §10.6 problem 26. Updates are driven by SSE event
 * `saga.step.advanced`, which carries the latest SagaInstance row.
 */

type SagaInstancesState = {
  /** sagas keyed by SagaInstance.id */
  sagas: Record<string, SagaInstance>;
  upsertSaga: (saga: SagaInstance) => void;
  advance: (input: { payload: Record<string, unknown> }) => void;
  reset: () => void;
};

function asSagaInstance(value: unknown): SagaInstance | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.topicId !== "string" || typeof r.type !== "string") {
    return null;
  }
  return r as unknown as SagaInstance;
}

export const useSagaInstancesStore = create<SagaInstancesState>((set) => ({
  sagas: {},
  upsertSaga: (saga) =>
    set((state) => ({ sagas: { ...state.sagas, [saga.id]: saga } })),
  advance: ({ payload }) => {
    const saga = asSagaInstance(payload.saga);
    if (!saga) return;
    set((state) => ({ sagas: { ...state.sagas, [saga.id]: saga } }));
  },
  reset: () => set({ sagas: {} }),
}));
