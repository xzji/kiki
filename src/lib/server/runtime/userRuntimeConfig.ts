import type { RuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import { readUserRuntimeSettings } from "@/lib/server/repositories/userRuntimeSettingsRepository";

export function applyUserRuntimeSettingsToDaemonConfig(config: RuntimeDaemonConfig): RuntimeDaemonConfig {
  const settings = readUserRuntimeSettings();
  return {
    ...config,
    maxConcurrentTasks: settings.maxConcurrentTasks,
  };
}
