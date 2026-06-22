"use client";

import { useEffect } from "react";

import { fetchRuntimeDaemonStatus } from "@/lib/api/runtime-daemon";
import { useEasterEggSettingsStore } from "@/stores/easterEggSettingsStore";

// Browser-side scheduling, notification delivery, and watchdog logic are intentionally disabled.
// The daemon is the only producer; RuntimeEventBridge consumes SSE events and updates UI projections.
export function GoalSchedulerRuntime() {
  const hydrateSettings = useEasterEggSettingsStore((state) => state.hydrate);
  const updateNumericSetting = useEasterEggSettingsStore((state) => state.updateNumericSetting);

  useEffect(() => {
    hydrateSettings();
    // 账号级运行配置由服务端持久化；浏览器本地 store 只作为展示缓存。
    void fetchRuntimeDaemonStatus().then((status) => {
      if (typeof status.config?.maxConcurrentTasks === "number") {
        updateNumericSetting("maxConcurrentTasks", status.config.maxConcurrentTasks);
      }
    }).catch(() => {
      // 离线或未登录阶段忽略；打开任务抽屉/设置面板时会再次拉取。
    });
  }, [hydrateSettings, updateNumericSetting]);

  return null;
}
