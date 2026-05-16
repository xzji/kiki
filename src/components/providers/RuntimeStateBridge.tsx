"use client";

import { useEffect, useMemo, useRef } from "react";

import { fetchRuntimeStateSnapshot, syncRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import type { RuntimeStatePayload, RuntimeStateRevision, RuntimeStateSyncResponse } from "@/lib/api/runtime-daemon";
import { useGoalStore } from "@/stores/goalStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import { useScheduleStore } from "@/stores/scheduleStore";
import type { Goal } from "@/types/kiki";

function stableStringify(value: unknown) {
  return JSON.stringify(value);
}

const EMPTY_REVISION: RuntimeStateRevision = {
  goals: 0,
  runtimeEnvironments: 0,
  scheduleEvents: 0,
};

function revisionFromSnapshot(snapshot: RuntimeStatePayload): RuntimeStateRevision {
  return {
    ...EMPTY_REVISION,
    ...(snapshot.meta?.revisions ?? {}),
  };
}

function mergeSyncRevision(current: RuntimeStateRevision, response: RuntimeStateSyncResponse): RuntimeStateRevision {
  return {
    goals: response.results?.goals?.revision ?? current.goals,
    runtimeEnvironments: response.results?.runtimeEnvironments?.revision ?? current.runtimeEnvironments,
    scheduleEvents: response.results?.scheduleEvents?.revision ?? current.scheduleEvents,
  };
}

function mergeRemoteSnapshotWithLocalGoals(remoteGoals: Goal[], localGoals: Goal[]) {
  const remoteIds = new Set(remoteGoals.map((goal) => goal.id));
  const localOnlyGoals = localGoals.filter((goal) => !remoteIds.has(goal.id));
  return [...remoteGoals, ...localOnlyGoals];
}

export function RuntimeStateBridge() {
  const goals = useGoalStore((state) => state.goals);
  const replaceGoals = useGoalStore((state) => state.replaceGoals);
  const environments = useRuntimeEnvStore((state) => state.environments);
  const activeRuntimeEnvId = useRuntimeEnvStore((state) => state.activeRuntimeEnvId);
  const replaceEnvironments = useRuntimeEnvStore((state) => state.replaceEnvironments);
  const events = useScheduleStore((state) => state.events);
  const replaceEvents = useScheduleStore((state) => state.replaceEvents);

  const currentGoalsKey = useMemo(() => stableStringify(goals), [goals]);
  const currentEnvironmentsKey = useMemo(() => stableStringify({ environments, activeRuntimeEnvId }), [environments, activeRuntimeEnvId]);
  const currentEventsKey = useMemo(() => stableStringify(events), [events]);
  const isApplyingRemoteRef = useRef(false);
  const didBootstrapRef = useRef(false);
  const remoteRevisionRef = useRef<RuntimeStateRevision>(EMPTY_REVISION);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      try {
        const snapshot = await fetchRuntimeStateSnapshot();
        if (cancelled) return;
        isApplyingRemoteRef.current = true;
        remoteRevisionRef.current = revisionFromSnapshot(snapshot);
        replaceGoals(snapshot.goals);
        replaceEnvironments(snapshot.runtimeEnvironments);
        replaceEvents(snapshot.scheduleEvents);
        didBootstrapRef.current = true;
      } catch {
        didBootstrapRef.current = true;
      } finally {
        window.setTimeout(() => {
          isApplyingRemoteRef.current = false;
        }, 0);
      }
    };
    void hydrate();

    const timer = window.setInterval(async () => {
      try {
        const snapshot = await fetchRuntimeStateSnapshot();
        if (cancelled) return;
        const remoteGoalsKey = stableStringify(snapshot.goals);
        const remoteEnvironmentsKey = stableStringify({
          environments: snapshot.runtimeEnvironments,
          activeRuntimeEnvId: snapshot.runtimeEnvironments.find((item) => item.isDefault)?.id ?? null,
        });
        const remoteEventsKey = stableStringify(snapshot.scheduleEvents);
        const remoteRevision = revisionFromSnapshot(snapshot);
        if (
          remoteGoalsKey !== stableStringify(useGoalStore.getState().goals) ||
          remoteEnvironmentsKey !==
            stableStringify({
              environments: useRuntimeEnvStore.getState().environments,
              activeRuntimeEnvId: useRuntimeEnvStore.getState().activeRuntimeEnvId,
            }) ||
          remoteEventsKey !== stableStringify(useScheduleStore.getState().events)
        ) {
          isApplyingRemoteRef.current = true;
          remoteRevisionRef.current = remoteRevision;
          replaceGoals(snapshot.goals);
          replaceEnvironments(snapshot.runtimeEnvironments);
          replaceEvents(snapshot.scheduleEvents);
          window.setTimeout(() => {
            isApplyingRemoteRef.current = false;
          }, 0);
        } else {
          remoteRevisionRef.current = remoteRevision;
        }
      } catch {
        // ignore polling failures
      }
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [replaceEnvironments, replaceEvents, replaceGoals]);

  useEffect(() => {
    if (!didBootstrapRef.current || isApplyingRemoteRef.current) return;
    const syncSnapshot = async () => {
      try {
        const result = await syncRuntimeStateSnapshot({
          baseRevision: remoteRevisionRef.current,
          goals,
          runtimeEnvironments: environments.map((environment) => ({
            ...environment,
            isDefault: environment.id === activeRuntimeEnvId,
          })),
          scheduleEvents: events,
        });
        remoteRevisionRef.current = mergeSyncRevision(remoteRevisionRef.current, result);
      } catch {
        try {
          const snapshot = await fetchRuntimeStateSnapshot();
          const mergedGoals = mergeRemoteSnapshotWithLocalGoals(snapshot.goals, useGoalStore.getState().goals);
          isApplyingRemoteRef.current = true;
          remoteRevisionRef.current = revisionFromSnapshot(snapshot);
          replaceGoals(mergedGoals);
          replaceEnvironments(snapshot.runtimeEnvironments);
          replaceEvents(snapshot.scheduleEvents);
          window.setTimeout(() => {
            isApplyingRemoteRef.current = false;
          }, 0);
        } catch {
          // ignore transient sync and refresh failures
        }
      }
    };
    void syncSnapshot();
  }, [
    currentGoalsKey,
    currentEnvironmentsKey,
    currentEventsKey,
    goals,
    environments,
    activeRuntimeEnvId,
    events,
    replaceEnvironments,
    replaceEvents,
    replaceGoals,
  ]);

  return null;
}
