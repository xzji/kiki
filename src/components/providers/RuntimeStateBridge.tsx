"use client";

import { useEffect, useMemo, useRef } from "react";

import { fetchRuntimeStateSnapshot, syncRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { useGoalStore } from "@/stores/goalStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import { useScheduleStore } from "@/stores/scheduleStore";

function stableStringify(value: unknown) {
  return JSON.stringify(value);
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

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      try {
        const snapshot = await fetchRuntimeStateSnapshot();
        if (cancelled) return;
        isApplyingRemoteRef.current = true;
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
          replaceGoals(snapshot.goals);
          replaceEnvironments(snapshot.runtimeEnvironments);
          replaceEvents(snapshot.scheduleEvents);
          window.setTimeout(() => {
            isApplyingRemoteRef.current = false;
          }, 0);
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
    void syncRuntimeStateSnapshot({
      goals,
      runtimeEnvironments: environments.map((environment) => ({
        ...environment,
        isDefault: environment.id === activeRuntimeEnvId,
      })),
      scheduleEvents: events,
    });
  }, [currentGoalsKey, currentEnvironmentsKey, currentEventsKey, goals, environments, activeRuntimeEnvId, events]);

  return null;
}
