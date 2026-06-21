import { runWithUserContext } from "@/lib/server/context/userContext";
import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { readGoalsSnapshot, readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { runGoalSchedulerEngine } from "@/lib/server/scheduling/taskScheduler";
import { runGoalDaemonSideEffects } from "@/lib/server/scheduling/goalSideEffects";
import { dispatchReadyTasksToMachines } from "@/lib/server/scheduling/taskDispatcher";
import { orchestratorConcurrencyBudget } from "@/lib/server/orchestrator/concurrencyBudget";
import type { OrchestratorConfig } from "@/lib/server/orchestrator/orchestratorConfig";
import { getDefaultRuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import {
  TaskEventBridge,
  ThreadEventBridge,
  TopicEventBridge,
} from "@/lib/server/governance/eventBridge";
import {
  dispatchReadyGovernanceTickJobsToMachines,
  enqueueDueGovernanceTickJobs,
  registerGovernanceTickTunnelCallbacks,
} from "@/lib/server/governance/governanceTickDispatcher";

export type OrchestratorUserFrameResult = {
  userId: string;
  createdJobs: number;
  skipped: number;
  governanceEventsProcessed: number;
  governanceJobsCreated: number;
  governanceJobsDispatched: number;
  governanceSkippedOffline: boolean;
  dispatched: number;
  skippedOffline: boolean;
};

export async function runOrchestratorUserFrame(input: {
  userId: string;
  leaseOwner: string;
  config: OrchestratorConfig;
}): Promise<OrchestratorUserFrameResult> {
  return runWithUserContext(input.userId, async () => {
    const runtimeEnvironments = readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS);
    const runtimeEnv =
      runtimeEnvironments.find((environment) => environment.isDefault && environment.type === "local") ??
      runtimeEnvironments.find((environment) => environment.type === "local") ??
      runtimeEnvironments[0] ??
      null;
    const schedulerConfig = getDefaultRuntimeDaemonConfig();

    registerGovernanceTickTunnelCallbacks();
    const governanceEventResults = [
      new ThreadEventBridge().consumePending(),
      new TopicEventBridge().consumePending(),
      new TaskEventBridge().consumePending(),
    ];
    const governanceJobs = enqueueDueGovernanceTickJobs({ userId: input.userId });
    const governanceDispatchResult = dispatchReadyGovernanceTickJobsToMachines({
      leaseOwner: input.leaseOwner,
      limit: input.config.maxConcurrentPerUser,
      llm: runtimeEnv
        ? {
            runtimeEnv,
            cwd: runtimeEnv.workingDirectory,
            permissionMode: runtimeEnv.permissionMode,
          }
        : undefined,
    });

    // allow-raw-goals-snapshot: 调度入口读取结构基准；runGoalSchedulerEngine / sideEffects 内部负责合成执行态。
    const goals = readGoalsSnapshot([]);
    const schedulerResult = runGoalSchedulerEngine({
      goals,
      runtimeEnv,
      config: schedulerConfig,
    });
    runGoalDaemonSideEffects(goals);

    const maxSlots = orchestratorConcurrencyBudget.availableSlots(input.userId, input.config);
    let dispatched = 0;
    let skippedOffline = false;

    if (maxSlots > 0) {
      const tunnelResult = await dispatchReadyTasksToMachines({
        leaseOwner: input.leaseOwner,
        limit: maxSlots,
      });
      dispatched = tunnelResult.processed;
      skippedOffline = tunnelResult.skippedOffline;
    }

    return {
      userId: input.userId,
      createdJobs: schedulerResult.createdJobs,
      skipped: schedulerResult.skipped,
      governanceEventsProcessed: governanceEventResults.reduce((sum, result) => sum + result.processed, 0),
      governanceJobsCreated: governanceJobs.length,
      governanceJobsDispatched: governanceDispatchResult.processed,
      governanceSkippedOffline: governanceDispatchResult.skippedOffline,
      dispatched,
      skippedOffline,
    };
  });
}
