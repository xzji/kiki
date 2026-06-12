import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  getRuntimeJob,
  upsertRuntimeJob,
  type RuntimeJobRecord,
} from "@/lib/server/repositories/runtimeJobsRepository";
import { dispatchReadyTasksToMachines } from "@/lib/server/scheduling/taskDispatcher";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

function runtimeEnv(): RuntimeEnvironment {
  return {
    id: "runtime-task-dispatcher-spec",
    type: "local",
    name: "local",
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "execute",
  };
}

function payloadParts() {
  const instance: TaskInstance = {
    id: "inst-task-dispatcher-spec",
    taskId: "task-task-dispatcher-spec",
    dateLabel: "2026-06-12",
    status: "pending",
    intro: "测试任务",
    payload: { kind: "generic_result", summary: "" },
    createdAt: "2026-06-12T00:00:00.000Z",
  };
  const task: Task = {
    id: "task-task-dispatcher-spec",
    subGoalId: "sub-task-dispatcher-spec",
    title: "测试调度下发",
    description: "",
    expectedOutcome: "",
    taskType: "one_shot",
    triggerRule: "立即触发",
    progress: 0,
    instances: [instance],
    executionKind: "generic_result",
  };
  const subGoal: SubGoal = {
    id: "sub-task-dispatcher-spec",
    goalId: "goal-task-dispatcher-spec",
    title: "子目标",
    tasks: [task],
  };
  const goal: Goal = {
    id: "goal-task-dispatcher-spec",
    title: "调度测试目标",
    conversationId: "conv-task-dispatcher-spec",
    deadline: "",
    progress: 0,
    createdAt: "2026-06-12T00:00:00.000Z",
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
    },
    subGoals: [subGoal],
  };
  return { goal, subGoal, task, instance };
}

function seedQueuedCloudJob(id: string) {
  const now = new Date().toISOString();
  const { goal, subGoal, task, instance } = payloadParts();
  const job: RuntimeJobRecord = {
    id,
    taskInstanceId: instance.id,
    taskId: task.id,
    goalId: goal.id,
    conversationId: goal.conversationId,
    userId: "spec-test-user",
    kind: "goal_task",
    status: "queued",
    requestId: `req-${id}`,
    runtimeEnvId: runtimeEnv().id,
    runtimeTransport: "cloud_control_plane",
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
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
  upsertRuntimeJob(job);
  return job;
}

export async function runTaskDispatcherSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  const job = seedQueuedCloudJob("job-task-dispatcher-no-machine");
  const result = await dispatchReadyTasksToMachines({
    leaseOwner: "cloud-orchestrator-spec",
    limit: 1,
  });

  assert.equal(result.processed, 0);
  assert.equal(result.skippedOffline, true);
  assert.equal(getRuntimeJob(job.id)?.status, "queued", "machine 离线时不应 claim queued job");

  console.log("taskDispatcher specs passed");
}
