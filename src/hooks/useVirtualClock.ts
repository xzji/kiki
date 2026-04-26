"use client";

import { useTriggerStore } from "@/stores/triggerStore";

export function useVirtualClock() {
  const currentTime = useTriggerStore((state) => state.currentTime);
  const advanceHours = useTriggerStore((state) => state.advanceHours);
  const jumpToTomorrowEleven = useTriggerStore((state) => state.jumpToTomorrowEleven);

  return { currentTime, advanceHours, jumpToTomorrowEleven };
}
