"use client";

import { useEffect } from "react";

import { setRuntimeDaemonMaxConcurrentTasks } from "@/lib/api/runtime-daemon";
import { useEasterEggSettingsStore } from "@/stores/easterEggSettingsStore";

// Browser-side scheduling, notification delivery, and watchdog logic are intentionally disabled.
// The daemon is the only producer; RuntimeEventBridge consumes SSE events and updates UI projections.
export function GoalSchedulerRuntime() {
  const hydrateSettings = useEasterEggSettingsStore((state) => state.hydrate);

  useEffect(() => {
    hydrateSettings();
    // 启动时把本地保存的并发上限同步给 daemon，保证前后端权威值一致。
    const maxConcurrentTasks = useEasterEggSettingsStore.getState().getSettings().maxConcurrentTasks;
    void setRuntimeDaemonMaxConcurrentTasks(maxConcurrentTasks).catch(() => {
      // 守护进程未就绪等情况下忽略；后续在设置面板/监控抽屉改动时会再次同步。
    });
  }, [hydrateSettings]);

  return null;
}
