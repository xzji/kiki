import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";
import { releaseExpiredRuntimeJobLeases } from "@/lib/server/repositories/runtimeJobsRepository";

export function runRecoveryWorker() {
  releaseExpiredRuntimeJobLeases();
  appendRuntimeDaemonLog("恢复 Worker 已释放过期任务 lease");
}
