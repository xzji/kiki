import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  readGoalsSnapshot,
  readGoalsSnapshotMeta,
  upsertGoalsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
import { readComposedGoalsSnapshotMeta } from "@/lib/server/runtime/instanceComposition";
import { deriveOpaqueId } from "@/lib/opaqueIds";
import { getGoalEventsSince } from "@/lib/server/repositories/goalEventLogRepository";
import {
  backfillTaskNotificationStatesFromGoals,
  getTaskNotificationStateByInstanceId,
  markTaskNotificationDeliveredState,
} from "@/lib/server/repositories/taskNotificationStateRepository";
import { upsertRuntimeJob } from "@/lib/server/repositories/runtimeJobsRepository";
import type { RuntimeJobRecord, RuntimeJobStatus } from "@/lib/server/repositories/runtimeJobsRepository";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { Goal, TaskResultNotificationDecision } from "@/types/kiki";
import type { GoalServerProgress } from "@/types/goalTelemetry";
import type { RuntimeEnvironment } from "@/types/runtime";

import {
  mutateGoalsProjection,
  projectRuntimeJobStatusProjection,
  transitionTaskInstanceProjection,
  updateGoalRuntimeJobExecution,
} from "./goalRuntimeService";

const GOAL_ID = deriveOpaqueId("goal", "goal-runtime-service-spec");
const PROJECTION_GOAL_ID = deriveOpaqueId("goal", "goal-runtime-projection-spec");
const PROJECTION_SUB_GOAL_ID = deriveOpaqueId("sg", "goal-runtime-projection-spec");
const PROJECTION_TASK_ID = deriveOpaqueId("task", "goal-runtime-projection-spec");
const PROJECTION_INSTANCE_ID = deriveOpaqueId("inst", "goal-runtime-projection-spec");

function seedGoals(goals: Goal[]) {
  const meta = readGoalsSnapshotMeta([]);
  const first = upsertGoalsSnapshot(goals, meta.revision);
  if (first.ok) return;
  const retry = upsertGoalsSnapshot(goals, first.revision);
  assert.equal(retry.ok, true, "seed goals ok");
}

function buildGoal(): Goal {
  return {
    id: GOAL_ID,
    title: "初始目标",
    deadline: "",
    progress: 0,
    createdAt: "2026-06-03T00:00:00.000Z",
    subGoals: [],
  };
}

function runtimeEnv(): RuntimeEnvironment {
  return {
    id: "runtime-goal-projection-spec",
    type: "local",
    name: "local",
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "execute",
  };
}

function buildProjectionGoal(): Goal {
  const now = "2026-06-03T00:00:00.000Z";
  return {
    id: PROJECTION_GOAL_ID,
    title: "投影目标",
    deadline: "",
    progress: 0,
    conversationId: "conv-goal-runtime-projection-spec",
    createdAt: now,
    subGoals: [
      {
        id: PROJECTION_SUB_GOAL_ID,
        goalId: PROJECTION_GOAL_ID,
        title: "投影子目标",
        tasks: [
          {
            id: PROJECTION_TASK_ID,
            subGoalId: PROJECTION_SUB_GOAL_ID,
            title: "投影任务",
            description: "",
            expectedOutcome: "",
            taskType: "one_shot",
            triggerRule: "立即执行",
            progress: 0,
            executionKind: "generic_result",
            resultViewKind: "generic_result",
            instances: [
              {
                id: PROJECTION_INSTANCE_ID,
                taskId: PROJECTION_TASK_ID,
                dateLabel: "06-03",
                status: "pending",
                intro: "等待执行",
                payload: {
                  kind: "generic_result",
                  summary: "等待执行",
                },
                createdAt: now,
                execution: {
                  phase: "queued",
                  status: "pending",
                  lastUpdatedAt: now,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildAwaitingProjectionGoal(): Goal {
  const goal = buildProjectionGoal();
  const blocker: ExecutionBlocker = {
    executionId: "request-goal-runtime-projection-spec",
    taskId: PROJECTION_TASK_ID,
    instanceId: PROJECTION_INSTANCE_ID,
    blockedStepIndex: 0,
    resumeToken: "resume-goal-runtime-projection-spec",
    interactionRequirement: {
      type: "answer",
      timing: "during_execution",
      reason: "等待用户补充信息",
      suggestedActions: ["补充信息"],
      shouldNotifyUser: true,
    },
    resumeStrategy: "rerun_with_feedback",
    status: "waiting",
    createdAt: "2026-06-03T00:00:00.000Z",
  };
  return {
    ...goal,
    subGoals: goal.subGoals.map((subGoal) => ({
      ...subGoal,
      tasks: subGoal.tasks.map((task) => ({
        ...task,
        instances: task.instances.map((instance) => ({
          ...instance,
          status: "awaiting_user",
          awaitingUser: {
            reason: "等待用户补充信息",
            blocker,
          },
          blocker,
          execution: {
            ...instance.execution,
            phase: "awaiting_user",
            status: "awaiting_user",
            waitingReason: "等待用户补充信息",
          },
        })),
      })),
    })),
  };
}

function projectionJob(status: RuntimeJobStatus): RuntimeJobRecord {
  const goal = buildProjectionGoal();
  const subGoal = goal.subGoals[0]!;
  const task = subGoal.tasks[0]!;
  const instance = task.instances[0]!;
  const statusSecond: Record<RuntimeJobStatus, string> = {
    queued: "01",
    running: "02",
    awaiting_user: "03",
    completed: "04",
    failed: "05",
    cancelled: "06",
  };
  return {
    id: `job-${PROJECTION_INSTANCE_ID}`,
    taskInstanceId: PROJECTION_INSTANCE_ID,
    taskId: PROJECTION_TASK_ID,
    goalId: PROJECTION_GOAL_ID,
    conversationId: goal.conversationId,
    userId: "local-user",
    kind: "goal_task",
    status,
    requestId: "request-goal-runtime-projection-spec",
    runtimeEnvId: runtimeEnv().id,
    runtimeTransport: "local_daemon",
    payload: {
      goal,
      subGoal,
      task,
      instance,
      runtimeEnv: runtimeEnv(),
    },
    progress: null,
    logs: [],
    trajectory: [],
    blocker: null,
    result: null,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: `2026-06-03T00:00:${statusSecond[status]}.000Z`,
  };
}

function getProjectionInstance() {
  const goal = readGoalsSnapshot([]).find((item) => item.id === PROJECTION_GOAL_ID);
  return goal?.subGoals[0]?.tasks[0]?.instances[0];
}

function awaitingProgress(): GoalServerProgress {
  return {
    requestId: "request-goal-runtime-projection-spec",
    scope: "goal_task_execute",
    status: "completed",
    phase: "executing",
    message: "等待用户补充信息",
    startedAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:03.000Z",
    goalId: PROJECTION_GOAL_ID,
    taskId: PROJECTION_TASK_ID,
    taskInstanceId: PROJECTION_INSTANCE_ID,
    resultPayload: {
      awaitingUser: true,
      awaitingReason: "等待用户补充信息",
      interactionRequirement: {
        type: "answer",
        timing: "during_execution",
        reason: "等待用户补充信息",
        suggestedActions: ["补充信息"],
        shouldNotifyUser: true,
      },
      suggestedActions: ["补充信息"],
    },
  };
}

function resultReadyDecision(): TaskResultNotificationDecision {
  return {
    shouldNotify: true,
    channel: "conversation",
    notificationType: "result_ready",
    priority: "normal",
    reason: "任务完成并产出了值得查看的结果。",
    title: "任务已完成",
    snippet: "任务已完成。",
    userMessage: "任务已完成，点击卡片查看结果。",
    badge: null,
    resultSummary: {
      headline: "任务已完成",
      keyPoints: ["已生成结果"],
      nextActions: ["查看结果"],
    },
    detailPolicy: {
      showTimelineByDefault: false,
      showRawOutputBehindMore: true,
      showArtifactsExpanded: true,
    },
    createdAt: "2026-06-03T00:00:04.000Z",
  };
}

function completedProgress(): GoalServerProgress {
  return {
    requestId: "request-goal-runtime-projection-spec",
    scope: "goal_task_execute",
    status: "completed",
    phase: "completed",
    message: "任务执行完成",
    startedAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:04.000Z",
    finishedAt: "2026-06-03T00:00:04.000Z",
    goalId: PROJECTION_GOAL_ID,
    taskId: PROJECTION_TASK_ID,
    taskInstanceId: PROJECTION_INSTANCE_ID,
    resultPayload: {
      awaitingUser: false,
      finalMessage: "任务已完成。",
      notificationDecision: resultReadyDecision(),
    },
  };
}

export function runGoalRuntimeServiceSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  seedGoals([buildGoal()]);

  let injectedConflict = false;
  const nextGoals = mutateGoalsProjection((goals) => {
    if (!injectedConflict) {
      injectedConflict = true;
      const concurrentMeta = readGoalsSnapshotMeta([]);
      const concurrentGoals = concurrentMeta.value.map((goal) =>
        goal.id === GOAL_ID
          ? { ...goal, title: "并发写入已保留" }
          : goal,
      );
      const write = upsertGoalsSnapshot(concurrentGoals, concurrentMeta.revision);
      assert.equal(write.ok, true, "inject concurrent write");
    }
    return goals.map((goal) =>
      goal.id === GOAL_ID
        ? { ...goal, progress: 42 }
        : goal,
    );
  });

  const stored = readGoalsSnapshot([]).find((goal) => goal.id === GOAL_ID);
  const returned = nextGoals.find((goal) => goal.id === GOAL_ID);
  assert.equal(injectedConflict, true, "conflict injected");
  assert.equal(stored?.title, "并发写入已保留");
  assert.equal(stored?.progress, 42);
  assert.equal(returned?.title, "并发写入已保留");
  assert.equal(returned?.progress, 42);

  seedGoals([buildGoal(), buildProjectionGoal()]);
  const running = projectRuntimeJobStatusProjection({
    job: projectionJob("running"),
    status: "running",
    reason: "spec running",
  });
  assert.equal(running.previousStatus, "pending");
  assert.equal(running.nextStatus, "in_progress");
  assert.equal(getProjectionInstance()?.status, "pending", "status is no longer projected into goals snapshot");

  const queued = projectRuntimeJobStatusProjection({
    job: projectionJob("queued"),
    status: "queued",
    reason: "spec queued",
  });
  assert.equal(queued.previousStatus, "pending");
  assert.equal(queued.nextStatus, "pending");
  assert.equal(getProjectionInstance()?.status, "pending");

  const failed = projectRuntimeJobStatusProjection({
    job: projectionJob("failed"),
    status: "failed",
    reason: "spec failed",
  });
  assert.equal(failed.previousStatus, "pending");
  assert.equal(failed.nextStatus, "error");
  assert.equal(getProjectionInstance()?.status, "pending", "failed status is derived from runtime_jobs at read time");

  const statusEvents = getGoalEventsSince({ fromId: 0, limit: 500 }).filter(
    (event) =>
      event.goalId === PROJECTION_GOAL_ID &&
      event.instanceId === PROJECTION_INSTANCE_ID &&
      event.kind === "instance.status_changed",
  );
  assert.ok(statusEvents.some((event) => (event.payload as { nextStatus?: unknown }).nextStatus === "in_progress"));
  // queued 投影时 previousStatus===nextStatus==="pending"，shouldEmit=false 不发事件，故此处不应断言存在 pending 事件。
  assert.ok(statusEvents.some((event) => (event.payload as { nextStatus?: unknown }).nextStatus === "error"));

  seedGoals([buildGoal(), buildAwaitingProjectionGoal()]);
  const requeued = projectRuntimeJobStatusProjection({
    job: projectionJob("queued"),
    status: "queued",
    reason: "spec requeued",
  });
  const requeuedInstance = getProjectionInstance();
  assert.equal(requeued.previousStatus, "awaiting_user");
  assert.equal(requeued.nextStatus, "pending");
  assert.equal(requeuedInstance?.status, "awaiting_user", "requeue no longer mutates goals snapshot");
  assert.notEqual(requeuedInstance?.awaitingUser, undefined);
  assert.notEqual(requeuedInstance?.blocker, undefined);
  assert.equal(requeuedInstance?.execution?.waitingReason, "等待用户补充信息");

  seedGoals([buildGoal(), buildProjectionGoal()]);
  const pausedJob = {
    ...projectionJob("cancelled"),
    lastError: "用户暂停任务执行",
    finishedAt: "2026-06-03T00:00:06.000Z",
  };
  upsertRuntimeJob(pausedJob);
  transitionTaskInstanceProjection({
    goals: readGoalsSnapshot([]),
    taskId: PROJECTION_TASK_ID,
    instanceId: PROJECTION_INSTANCE_ID,
    status: "terminated",
    reason: "用户终止任务执行",
  });
  const terminatedComposedInstance = readComposedGoalsSnapshotMeta([])
    .value.find((goal) => goal.id === PROJECTION_GOAL_ID)
    ?.subGoals[0]?.tasks[0]?.instances[0];
  assert.equal(
    terminatedComposedInstance?.status,
    "terminated",
    "terminated snapshot must not be overwritten by an older paused cancelled runtime job",
  );

  seedGoals([buildGoal(), buildAwaitingProjectionGoal()]);
  const backfilled = backfillTaskNotificationStatesFromGoals(readGoalsSnapshot([]));
  assert.equal(backfilled.changed, 1);
  const backfilledNotification = getTaskNotificationStateByInstanceId(PROJECTION_INSTANCE_ID);
  assert.equal(backfilledNotification?.notification.deliveryState, "pending");
  assert.equal(backfilledNotification?.notification.notificationType, "answer_required");

  const awaitingJob = projectionJob("running");
  upsertRuntimeJob(awaitingJob);
  updateGoalRuntimeJobExecution(awaitingJob.id, {
    status: "awaiting_user",
    progress: awaitingProgress(),
    result: awaitingProgress().resultPayload,
  });
  const awaitingNotification = getTaskNotificationStateByInstanceId(PROJECTION_INSTANCE_ID);
  assert.equal(awaitingNotification?.notification.deliveryState, "pending");
  assert.equal(awaitingNotification?.notification.notificationType, "answer_required");
  assert.equal(awaitingNotification?.notification.channel, "both");

  markTaskNotificationDeliveredState({
    instanceId: PROJECTION_INSTANCE_ID,
    conversationMessageId: "msg-task-runtime-projection-n1",
    notificationSequence: 1,
  });
  updateGoalRuntimeJobExecution(awaitingJob.id, {
    status: "completed",
    progress: completedProgress(),
    result: completedProgress().resultPayload,
    finishedAt: "2026-06-03T00:00:04.000Z",
  });
  const completedNotification = getTaskNotificationStateByInstanceId(PROJECTION_INSTANCE_ID);
  assert.equal(completedNotification?.notification.deliveryState, "pending");
  assert.equal(completedNotification?.notification.notificationType, "result_ready");
  assert.equal(completedNotification?.notification.notificationSequence, 1);
  assert.deepEqual(completedNotification?.notification.pushedConversationMessageIds, ["msg-task-runtime-projection-n1"]);
}
