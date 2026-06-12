import { appendRuntimeDaemonLog } from "@/lib/daemon/daemonState";
import { releaseExpiredRuntimeJobLeases } from "@/lib/server/repositories/runtimeJobsRepository";
import {
  projectRuntimeJobStatusProjection,
  reconcileRuntimeJobStatusProjections,
} from "@/lib/server/services/goalRuntimeService";

export function runRecoveryWorker() {
  const expiredJobs = releaseExpiredRuntimeJobLeases();
  expiredJobs.forEach((job) => {
    projectRuntimeJobStatusProjection({
      job,
      status: "queued",
      reason: "恢复 Worker 已释放过期任务 lease",
    });
  });
  const reconciliation = reconcileRuntimeJobStatusProjections({
    statuses: ["queued", "running", "awaiting_user"],
  });
  appendRuntimeDaemonLog(
    `恢复 Worker 已释放过期任务 lease: ${expiredJobs.length}，对账投影: ${reconciliation.projected}/${reconciliation.checked}`,
  );
}
