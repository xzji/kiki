import assert from "node:assert/strict";

import { deriveOpaqueId, normalizeTaskId } from "@/lib/opaqueIds";
import {
  listOpenRuntimeJobsByTaskIds,
  upsertRuntimeJob,
} from "@/lib/server/repositories/runtimeJobsRepository";
import type { RuntimeJobRecord } from "@/lib/server/repositories/runtimeJobsRepository";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import { readGoalsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { runGoalSchedulerEngine } from "@/lib/server/scheduling/taskScheduler";
import { writeGoalsProjection } from "@/lib/server/services/goalRuntimeService";
import { resolveAdmitDecision } from "@/lib/server/taskExecution/contextResolver";
import { startTaskAttempt } from "@/lib/server/taskExecution/startTaskAttempt";
import type { RuntimeDaemonConfig } from "@/lib/daemon/daemonConfig";
import type { Goal, Task, TaskInstance } from "@/types/kiki";
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

// 回归：上游任务的 runtime_job 已 completed，但 goals 快照里的实例仍停留在 pending
// （job→snapshot 投影滞后）。调度器必须以 runtime_jobs 为权威（compose）判依赖，
// 否则下游会被永久误判为「等待上游」而卡死。
const DESYNC_GOAL_ID = deriveOpaqueId("goal", "goal-scheduler-desync-spec");
const DESYNC_UPSTREAM_TASK_ID = deriveOpaqueId("task", "task-desync-upstream-spec");
const DESYNC_UPSTREAM_INSTANCE_ID = deriveOpaqueId("inst", "inst-desync-upstream-spec");
const DESYNC_DOWNSTREAM_TASK_ID = deriveOpaqueId("task", "task-desync-downstream-spec");
const DIRECT_DESYNC_GOAL_ID = deriveOpaqueId("goal", "goal-start-attempt-desync-spec");
const DIRECT_DESYNC_UPSTREAM_TASK_ID = deriveOpaqueId("task", "task-start-attempt-desync-upstream-spec");
const DIRECT_DESYNC_UPSTREAM_INSTANCE_ID = deriveOpaqueId("inst", "inst-start-attempt-desync-upstream-spec");
const DIRECT_DESYNC_DOWNSTREAM_TASK_ID = deriveOpaqueId("task", "task-start-attempt-desync-downstream-spec");

function desyncUpstreamInstance(input: {
  upstreamTaskId: string;
  upstreamInstanceId: string;
}): TaskInstance {
  const now = "2026-05-30T00:00:00.000Z";
  return {
    id: input.upstreamInstanceId,
    taskId: input.upstreamTaskId,
    dateLabel: "05-30",
    status: "pending",
    intro: "等待执行",
    payload: { kind: "generic_result", summary: "等待执行" },
    createdAt: now,
    execution: { phase: "queued", status: "pending", lastUpdatedAt: now },
  };
}

function goalWithDesyncedUpstream(input = {
  goalId: DESYNC_GOAL_ID,
  upstreamTaskId: DESYNC_UPSTREAM_TASK_ID,
  upstreamInstanceId: DESYNC_UPSTREAM_INSTANCE_ID,
  downstreamTaskId: DESYNC_DOWNSTREAM_TASK_ID,
}): Goal {
  const now = "2026-05-30T00:00:00.000Z";
  return {
    id: input.goalId,
    title: "投影滞后目标",
    deadline: "2026-05-30T00:00:00.000Z",
    progress: 0,
    createdAt: now,
    conversationId: "conversation-scheduler-desync-spec",
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: now,
      updatedAt: now,
    },
    subGoals: [
      {
        id: "sub-desync-upstream-spec",
        goalId: input.goalId,
        title: "上游板块",
        tasks: [
          oneShotTask(input.upstreamTaskId, "sub-desync-upstream-spec", "上游产出", {
            instances: [desyncUpstreamInstance({
              upstreamTaskId: input.upstreamTaskId,
              upstreamInstanceId: input.upstreamInstanceId,
            })],
          }),
        ],
      },
      {
        id: "sub-desync-downstream-spec",
        goalId: input.goalId,
        title: "下游板块",
        dependencies: ["sub-desync-upstream-spec"],
        tasks: [oneShotTask(input.downstreamTaskId, "sub-desync-downstream-spec", "下游执行")],
      },
    ],
  };
}

function seedCompletedUpstreamJob(goal: Goal): void {
  const now = "2026-05-30T00:01:00.000Z";
  const upstreamSubGoal = goal.subGoals[0]!;
  const upstreamTask = upstreamSubGoal.tasks[0]!;
  const upstreamInstance = upstreamTask.instances[0]!;
  const job: RuntimeJobRecord = {
    id: `job-${upstreamInstance.id}`,
    taskInstanceId: upstreamInstance.id,
    taskId: upstreamTask.id,
    goalId: goal.id,
    conversationId: goal.conversationId,
    userId: "user-scheduler-desync-spec",
    kind: "goal_task",
    status: "completed",
    requestId: "req-scheduler-desync-spec",
    runtimeTransport: "cloud_control_plane",
    payload: {
      goal,
      subGoal: upstreamSubGoal,
      task: upstreamTask,
      instance: upstreamInstance,
      runtimeEnv: runtimeEnv(),
    },
    progress: null,
    logs: [],
    trajectory: [],
    blocker: null,
    result: { finalMessage: "上游已完成" },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: now,
  };
  upsertRuntimeJob(job);
}

function persistRawGoal(goal: Goal) {
  const nextGoals = [
    goal,
    ...readGoalsSnapshot([]).filter((candidate) => candidate.id !== goal.id),
  ];
  const result = writeGoalsProjection(nextGoals);
  assert.equal(result.ok, true);
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
    dispatchPaused: false,
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

  // 回归：上游 job=completed 但持久化 raw 快照实例=pending 时，调度器应放行下游。
  // 这覆盖生产故障：scheduler 预筛使用 composed goals 判定 ready，但 startTaskAttempt
  // 过去会重新裸读 raw snapshot 做二次准入，导致下游在真正建 job 前被 blocked_config 拦下。
  const desyncGoal = goalWithDesyncedUpstream();
  persistRawGoal(desyncGoal);
  seedCompletedUpstreamJob(desyncGoal);
  const desyncResult = runGoalSchedulerEngine({
    goals: readGoalsSnapshot([]),
    runtimeEnv: runtimeEnv(),
    config: schedulerConfig(),
  });
  // 上游已有 instance 不再重跑，下游应被入队。
  assert.equal(desyncResult.createdJobs, 1);
  const downstreamOpenJobs = listOpenRuntimeJobsByTaskIds([DESYNC_DOWNSTREAM_TASK_ID]).filter(
    (job) => job.taskId && normalizeTaskId(job.taskId) === normalizeTaskId(DESYNC_DOWNSTREAM_TASK_ID),
  );
  assert.equal(downstreamOpenJobs.length, 1, "downstream task should be queued once upstream job completed");

  const directDesyncGoal = goalWithDesyncedUpstream({
    goalId: DIRECT_DESYNC_GOAL_ID,
    upstreamTaskId: DIRECT_DESYNC_UPSTREAM_TASK_ID,
    upstreamInstanceId: DIRECT_DESYNC_UPSTREAM_INSTANCE_ID,
    downstreamTaskId: DIRECT_DESYNC_DOWNSTREAM_TASK_ID,
  });
  persistRawGoal(directDesyncGoal);
  seedCompletedUpstreamJob(directDesyncGoal);
  const directSubGoal = directDesyncGoal.subGoals[1]!;
  const directTask = directSubGoal.tasks[0]!;
  const directAttempt = startTaskAttempt({
    goal: directDesyncGoal,
    subGoal: directSubGoal,
    task: directTask,
    runtimeEnv: runtimeEnv(),
    triggerSource: "scheduler",
    requestId: "req-start-attempt-desync-spec",
  });
  assert.equal(directAttempt.outcome, "queued", "startTaskAttempt should compose runtime job state before admit");
}
