/**
 * dispatchPauseService 回归 spec —— 复现线上「2026国庆蜜月」重复执行 bug。
 *
 * 现象：一个 one_shot 任务在 6-15 已 completed（job=completed），用户 6-21 点了
 * 「暂停全部 → 恢复全部」，resume-all 把这个已完成实例又拉起，重建 blocker 重新追问。
 *
 * 根因：resumeAllTaskExecution.collectInstances 裸读 goals 投影里的实例 status，
 * 而投影可能滞后（实例显示 paused/pending，job 实则 completed），绕过了既有的
 * 「以 runtime_jobs 为权威」的统一读取入口 composeGoalsWithRuntimeJobs。
 *
 * 修复：collectInstances 改用 composeGoalsWithRuntimeJobs 读取（与 scheduler /
 * governance / feedback 链路统一）——completed job 会被合成为 status=completed，
 * 自然落在目标集之外；startTaskAttempt 另加 already_completed 护栏做纵深防御。
 * 本 spec 覆盖 resume-all 不再重跑已完成的一次性任务。
 */

import assert from "node:assert/strict";

import { deriveOpaqueId } from "@/lib/opaqueIds";
import type { RuntimeJobRecord } from "@/lib/server/repositories/runtimeJobsRepository";
import {
  getRuntimeJobByTaskInstanceId,
  upsertRuntimeJob,
} from "@/lib/server/repositories/runtimeJobsRepository";
import {
  upsertGoalsSnapshot,
  upsertRuntimeEnvironmentsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  pauseAllTaskExecution,
  resumeAllTaskExecution,
} from "@/lib/server/scheduling/dispatchPauseService";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Goal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

const GOAL_ID = deriveOpaqueId("goal", "goal-pause-resume-spec");
const TASK_ID = deriveOpaqueId("task", "task-pause-resume-spec");
const INSTANCE_ID = deriveOpaqueId("inst", "inst-pause-resume-spec");

function localRuntimeEnv(): RuntimeEnvironment {
  return {
    id: "runtime-pause-resume-spec",
    type: "local",
    name: "local",
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "execute",
    isDefault: true,
    health: { status: "online", cliPath: "claude" },
  };
}

/**
 * 投影滞后的已完成实例：status 仍是 paused（线上 bug 表现），但其 job 已 completed。
 */
function pausedButCompletedInstance(): TaskInstance {
  const now = "2026-06-15T03:43:14.000Z";
  return {
    id: INSTANCE_ID,
    taskId: TASK_ID,
    dateLabel: "06-15",
    status: "paused",
    intro: "采集蜜月核心偏好与约束",
    payload: { kind: "generic_result", summary: "已完成" },
    createdAt: now,
    execution: { phase: "completed", status: "completed", lastUpdatedAt: now },
  };
}

function oneShotTask(): Task {
  return {
    id: TASK_ID,
    subGoalId: "sub-pause-resume-spec",
    title: "采集蜜月核心偏好与约束",
    description: "",
    expectedOutcome: "",
    taskType: "one_shot",
    triggerRule: "立即触发",
    progress: 0,
    instances: [pausedButCompletedInstance()],
    executionKind: "generic_result",
    resultViewKind: "generic_result",
  };
}

function goalWithCompletedOneShot(): Goal {
  const now = "2026-06-15T03:37:46.000Z";
  return {
    id: GOAL_ID,
    title: "2026国庆蜜月旅行规划与成行",
    deadline: "2026-10-01T00:00:00.000Z",
    progress: 0,
    createdAt: now,
    conversationId: "conversation-pause-resume-spec",
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: now,
      updatedAt: now,
    },
    subGoals: [
      {
        id: "sub-pause-resume-spec",
        goalId: GOAL_ID,
        title: "需求澄清与目的地决策",
        tasks: [oneShotTask()],
      },
    ],
  };
}

function seedCompletedJob(goal: Goal): void {
  const now = "2026-06-15T03:43:14.000Z";
  const subGoal = goal.subGoals[0]!;
  const task = subGoal.tasks[0]!;
  const instance = task.instances[0]!;
  const job: RuntimeJobRecord = {
    id: `job-${INSTANCE_ID}`,
    taskInstanceId: INSTANCE_ID,
    taskId: TASK_ID,
    goalId: GOAL_ID,
    conversationId: goal.conversationId,
    userId: "user-pause-resume-spec",
    kind: "goal_task",
    status: "completed",
    requestId: "req-pause-resume-spec",
    runtimeTransport: "cloud_control_plane",
    payload: {
      goal,
      subGoal,
      task,
      instance,
      runtimeEnv: localRuntimeEnv(),
    },
    progress: null,
    logs: [],
    trajectory: [],
    blocker: null,
    result: { finalMessage: "已产出《蜜月需求画像》" },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: now,
  };
  upsertRuntimeJob(job);
}

function runningInstance(): TaskInstance {
  const now = "2026-06-15T04:00:00.000Z";
  return {
    id: INSTANCE_ID,
    taskId: TASK_ID,
    dateLabel: "06-15",
    status: "in_progress",
    intro: "正在执行",
    payload: { kind: "generic_result", summary: "" },
    createdAt: now,
    execution: { phase: "running", status: "in_progress", lastUpdatedAt: now },
  };
}

function goalWithRunningTask(): Goal {
  const goal = goalWithCompletedOneShot();
  const task = goal.subGoals[0]!.tasks[0]!;
  goal.subGoals[0] = {
    ...goal.subGoals[0]!,
    tasks: [
      {
        ...task,
        instances: [runningInstance()],
      },
    ],
  };
  return goal;
}

function seedRunningJob(goal: Goal): void {
  const now = "2026-06-15T04:00:00.000Z";
  const subGoal = goal.subGoals[0]!;
  const task = subGoal.tasks[0]!;
  const instance = task.instances[0]!;
  const trajectory: ExecutionTrajectoryStep[] = [
    {
      id: "trajectory-pause-resume-spec-1",
      index: 0,
      type: "tool_call",
      status: "completed",
      title: "已完成初步搜索",
      toolCall: { name: "mcp__tavily__tavily_search", summary: "搜索目的地资料" },
      startedAt: now,
      endedAt: now,
    },
  ];
  const job: RuntimeJobRecord = {
    id: `job-${INSTANCE_ID}`,
    taskInstanceId: INSTANCE_ID,
    taskId: TASK_ID,
    goalId: GOAL_ID,
    conversationId: goal.conversationId,
    userId: "user-pause-resume-spec",
    kind: "goal_task",
    status: "running",
    requestId: "req-running-pause-resume-spec",
    runtimeTransport: "cloud_control_plane",
    payload: {
      goal,
      subGoal,
      task,
      instance,
      runtimeEnv: localRuntimeEnv(),
    },
    progress: {
      requestId: "req-running-pause-resume-spec",
      scope: "goal_task_execute",
      status: "running",
      phase: "executing",
      message: "已完成初步搜索，准备整理方案",
      startedAt: now,
      updatedAt: now,
      goalId: GOAL_ID,
      taskId: TASK_ID,
      taskInstanceId: INSTANCE_ID,
      resultPayload: { trajectory },
    },
    logs: [
      {
        id: "log-pause-resume-spec-1",
        timestamp: now,
        requestId: "req-running-pause-resume-spec",
        scope: "goal_task_execute",
        level: "info",
        phase: "executing",
        message: "搜索目的地资料完成",
        toolName: "mcp__tavily__tavily_search",
        status: "completed",
      },
    ],
    trajectory,
    blocker: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
  upsertRuntimeJob(job);
}

export function runDispatchPauseServiceSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  const goal = goalWithCompletedOneShot();
  upsertGoalsSnapshot([goal]);
  upsertRuntimeEnvironmentsSnapshot([localRuntimeEnv()]);
  seedCompletedJob(goal);

  // resume-all 必须把这个「投影=paused 但 job=completed」的一次性任务视为终态、不重跑。
  const result = resumeAllTaskExecution();
  assert.equal(result.resumedCount, 0, "已完成的一次性任务不应被 resume-all 重新拉起");

  // 权威 job 仍是 completed，未被 startTaskAttempt 重建为 awaiting_user/queued。
  // （修复前：resume-all → startTaskAttempt 会把 job 改写为 awaiting_user 并重新追问。）
  const jobAfter = getRuntimeJobByTaskInstanceId(INSTANCE_ID);
  assert.equal(jobAfter?.status, "completed", "已完成 job 的状态不应被 resume-all 改写");

  ensureIsolatedPlanningSpecDataDir();
  const runningGoal = goalWithRunningTask();
  upsertGoalsSnapshot([runningGoal]);
  upsertRuntimeEnvironmentsSnapshot([localRuntimeEnv()]);
  seedRunningJob(runningGoal);

  const pauseResult = pauseAllTaskExecution();
  assert.equal(pauseResult.pausedCount, 1, "运行中的任务应被 pause-all 暂停");
  const pausedJob = getRuntimeJobByTaskInstanceId(INSTANCE_ID);
  assert.equal(pausedJob?.status, "cancelled", "暂停后 runtime job 应进入 cancelled/paused 权威状态");
  assert.ok(pausedJob?.payload.resumeContext?.includes("用户暂停全部任务执行"), "暂停后应保存 resumeContext");
  assert.equal(pausedJob?.trajectory.length, 1, "暂停后应保留上一轮 trajectory");

  const resumeResult = resumeAllTaskExecution();
  assert.equal(resumeResult.resumedCount, 1, "paused job 应被 resume-all 重新入队");
  const resumedJob = getRuntimeJobByTaskInstanceId(INSTANCE_ID);
  assert.equal(resumedJob?.status, "queued", "恢复后 runtime job 应重新 queued");
  assert.ok(resumedJob?.payload.resumeContext?.includes("上下文继续"), "恢复后应继续携带 resumeContext");
  assert.equal(resumedJob?.trajectory.length, 1, "恢复后 queued job 应保留 checkpoint trajectory");
  assert.equal(
    (resumedJob?.result?.pauseResumeCheckpoint as { previousTrajectorySteps?: number } | undefined)
      ?.previousTrajectorySteps,
    1,
    "恢复后应保留 pauseResumeCheckpoint 元信息",
  );
}
