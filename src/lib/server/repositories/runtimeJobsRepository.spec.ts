import assert from "node:assert/strict";

import { deriveOpaqueId } from "@/lib/opaqueIds";
import { getDatabase } from "@/lib/server/db/client";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import type { Goal, Task, TaskInstance } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

import {
  getRuntimeJob,
  upsertRuntimeJob,
  type RuntimeJobRecord,
} from "./runtimeJobsRepository";

const TOPIC_ID = deriveOpaqueId("goal", "runtime-job-topic-spec");
const THREAD_ID = deriveOpaqueId("sg", "runtime-job-thread-spec");
const TASK_ID = deriveOpaqueId("task", "runtime-job-task-spec");
const INSTANCE_ID = deriveOpaqueId("inst", "runtime-job-instance-spec");

function runtimeEnv(): RuntimeEnvironment {
  return {
    id: "runtime-job-env-spec",
    type: "local",
    name: "local",
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "execute",
  };
}

function runtimeJobRecord(): RuntimeJobRecord {
  const now = "2026-06-10T00:00:00.000Z";
  const instance: TaskInstance = {
    id: INSTANCE_ID,
    taskId: TASK_ID,
    dateLabel: "06-10",
    status: "pending",
    intro: "等待执行",
    payload: { kind: "generic_result", summary: "等待执行" },
    createdAt: now,
  };
  const task: Task = {
    id: TASK_ID,
    subGoalId: THREAD_ID,
    title: "持久化 topic/thread",
    description: "",
    expectedOutcome: "",
    taskType: "one_shot",
    triggerRule: "立即执行",
    progress: 0,
    executionKind: "generic_result",
    resultViewKind: "generic_result",
    instances: [instance],
  };
  const goal: Goal = {
    id: TOPIC_ID,
    title: "Runtime Job 归属",
    deadline: "",
    progress: 0,
    conversationId: "conversation-runtime-job-spec",
    createdAt: now,
    subGoals: [
      {
        id: THREAD_ID,
        goalId: TOPIC_ID,
        title: "归属板块",
        tasks: [task],
      },
    ],
  };
  const subGoal = goal.subGoals[0]!;
  return {
    id: `job-${INSTANCE_ID}`,
    taskInstanceId: INSTANCE_ID,
    taskId: TASK_ID,
    goalId: TOPIC_ID,
    conversationId: goal.conversationId,
    userId: "spec-test-user",
    kind: "goal_task",
    status: "queued",
    requestId: "request-runtime-job-spec",
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
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export function runRuntimeJobsRepositorySpecs() {
  ensureIsolatedPlanningSpecDataDir();

  const record = runtimeJobRecord();
  upsertRuntimeJob(record);

  const row = getDatabase()
    .prepare("SELECT topic_id, thread_id FROM runtime_jobs WHERE id = ?")
    .get(record.id) as { topic_id: string | null; thread_id: string | null } | undefined;
  assert.equal(row?.topic_id, TOPIC_ID);
  assert.equal(row?.thread_id, THREAD_ID);

  const stored = getRuntimeJob(record.id);
  assert.equal(stored?.topicId, TOPIC_ID);
  assert.equal(stored?.threadId, THREAD_ID);
}
