import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  readGoalsSnapshot,
  readGoalsSnapshotMeta,
  readRuntimeEnvironmentsSnapshotMeta,
  upsertGoalsSnapshot,
  upsertRuntimeEnvironmentsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
import { runOrchestratorUserFrame } from "@/lib/server/orchestrator/runOrchestratorUserFrame";
import {
  listUsersForOrchestratorTick,
  listUsersWithPendingWork,
} from "@/lib/server/orchestrator/listUsersWithPendingWork";
import { runWithUserContext } from "@/lib/server/context/userContext";
import { getRegistryDatabase } from "@/lib/server/db/registryClient";
import { appendGovernanceEvent } from "@/lib/server/repositories/governanceEventOutboxRepository";
import { createGovernanceTickJob } from "@/lib/server/repositories/governanceTickJobsRepository";
import { getRuntimeJobByTaskInstanceId } from "@/lib/server/repositories/runtimeJobsRepository";
import type { OrchestratorConfig } from "@/lib/server/orchestrator/orchestratorConfig";
import type { Goal } from "@/types/kiki";
import type { RuntimeEnvironment } from "@/types/runtime";

function runtimeEnv(): RuntimeEnvironment {
  return {
    id: "runtime-orchestrator-frame-spec",
    type: "local",
    name: "local",
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "execute",
  };
}

function goal(): Goal {
  return {
    id: "goal-orchestrator-frame-spec",
    title: "编排帧测试目标",
    conversationId: "conv-orchestrator-frame-spec",
    deadline: "",
    progress: 0,
    createdAt: "2026-06-12T00:00:00.000Z",
    workflow: {
      phase: "executing",
      planDecision: "confirmed",
      startedAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
    },
    subGoals: [
      {
        id: "sub-orchestrator-frame-spec",
        goalId: "goal-orchestrator-frame-spec",
        title: "子目标",
        tasks: [
          {
            id: "task-orchestrator-frame-spec",
            subGoalId: "sub-orchestrator-frame-spec",
            title: "立即生成 runtime job",
            description: "",
            expectedOutcome: "",
            taskType: "one_shot",
            triggerRule: "立即触发",
            progress: 0,
            instances: [],
            executionKind: "generic_result",
          },
        ],
      },
    ],
  };
}

function upsertGoal(nextGoal: Goal) {
  const meta = readGoalsSnapshotMeta([]);
  const goals = [
    ...readGoalsSnapshot([]).filter((candidate) => candidate.id !== nextGoal.id),
    nextGoal,
  ];
  const result = upsertGoalsSnapshot(goals, meta.revision);
  assert.equal(result.ok, true);
}

function upsertRuntimeEnv(environment: RuntimeEnvironment) {
  const meta = readRuntimeEnvironmentsSnapshotMeta([]);
  const environments = [
    ...meta.value.filter((candidate) => candidate.id !== environment.id),
    environment,
  ];
  const result = upsertRuntimeEnvironmentsSnapshot(environments, meta.revision);
  assert.equal(result.ok, true);
}

function config(): OrchestratorConfig {
  return {
    executionMode: "cloud",
    maxConcurrentGlobal: 10,
    maxConcurrentPerUser: 3,
    schedulerIntervalMs: 60_000,
    reconcileIntervalMs: 30_000,
    tunnelPort: 3001,
    machineOnlineThresholdMs: 45_000,
  };
}

function upsertActiveRegistryUser(userId: string) {
  const now = new Date().toISOString();
  getRegistryDatabase()
    .prepare(
      `
        INSERT INTO users (id, email, password_hash, password_salt, display_name, status, created_at, updated_at)
        VALUES (?, ?, 'hash', 'salt', ?, 'active', ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at
      `,
    )
    .run(userId, `${userId}@example.test`, userId, now, now);
}

export async function runOrchestratorUserFrameSpecs() {
  ensureIsolatedPlanningSpecDataDir();
  const previousMode = process.env.KIKI_ORCHESTRATOR_MODE;
  process.env.KIKI_ORCHESTRATOR_MODE = "cloud";
  try {
    upsertRuntimeEnv(runtimeEnv());
    upsertGoal(goal());

    const result = await runOrchestratorUserFrame({
      userId: "spec-test-user",
      leaseOwner: "cloud-orchestrator-spec",
      config: config(),
    });

    assert.equal(result.userId, "spec-test-user");
    assert.equal(result.createdJobs, 1);
    assert.equal(result.dispatched, 0);
    assert.equal(result.skippedOffline, true);

    const instance = readGoalsSnapshot([])
      .flatMap((candidate) => candidate.subGoals)
      .flatMap((subGoal) => subGoal.tasks)
      .find((task) => task.title === "立即生成 runtime job")
      ?.instances[0];
    assert.ok(instance, "scheduler 应生成 task instance");
    const job = getRuntimeJobByTaskInstanceId(instance.id);
    assert.equal(job?.status, "queued");
    assert.equal(job?.runtimeTransport, "cloud_control_plane");
  } finally {
    if (previousMode === undefined) {
      delete process.env.KIKI_ORCHESTRATOR_MODE;
    } else {
      process.env.KIKI_ORCHESTRATOR_MODE = previousMode;
    }
  }

  {
    ensureIsolatedPlanningSpecDataDir();
    const governanceJobUserId = "candidate-governance-job-user";
    const governanceEventUserId = "candidate-governance-event-user";
    upsertActiveRegistryUser(governanceJobUserId);
    upsertActiveRegistryUser(governanceEventUserId);

    runWithUserContext(governanceJobUserId, () => {
      createGovernanceTickJob({
        targetKind: "thread",
        topicId: "goal-candidate-governance-job",
        threadId: "thread-candidate-governance-job",
        baseRevision: 0,
        payload: {
          targetKind: "thread",
          topicId: "goal-candidate-governance-job",
          threadId: "thread-candidate-governance-job",
          baseRevision: 0,
          snapshot: {},
        },
        idempotencyKey: "candidate-governance-job",
        createdAt: "2026-06-12T00:00:00.000Z",
        availableAt: "2026-06-12T00:00:00.000Z",
      });
    });
    runWithUserContext(governanceEventUserId, () => {
      appendGovernanceEvent({
        eventType: "task_completed",
        source: "task_completed",
        topicId: "goal-candidate-governance-event",
        threadId: "thread-candidate-governance-event",
        idempotencyKey: "candidate-governance-event",
      });
    });

    const candidates = listUsersForOrchestratorTick();
    const pending = listUsersWithPendingWork();
    const governanceJobCandidate = candidates.find((candidate) => candidate.userId === governanceJobUserId);
    const governanceEventCandidate = candidates.find((candidate) => candidate.userId === governanceEventUserId);
    assert.ok(governanceJobCandidate, "pending governance jobs make a user an orchestrator candidate");
    assert.ok(governanceEventCandidate, "unconsumed governance outbox makes a user an orchestrator candidate");
    assert.ok(
      pending.some((candidate) => candidate.userId === governanceJobUserId),
      "pending governance jobs count as pending work",
    );
    assert.ok(
      pending.some((candidate) => candidate.userId === governanceEventUserId),
      "unconsumed governance outbox counts as pending work",
    );
  }

  console.log("runOrchestratorUserFrame specs passed");
}
