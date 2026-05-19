"use client";

import { useEffect } from "react";

import { useEasterEggSettingsStore } from "@/stores/easterEggSettingsStore";

// Browser-side scheduling, notification delivery, and watchdog logic are intentionally disabled.
// The daemon is the only producer; RuntimeEventBridge consumes SSE events and updates UI projections.
export function GoalSchedulerRuntime() {
  const hydrateSettings = useEasterEggSettingsStore((state) => state.hydrate);

  useEffect(() => {
    hydrateSettings();
  }, [hydrateSettings]);

  return null;
}
