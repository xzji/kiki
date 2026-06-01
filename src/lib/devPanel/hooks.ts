"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAgentRunsStore } from "@/stores/agentRunsStore";
import { useSagaInstancesStore } from "@/stores/sagaInstancesStore";
import type { AgentEvent, AgentRun, SagaInstance, SagaStatus, SagaType } from "@/types/agentRuntime";

/**
 * DevPanel 客户端投影 hooks（PR15 §12.5.2）。
 *
 * 通过 GET API 拉取数据：
 *  - useSagaInstances({ statuses?, types?, topicId?, sinceIso? })
 *  - useAgentRunsBySaga(sagaId)
 *  - useAgentEventsByRun(runId, { fromSeq? })
 *
 * 首屏通过 GET API 回填，随后合并 RuntimeEventBridge 写入的 SSE zustand 投影。
 */

type UseSagaInstancesInput = {
  statuses?: SagaStatus[];
  types?: SagaType[];
  topicId?: string;
  sinceIso?: string;
  limit?: number;
};

type UseSagaInstancesResult = {
  items: SagaInstance[];
  total: number;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

function joinCsv(values: readonly string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  return values.join(",");
}

function readErrorReason(json: unknown, fallback: string) {
  if (!json || typeof json !== "object") return fallback;
  const reason = (json as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : fallback;
}

function matchesSagaFilter(saga: SagaInstance, input: UseSagaInstancesInput | undefined) {
  if (input?.statuses?.length && !input.statuses.includes(saga.status)) return false;
  if (input?.types?.length && !input.types.includes(saga.type)) return false;
  if (input?.topicId && saga.topicId !== input.topicId) return false;
  if (input?.sinceIso && saga.startedAt < input.sinceIso) return false;
  return true;
}

export function useSagaInstances(input?: UseSagaInstancesInput): UseSagaInstancesResult {
  const storeSagas = useSagaInstancesStore((state) => state.sagas);
  const upsertSaga = useSagaInstancesStore((state) => state.upsertSaga);
  const [fetchedItems, setFetchedItems] = useState<SagaInstance[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const statusKey = joinCsv(input?.statuses);
  const typeKey = joinCsv(input?.types);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (statusKey) params.set("status", statusKey);
    if (typeKey) params.set("type", typeKey);
    if (input?.topicId) params.set("topicId", input.topicId);
    if (input?.sinceIso) params.set("sinceIso", input.sinceIso);
    if (input?.limit) params.set("limit", String(input.limit));
    const qs = params.toString();
    return qs ? `/api/dev/runtime/sagas?${qs}` : `/api/dev/runtime/sagas`;
  }, [statusKey, typeKey, input?.topicId, input?.sinceIso, input?.limit, tick]);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError(null);
    fetch(url)
      .then((res) => res.json())
      .then((json) => {
        if (aborted) return;
        if (!json || json.ok !== true) {
          setError(readErrorReason(json, "fetch failed"));
          return;
        }
        const nextItems = Array.isArray(json.items) ? (json.items as SagaInstance[]) : [];
        setFetchedItems(nextItems);
        for (const saga of nextItems) {
          upsertSaga(saga);
        }
        setTotal(typeof json.total === "number" ? json.total : 0);
      })
      .catch((err: unknown) => {
        if (aborted) return;
        setError(err instanceof Error ? err.message : "network error");
      })
      .finally(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [upsertSaga, url]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  const items = useMemo(() => {
    const merged = new Map<string, SagaInstance>();
    for (const saga of fetchedItems) merged.set(saga.id, saga);
    for (const saga of Object.values(storeSagas)) {
      if (matchesSagaFilter(saga, input)) merged.set(saga.id, saga);
    }
    return Array.from(merged.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }, [fetchedItems, input, storeSagas]);

  return { items, total, loading, error, refetch };
}

type UseAgentRunsBySagaResult = {
  saga: SagaInstance | null;
  runs: AgentRun[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

export function useAgentRunsBySaga(sagaId: string | null | undefined): UseAgentRunsBySagaResult {
  const storeRuns = useAgentRunsStore((state) => state.runs);
  const storeSagas = useSagaInstancesStore((state) => state.sagas);
  const upsertRun = useAgentRunsStore((state) => state.upsertRun);
  const upsertSaga = useSagaInstancesStore((state) => state.upsertSaga);
  const [saga, setSaga] = useState<SagaInstance | null>(null);
  const [fetchedRuns, setFetchedRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sagaId) {
      setSaga(null);
      setFetchedRuns([]);
      return;
    }
    let aborted = false;
    setLoading(true);
    setError(null);
    fetch(`/api/dev/runtime/sagas/${encodeURIComponent(sagaId)}/runs`)
      .then((res) => res.json())
      .then((json) => {
        if (aborted) return;
        if (!json || json.ok !== true) {
          setError(readErrorReason(json, "fetch failed"));
          return;
        }
        const nextSaga = (json.saga as SagaInstance) ?? null;
        const nextRuns = Array.isArray(json.runs) ? (json.runs as AgentRun[]) : [];
        setSaga(nextSaga);
        setFetchedRuns(nextRuns);
        if (nextSaga) upsertSaga(nextSaga);
        for (const run of nextRuns) {
          upsertRun(run);
        }
      })
      .catch((err: unknown) => {
        if (aborted) return;
        setError(err instanceof Error ? err.message : "network error");
      })
      .finally(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [sagaId, tick, upsertRun, upsertSaga]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  const runs = useMemo(() => {
    if (!sagaId) return [];
    const merged = new Map<string, AgentRun>();
    for (const run of fetchedRuns) merged.set(run.id, run);
    for (const run of Object.values(storeRuns)) {
      if (run.sagaInstanceId === sagaId) merged.set(run.id, run);
    }
    return Array.from(merged.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }, [fetchedRuns, sagaId, storeRuns]);

  return { saga: sagaId ? (storeSagas[sagaId] ?? saga) : null, runs, loading, error, refetch };
}

type UseAgentEventsByRunInput = { fromSeq?: number; limit?: number };

type UseAgentEventsByRunResult = {
  run: AgentRun | null;
  events: AgentEvent[];
  nextSeq: number;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

export function useAgentEventsByRun(
  runId: string | null | undefined,
  input?: UseAgentEventsByRunInput,
): UseAgentEventsByRunResult {
  const storeRuns = useAgentRunsStore((state) => state.runs);
  const storeEvents = useAgentRunsStore((state) => state.events);
  const upsertRun = useAgentRunsStore((state) => state.upsertRun);
  const appendEvent = useAgentRunsStore((state) => state.appendEvent);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [fetchedEvents, setFetchedEvents] = useState<AgentEvent[]>([]);
  const [nextSeq, setNextSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fromSeq = input?.fromSeq ?? 0;
  const limit = input?.limit;

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setFetchedEvents([]);
      setNextSeq(0);
      return;
    }
    let aborted = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (fromSeq > 0) params.set("fromSeq", String(fromSeq));
    if (limit && limit > 0) params.set("limit", String(limit));
    const qs = params.toString();
    const url = qs
      ? `/api/dev/runtime/runs/${encodeURIComponent(runId)}/events?${qs}`
      : `/api/dev/runtime/runs/${encodeURIComponent(runId)}/events`;
    fetch(url)
      .then((res) => res.json())
      .then((json) => {
        if (aborted) return;
        if (!json || json.ok !== true) {
          setError(readErrorReason(json, "fetch failed"));
          return;
        }
        const nextRun = (json.run as AgentRun) ?? null;
        const nextEvents = Array.isArray(json.events) ? (json.events as AgentEvent[]) : [];
        setRun(nextRun);
        setFetchedEvents(nextEvents);
        if (nextRun) upsertRun(nextRun);
        for (const event of nextEvents) {
          appendEvent(event);
        }
        setNextSeq(typeof json.nextSeq === "number" ? json.nextSeq : 0);
      })
      .catch((err: unknown) => {
        if (aborted) return;
        setError(err instanceof Error ? err.message : "network error");
      })
      .finally(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [appendEvent, fromSeq, limit, runId, tick, upsertRun]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  const resolvedRun = runId ? (storeRuns[runId] ?? run) : null;
  const events = useMemo(() => {
    if (!runId) return [];
    const merged = new Map<number, AgentEvent>();
    for (const event of fetchedEvents) merged.set(event.seq, event);
    for (const event of storeEvents[runId] ?? []) {
      merged.set(event.seq, event);
    }
    return Array.from(merged.values()).sort((a, b) => a.seq - b.seq);
  }, [fetchedEvents, runId, storeEvents]);

  return { run: resolvedRun, events, nextSeq, loading, error, refetch };
}
