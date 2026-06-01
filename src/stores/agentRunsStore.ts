"use client";

import { create } from "zustand";

import type { AgentEvent, AgentRun } from "@/types/agentRuntime";

/**
 * agentRunsStore — read-only browser projection of `agent_runs` + `agent_events`.
 *
 * Plan ref: §10.6 problem 26. Updates are driven exclusively by SSE events
 * routed through RuntimeEventBridge:
 *  - `agent.run.started`   → upsert run with status=pending/running
 *  - `agent.run.event`     → append event to per-run timeline
 *  - `agent.run.completed` → upsert run with terminal status
 */

type AgentRunsState = {
  /** runs keyed by AgentRun.id */
  runs: Record<string, AgentRun>;
  /** events grouped by agent_run_id, sorted ascending by seq */
  events: Record<string, AgentEvent[]>;
  upsertRun: (run: AgentRun) => void;
  appendEvent: (event: AgentEvent) => void;
  applyEvent: (input: { kind: string; payload: Record<string, unknown> }) => void;
  reset: () => void;
};

function asAgentRun(value: unknown): AgentRun | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.role !== "string" || typeof r.status !== "string") {
    return null;
  }
  return r as unknown as AgentRun;
}

function asAgentEvent(value: unknown): AgentEvent | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== "string" || typeof e.agentRunId !== "string" || typeof e.seq !== "number") {
    return null;
  }
  return e as unknown as AgentEvent;
}

export const useAgentRunsStore = create<AgentRunsState>((set) => ({
  runs: {},
  events: {},
  upsertRun: (run) =>
    set((state) => ({
      runs: { ...state.runs, [run.id]: run },
    })),
  appendEvent: (event) =>
    set((state) => {
      const existing = state.events[event.agentRunId] ?? [];
      // Idempotent insert: skip duplicate seq
      if (existing.some((entry) => entry.seq === event.seq)) return state;
      const next = [...existing, event].sort((a, b) => a.seq - b.seq);
      return { events: { ...state.events, [event.agentRunId]: next } };
    }),
  applyEvent: ({ kind, payload }) => {
    if (kind === "agent.run.started" || kind === "agent.run.completed") {
      const run = asAgentRun(payload.run);
      if (run) {
        set((state) => ({ runs: { ...state.runs, [run.id]: run } }));
      }
      return;
    }
    if (kind === "agent.run.event") {
      const event = asAgentEvent(payload.event);
      if (event) {
        set((state) => {
          const existing = state.events[event.agentRunId] ?? [];
          if (existing.some((entry) => entry.seq === event.seq)) return state;
          const next = [...existing, event].sort((a, b) => a.seq - b.seq);
          return { events: { ...state.events, [event.agentRunId]: next } };
        });
      }
      return;
    }
  },
  reset: () => set({ runs: {}, events: {} }),
}));
