import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { runGoalSchedulerEngine } from "@/lib/server/scheduling/taskScheduler";
import { resolveAdmitDecision } from "@/lib/server/taskExecution/contextResolver";
import type { RuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import type { Goal, Task } from "@/types/kiki";
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

function goalWithBlockedDownstreamThread(): Goal {
  return {
    id: "goal-scheduler-dependency-spec",
    title: "依赖预过滤目标",
    deadline: "2026-05-30T00:00:00.000Z",
    progress: 0,
    createdAt: "2026-05-30T00:00:00.000Z",
    conversationId: "conversation-scheduler-dependency-spec",
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    },
    subGoals: [
      {
        id: "sub-upstream-scheduler-spec",
        goalId: "goal-scheduler-dependency-spec",
        title: "上游板块",
        tasks: [
          {
            id: "task-upstream-scheduler-spec",
            subGoalId: "sub-upstream-scheduler-spec",
            title: "上游产出",
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
      {
        id: "sub-downstream-scheduler-spec",
        goalId: "goal-scheduler-dependency-spec",
        title: "下游板块",
        dependencies: ["sub-upstream-scheduler-spec"],
        tasks: [
          {
            id: "task-downstream-scheduler-spec",
            subGoalId: "sub-downstream-scheduler-spec",
            title: "下游执行",
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

function oneShotTask(id: string, subGoalId: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    subGoalId,
    title,
    description: "",
    expectedOutcome: "",
    taskType: "one_shot",
    triggerRule: "立即执行",
    progress: 0,
    instances: [],
    executionKind: "generic_result",
    resultViewKind: "generic_result",
    ...extra,
  };
}

function repeatMonitoringTask(id: string, subGoalId: string, title: string): Task {
  return {
    ...oneShotTask(id, subGoalId, title, {
      taskType: "repeat",
      executionMode: "monitoring",
      triggerRule: "每小时巡检",
    }),
  };
}

function goalWithImmediateDependencyFanout(): Goal {
  const goalId = "goal-scheduler-fanout-spec";
  return {
    id: goalId,
    title: "立即任务依赖扇出",
    deadline: "2026-05-30T00:00:00.000Z",
    progress: 0,
    createdAt: "2026-05-30T00:00:00.000Z",
    conversationId: "conversation-scheduler-fanout-spec",
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    },
    subGoals: [
      {
        id: "sub-fanout-upstream-spec",
        goalId,
        title: "用户偏好收集",
        tasks: [oneShotTask("task-fanout-upstream-spec", "sub-fanout-upstream-spec", "收集偏好")],
      },
      {
        id: "sub-fanout-story-spec",
        goalId,
        title: "剧情",
        dependencies: ["sub-fanout-upstream-spec"],
        tasks: [oneShotTask("task-fanout-story-spec", "sub-fanout-story-spec", "写剧情")],
      },
      {
        id: "sub-fanout-ai-spec",
        goalId,
        title: "AI 机制",
        dependencies: ["sub-fanout-upstream-spec"],
        tasks: [oneShotTask("task-fanout-ai-spec", "sub-fanout-ai-spec", "设计 AI 机制")],
      },
    ],
  };
}

function goalWithMonitoringOnlyUpstream(): Goal {
  const goalId = "goal-scheduler-monitoring-spec";
  return {
    id: goalId,
    title: "监控不阻塞下游",
    deadline: "2026-05-30T00:00:00.000Z",
    progress: 0,
    createdAt: "2026-05-30T00:00:00.000Z",
    conversationId: "conversation-scheduler-monitoring-spec",
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    },
    subGoals: [
      {
        id: "sub-monitoring-upstream-spec",
        goalId,
        title: "持续观察",
        tasks: [repeatMonitoringTask("task-monitoring-upstream-spec", "sub-monitoring-upstream-spec", "持续监控")],
      },
      {
        id: "sub-monitoring-downstream-spec",
        goalId,
        title: "一次性交付",
        dependencies: ["sub-monitoring-upstream-spec"],
        tasks: [oneShotTask("task-monitoring-downstream-spec", "sub-monitoring-downstream-spec", "生成一次性交付")],
      },
    ],
  };
}

function schedulerConfig(): RuntimeDaemonConfig {
  return {
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
  };
}

export function runGoalSchedulerEngineSpecs() {
  ensureIsolatedPlanningSpecDataDir();
  const result = runGoalSchedulerEngine({
    goals: [goalWithoutConversationId()],
    runtimeEnv: runtimeEnv(),
    config: schedulerConfig(),
  });
  assert.equal(result.createdJobs, 0);
  assert.equal(result.skipped, 1);

  const dependencyGoal = goalWithBlockedDownstreamThread();
  const dependencyResult = runGoalSchedulerEngine({
    goals: [dependencyGoal],
    runtimeEnv: runtimeEnv(),
    config: schedulerConfig(),
  });
  assert.equal(dependencyResult.createdJobs, 1);
  assert.equal(dependencyResult.skipped, 1);
  assert.equal(dependencyGoal.subGoals[1]?.tasks[0]?.autoRunDisabled, undefined);

  const blockedSubGoal = dependencyGoal.subGoals[1]!;
  const blockedTask = blockedSubGoal.tasks[0]!;
  assert.deepEqual(blockedTask.dependencies ?? [], []);
  const admitDecision = resolveAdmitDecision({
    conversationId: dependencyGoal.conversationId!,
    goal: dependencyGoal,
    subGoal: blockedSubGoal,
    task: blockedTask,
  });
  assert.equal(admitDecision.readiness.state, "blocked");
  assert.equal(
    admitDecision.readiness.blockers.some((blocker) => blocker.id === "subgoal-dep:sub-upstream-scheduler-spec"),
    true,
  );

  const fanoutResult = runGoalSchedulerEngine({
    goals: [goalWithImmediateDependencyFanout()],
    runtimeEnv: runtimeEnv(),
    config: schedulerConfig(),
  });
  assert.equal(fanoutResult.createdJobs, 1);
  assert.equal(fanoutResult.skipped, 2);

  const monitoringGoal = goalWithMonitoringOnlyUpstream();
  const monitoringSubGoal = monitoringGoal.subGoals[1]!;
  const monitoringTask = monitoringSubGoal.tasks[0]!;
  const monitoringDecision = resolveAdmitDecision({
    conversationId: monitoringGoal.conversationId!,
    goal: monitoringGoal,
    subGoal: monitoringSubGoal,
    task: monitoringTask,
  });
  assert.equal(monitoringDecision.readiness.state, "ready");

  const monitoringResult = runGoalSchedulerEngine({
    goals: [monitoringGoal],
    runtimeEnv: runtimeEnv(),
    config: schedulerConfig(),
  });
  assert.equal(monitoringResult.createdJobs, 2);
  assert.equal(monitoringResult.skipped, 0);
}
