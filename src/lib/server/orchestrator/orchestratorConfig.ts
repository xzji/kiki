export type OrchestratorExecutionMode = "local" | "cloud";

export type OrchestratorConfig = {
  executionMode: OrchestratorExecutionMode;
  maxConcurrentGlobal: number;
  maxConcurrentPerUser: number;
  schedulerIntervalMs: number;
  reconcileIntervalMs: number;
  tunnelPort: number;
  machineOnlineThresholdMs: number;
};

const DEFAULT_SCHEDULER_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_TUNNEL_PORT = 3001;
const DEFAULT_MACHINE_ONLINE_MS = 45_000;

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function getOrchestratorConfig(): OrchestratorConfig {
  const mode = process.env.KIKI_ORCHESTRATOR_MODE?.trim() === "cloud" ? "cloud" : "local";
  return {
    executionMode: mode,
    maxConcurrentGlobal: readPositiveInt(process.env.KIKI_MAX_CONCURRENT_GLOBAL, 10),
    maxConcurrentPerUser: readPositiveInt(process.env.KIKI_MAX_CONCURRENT_PER_USER, 3),
    schedulerIntervalMs: readPositiveInt(process.env.KIKI_SCHEDULER_INTERVAL_MS, DEFAULT_SCHEDULER_INTERVAL_MS),
    reconcileIntervalMs: readPositiveInt(process.env.KIKI_RECONCILE_INTERVAL_MS, DEFAULT_RECONCILE_INTERVAL_MS),
    tunnelPort: readPositiveInt(process.env.KIKI_TUNNEL_PORT, DEFAULT_TUNNEL_PORT),
    machineOnlineThresholdMs: readPositiveInt(
      process.env.KIKI_MACHINE_ONLINE_THRESHOLD_MS,
      DEFAULT_MACHINE_ONLINE_MS,
    ),
  };
}

export function isCloudOrchestratorMode() {
  return getOrchestratorConfig().executionMode === "cloud";
}
