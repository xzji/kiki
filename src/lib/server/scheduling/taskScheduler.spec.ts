import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { runGoalSchedulerEngine } from "@/lib/server/scheduling/taskScheduler";
import type { Goal } from "@/types/kiki";
import { DEFAULT_RUNTIME_FILE_POLICY, type RuntimeEnvironment } from "@/types/runtime";

function runtimeEnv(): RuntimeEnvironment {
  return {
    id: "runtime-scheduler-spec",
    type: "local",
    name: "local",
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "execute",
  };
}

function goalWithoutConversationId(): Goal {
  return {
    id: "goal-scheduler-spec",
    title: "缺 conversationId 的目标",
    deadline: "2026-05-30T00:00:00.000Z",
    progress: 0,
    createdAt: "2026-05-30T00:00:00.000Z",
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    },
    subGoals: [
      {
        id: "sub-scheduler-spec",
        goalId: "goal-scheduler-spec",
        title: "子目标",
        tasks: [
          {
            id: "task-scheduler-spec",
            subGoalId: "sub-scheduler-spec",
            title: "立即任务",
            description: "",
            expectedOutcome: "",
            taskType: "one_shot",
            triggerRule: "立即执行",
            progress: 0,
            instances: [],
            executionKind: "generic_result",
            resultViewKind: "generic_result",
          },
        ],
      },
    ],
  };
}

export function runGoalSchedulerEngineSpecs() {
  ensureIsolatedPlanningSpecDataDir();
  const result = runGoalSchedulerEngine({
    goals: [goalWithoutConversationId()],
    runtimeEnv: runtimeEnv(),
    config: {
      deviceId: "device-scheduler-spec",
      name: "local",
      cliPath: "claude",
      workingDirectory: "/tmp",
      permissionMode: "execute",
      filePolicy: DEFAULT_RUNTIME_FILE_POLICY,
      autoStart: false,
      authorizedDirectories: ["/tmp"],
      schedulerIntervalMs: 60_000,
      heartbeatIntervalMs: 15_000,
      maxConcurrentTasks: 3,
      jobMaxDurationMs: 30 * 60_000,
      jobIdleTimeoutMs: 5 * 60_000,
      updatedAt: "2026-05-30T00:00:00.000Z",
    },
  });
  assert.equal(result.createdJobs, 0);
  assert.equal(result.skipped, 1);
}
