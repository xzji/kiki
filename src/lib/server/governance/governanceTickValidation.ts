/**
 * governanceTickValidation — apply 阶段的 lease + revision 校验。
 *
 * 职责：
 *  - validateLeasedJob：判断 outcome 上报时 lease 是否有效（owner / token / 过期）
 *  - currentRevisionForOutcome：从 envelope 取目前 entity 的 revision，
 *    用于检查 baseRevision 是否仍然 fresh
 *  - durationMs：从字符串时间戳算 ms 差（spec 用得到，集中放这里）
 *
 * 不做副作用：纯函数；validateLeasedJob 仅决定结果，不修改 job 状态。
 */

import { findThreadById } from "@/lib/server/repositories/threadsRepository";
import { findTopicById } from "@/lib/server/repositories/topicsRepository";
import type { GovernanceTickJobRecord } from "@/lib/server/repositories/governanceTickJobsRepository";
import type { GovernanceTickOutcome } from "@/lib/server/governance/governanceTickProtocol";

export type GovernanceLeaseValidation =
  | { ok: true; acceptLeaseTokenMismatch?: boolean; acceptedExpiredLease?: boolean }
  | { ok: false; reason: string };

function logValidation(message: string, fields: Record<string, unknown>) {
  console.info("[governance_tick_validation]", message, fields);
}

/**
 * 校验回执时 lease 是否合法。
 *
 * 设计：
 *  - status 必须是 leased 或 expired（partial-failure requeued 的 queued 状态不合法）
 *  - owner 不变就接受；token 不变是常态，token 变了走 acceptLeaseTokenMismatch 旁路
 *    （同一 orchestrator 在治理长任务未回执前重租了 job，让旧 token 仍能落地）
 *  - 过期 lease 同样接受；entity revision 由 caller 二次校验防 stale
 */
export function validateLeasedJob(input: {
  job: GovernanceTickJobRecord;
  leaseOwner: string;
  leaseToken: string;
  now: Date;
}): GovernanceLeaseValidation {
  if (input.job.status !== "leased" && input.job.status !== "expired") {
    return { ok: false, reason: `invalid_job_status:${input.job.status}` };
  }
  if (input.job.leaseOwner !== input.leaseOwner) {
    return { ok: false, reason: "lease_owner_mismatch" };
  }
  const tokenMismatch = input.job.leaseToken !== input.leaseToken;
  const acceptedExpiredLease =
    input.job.status === "expired" ||
    Boolean(input.job.leaseExpiresAt && new Date(input.job.leaseExpiresAt).getTime() <= input.now.getTime());
  if (tokenMismatch || acceptedExpiredLease) {
    logValidation("accepting governance result with relaxed lease validation", {
      jobId: input.job.id,
      status: input.job.status,
      leaseOwner: input.leaseOwner,
      tokenMismatch,
      acceptedExpiredLease,
      leaseExpiresAt: input.job.leaseExpiresAt,
    });
  }
  return {
    ok: true,
    acceptLeaseTokenMismatch: tokenMismatch,
    acceptedExpiredLease,
  };
}

export function currentRevisionForOutcome(outcome: GovernanceTickOutcome): number | undefined {
  if (outcome.targetKind === "thread") return findThreadById(outcome.threadId)?.revision;
  return findTopicById(outcome.topicId)?.revision;
}

export function durationMs(startedAt: string | undefined, finishedAt: string): number {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const finished = Date.parse(finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished)) return 0;
  return Math.max(0, finished - started);
}
