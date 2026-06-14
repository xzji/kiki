import { runWithUserContext } from "@/lib/server/context/userContext";
import { getRegistryDatabase } from "@/lib/server/db/registryClient";
import { getDatabase } from "@/lib/server/db/client";
import { countPendingGovernanceEventBridgeDeliveries } from "@/lib/server/repositories/governanceEventOutboxRepository";
import { countPendingGovernanceTickJobs } from "@/lib/server/repositories/governanceTickJobsRepository";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";

export type OrchestratorUserCandidate = {
  userId: string;
  queuedJobs: number;
  pendingGovernanceJobs: number;
  pendingGovernanceEvents: number;
  hasGoals: boolean;
};

function listActiveUserIds() {
  const db = getRegistryDatabase();
  const rows = db
    .prepare(`SELECT id FROM users WHERE status = 'active' ORDER BY created_at ASC`)
    .all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function inspectUserWork(userId: string): OrchestratorUserCandidate {
  return runWithUserContext(userId, () => {
    const db = getDatabase();
    const queuedRow = db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM runtime_jobs
          WHERE status = 'queued'
            AND (available_at IS NULL OR available_at <= ?)
        `,
      )
      .get(new Date().toISOString()) as { count: number };
    const pendingGovernanceJobs = countPendingGovernanceTickJobs();
    const pendingGovernanceEvents = countPendingGovernanceEventBridgeDeliveries();
    const goals = readGoalsSnapshot([]);
    return {
      userId,
      queuedJobs: queuedRow.count ?? 0,
      pendingGovernanceJobs,
      pendingGovernanceEvents,
      hasGoals: goals.length > 0,
    };
  });
}

/** 云端编排帧：优先处理有待办的用户；有 goals 的用户也纳入调度（可能产生新 job）。 */
export function listUsersForOrchestratorTick(): OrchestratorUserCandidate[] {
  return listActiveUserIds()
    .map((userId) => inspectUserWork(userId))
    .filter(
      (candidate) =>
        candidate.queuedJobs > 0 ||
        candidate.pendingGovernanceJobs > 0 ||
        candidate.pendingGovernanceEvents > 0 ||
        candidate.hasGoals,
    );
}

export function listUsersWithPendingWork() {
  return listUsersForOrchestratorTick().filter(
    (candidate) =>
      candidate.queuedJobs > 0 ||
      candidate.pendingGovernanceJobs > 0 ||
      candidate.pendingGovernanceEvents > 0,
  );
}
