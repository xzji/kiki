/**
 * daemonRunner — 兼容入口（PR refactor §3-D 后保留为薄壳）。
 *
 * 真正的装配逻辑在 [composeDaemon](file:///Users/bytedance/Documents/trae/long_horizon_agent/src/lib/daemon/composeDaemon.ts)。
 * 此文件仅 re-export `runRuntimeDaemonLoop` 与 `recordThreadLoopDaemonStartedLog`，
 * 保持 bin 入口 (kiki-runtime-daemon.ts) 与现有 spec (daemonRunner.spec.ts) 不变。
 */

export {
  runRuntimeDaemonLoop,
  recordThreadLoopDaemonStartedLog,
  composeDaemon,
} from "@/lib/daemon/composeDaemon";
