import assert from "node:assert/strict";

import { deriveOpaqueId } from "@/lib/opaqueIds";
import {
  getRuntimeJobByTaskInstanceId,
  upsertRuntimeJob,
  type RuntimeJobRecord,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import type { ExecutionBlocker } from "@/types/executionBlocker";
import type { Goal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

import { resumeBlockedTask } from "./resumeBlockedTask";

const GOAL_ID = deriveOpaqueId("goal", "resume-blocked-terminal-spec");
const SUB_GOAL_ID = deriveOpaqueId("sg", "resume-blocked-terminal-spec");
const TASK_ID = deriveOpaqueId("task", "resume-blocked-terminal-spec");
const INSTANCE_ID = deriveOpaqueId("inst", "resume-blocked-terminal-spec");

function runtimeEnv(): RuntimeEnvironment {
  return {
    id: "runtime-resume-blocked-terminal-spec",
    type: "local",
    name: "local",
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "execute",
  };
}

function goalFixture(): { goal: Goal; task: Task; instance: TaskInstance } {
  const now = "2026-06-21T00:00:00.000Z";
  const instance: TaskInstance = {
    id: INSTANCE_ID,
    taskId: TASK_ID,
    dateLabel: "06-21",
    status: "completed",
    intro: "已完成实例",
    payload: { kind: "generic_result", summary: "已完成" },
    createdAt: now,
    execution: { phase: "completed", status: "completed", lastUpdatedAt: now },
  };
  const task: Task = {
    id: TASK_ID,
    subGoalId: SUB_GOAL_ID,
    title: "等待用户后完成的任务",
    description: "",
    expectedOutcome: "",
    taskType: "one_shot",
    triggerRule: "立即执行",
    progress: 100,
    executionKind: "generic_result",
    resultViewKind: "generic_result",
    instances: [instance],
  };
  const goal: Goal = {
    id: GOAL_ID,
    title: "终态恢复护栏",
    deadline: "",
    progress: 100,
    createdAt: now,
    subGoals: [
      {
        id: SUB_GOAL_ID,
        goalId: GOAL_ID,
        title: "子目标",
        tasks: [task],
      },
    ],
  };
  return { goal, task, instance };
}

function blocker(): ExecutionBlocker {
  return {
    executionId: "request-resume-blocked-terminal-spec",
    taskId: TASK_ID,
    instanceId: INSTANCE_ID,
    blockedStepIndex: 0,
    resumeToken: "resume-token-terminal-spec",
    interactionRequirement: {
      type: "answer",
      timing: "during_execution",
      reason: "等待用户补充",
      suggestedActions: ["补充"],
      shouldNotifyUser: true,
    },
    resumeStrategy: "rerun_with_feedback",
    status: "waiting",
    createdAt: "2026-06-21T00:00:01.000Z",
  };
}

export async function runResumeBlockedTaskSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  const { goal, task, instance } = goalFixture();
  const job: RuntimeJobRecord = {
    id: `job-${INSTANCE_ID}`,
    taskInstanceId: INSTANCE_ID,
    taskId: TASK_ID,
    goalId: GOAL_ID,
    userId: "resume-blocked-terminal-spec",
    kind: "goal_task",
    status: "completed",
    requestId: "request-resume-blocked-terminal-spec",
    runtimeEnvId: runtimeEnv().id,
    runtimeTransport: "local_daemon",
    payload: {
      goal,
      subGoal: goal.subGoals[0]!,
      task,
      instance,
      runtimeEnv: runtimeEnv(),
    },
    progress: null,
    logs: [],
    trajectory: [],
    blocker: blocker(),
    result: { finalMessage: "已经完成" },
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:02.000Z",
    startedAt: "2026-06-21T00:00:00.000Z",
    finishedAt: "2026-06-21T00:00:02.000Z",
  };
  upsertRuntimeJob(job);

  const result = await resumeBlockedTask({
    taskInstanceId: INSTANCE_ID,
    resumeToken: "resume-token-terminal-spec",
    approved: true,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.completed, true);
  assert.equal(result.body.alreadyResumed, true);
  assert.equal(result.body.resumed, false);
  assert.equal(getRuntimeJobByTaskInstanceId(INSTANCE_ID)?.status, "completed");
}
