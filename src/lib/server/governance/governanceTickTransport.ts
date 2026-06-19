/**
 * governanceTickTransport — 治理 tick 与 tunnel hub 之间的桥。
 *
 * 职责：
 *  1. dispatchReadyGovernanceTickJobsToMachines：把 queued 治理 job 通过 hub 派发给在线 machine
 *  2. registerGovernanceTickTunnelCallbacks：注册 hub 的"收到 machine 回执"监听
 *
 * 注入而非依赖：handleGovernanceTickMachineResult 由 dispatcher 提供，本模块只接 callback。
 * 这样 dispatcher → transport 单向依赖，不循环。
 */

import { getCurrentUserId, runWithUserContext } from "@/lib/server/context/userContext";
import {
  countPendingGovernanceTickJobs,
} from "@/lib/server/repositories/governanceTickJobsRepository";
import {
  DEFAULT_GOVERNANCE_TICK_EXPIRED_LEASE_GRACE_MS,
  DEFAULT_GOVERNANCE_TICK_LEASE_MS,
  leaseAndDispatchGovernanceTickJob,
} from "@/lib/server/governance/governanceTickQueue";
import type {
  GovernanceTickLlmPayload,
  GovernanceTickMachineResult,
} from "@/lib/server/governance/governanceTickProtocol";
import {
  getTunnelHub,
  setTunnelGovernanceTickResultListener,
} from "@/lib/server/tunnel/tunnelHub";

function logTransport(message: string, fields: Record<string, unknown> = {}) {
  console.info("[governance_tick_transport]", message, fields);
}

/**
 * 把当前 user 名下 queued 的治理 job 派发给在线 machine（一次最多 limit 条）。
 *
 * 不分配 lease 自己；委托给 leaseAndDispatchGovernanceTickJob，
 * 该函数同时负责 lease + snapshot refresh + sender 调用。
 *
 * 离线时跳过（skippedOffline=true），否则按 lease 顺序循环派发。
 */
export function dispatchReadyGovernanceTickJobsToMachines(input: {
  leaseOwner: string;
  limit?: number;
  leaseDurationMs?: number;
  now?: Date;
  llm?: GovernanceTickLlmPayload;
}): { processed: number; skippedOffline: boolean } {
  const userId = getCurrentUserId();
  const pendingCount = countPendingGovernanceTickJobs({
    now: input.now,
    expiredLeaseGraceMs: DEFAULT_GOVERNANCE_TICK_EXPIRED_LEASE_GRACE_MS,
  });
  if (pendingCount === 0) {
    return { processed: 0, skippedOffline: false };
  }
  if (!input.llm) {
    logTransport("skipped governance dispatch without llm runtime", {
      userId,
      pendingCount,
      leaseOwner: input.leaseOwner,
    });
    return { processed: 0, skippedOffline: false };
  }
  const hub = getTunnelHub();
  const onlineMachineIds = hub.getOnlineMachineIdsForUser(userId);
  if (onlineMachineIds.length === 0) {
    logTransport("skipped governance dispatch because machine offline", {
      userId,
      pendingCount,
      leaseOwner: input.leaseOwner,
    });
    return { processed: 0, skippedOffline: true };
  }

  const machineId = onlineMachineIds[0];
  const limit = Math.max(0, input.limit ?? 10);
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const dispatched = leaseAndDispatchGovernanceTickJob({
      leaseOwner: input.leaseOwner,
      leaseDurationMs: input.leaseDurationMs ?? DEFAULT_GOVERNANCE_TICK_LEASE_MS,
      now: input.now,
      llm: input.llm,
      sendCommand(command) {
        hub.sendGovernanceTick({ machineId, command });
        return true;
      },
    });
    if (!dispatched) break;
    processed += 1;
  }

  logTransport("dispatch ready governance jobs completed", {
    userId,
    machineId,
    pendingCount,
    processed,
    limit,
    leaseOwner: input.leaseOwner,
  });
  return { processed, skippedOffline: false };
}

/**
 * 注册 hub 的"machine 治理回执"监听。
 *
 * dispatcher 通过 `handleResult` 提供回执处理（避免本模块循环依赖 dispatcher）。
 * userId 来自 tunnel context；缺失时不绑用户上下文，由 caller 兜底。
 */
export function registerGovernanceTickTunnelCallbacks(input: {
  handleResult: (params: { result: GovernanceTickMachineResult }) => void | Promise<void>;
}) {
  setTunnelGovernanceTickResultListener((result, context) => {
    logTransport("received machine result", {
      jobId: result.governanceJobId,
      type: result.type,
      ok: result.ok,
      leaseOwner: result.leaseOwner,
      userId: context?.userId,
      machineId: context?.machineId,
    });
    if (context?.userId) {
      void runWithUserContext(context.userId, () => input.handleResult({ result }));
      return;
    }
    void input.handleResult({ result });
  });
}
