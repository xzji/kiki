/**
 * runTopicInitSagaDefaults spec — verifies PR11 default wiring.
 *
 * Plan ref: §12.1 PR11.4 in .trae/documents/Topic_Thread_代码实现计划_v1.md
 *
 * Coverage:
 *  1. buildDefaultTopicInitSagaPrompts — 5 keys present, interview prompt
 *     swaps based on userContext emptiness, critic / present builders are functions.
 *  2. createDefaultTopicInitSagaInvokes — 5 keys present, including a real
 *     Refiner invoke wired through the runtime JSON path.
 *  3. createSagaInstance idempotency — runTopicInitSagaWithDefaults reuses
 *     existing saga row when called twice with the same idempotencyKey.
 *  4. runTopicInitSagaWithDefaults guards — mutual exclusion, missing saga,
 *     terminal-status rejection.
 */

import assert from "node:assert/strict";

import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";
import {
  createSagaInstance,
  findSagaInstanceById,
} from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";
import { markCompleted } from "@/lib/server/agentRuntime/sagaCoordinator";
import type { RuntimeEnvironment } from "@/types/runtime";

import {
  buildDefaultTopicInitSagaPrompts,
  createDefaultTopicInitSagaInvokes,
  runTopicInitSagaWithDefaults,
} from "./runTopicInitSagaDefaults";

function fakeRuntimeEnvironment(): RuntimeEnvironment {
  return {
    id: "rt-defaults-spec",
    type: "local",
    name: "defaults-spec",
    workingDirectory: "/tmp",
    cliPath: "claude",
    permissionMode: "confirm",
  };
}

export async function runTopicInitSagaDefaultsSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // -----------------------------------------------------------------------
  // 1. buildDefaultTopicInitSagaPrompts — 5 keys + interview branch swap
  // -----------------------------------------------------------------------
  {
    const promptsEmpty = buildDefaultTopicInitSagaPrompts({
      topicId: "topic-defaults-1",
      topicText: "学习 Rust 异步运行时",
    });
    assert.equal(typeof promptsEmpty.interview, "string", "interview prompt is string");
    assert.equal(typeof promptsEmpty.plan, "string", "plan prompt is string");
    assert.equal(typeof promptsEmpty.critic, "function", "critic is fn");
    assert.equal(typeof promptsEmpty.refine, "function", "refine is fn");
    assert.equal(typeof promptsEmpty.present, "function", "present is fn");
    assert.ok(
      promptsEmpty.interview.includes("澄清") || promptsEmpty.interview.includes("clarif"),
      "empty userContext → clarification prompt",
    );

    const promptsWithCtx = buildDefaultTopicInitSagaPrompts({
      topicId: "topic-defaults-2",
      topicText: "学习 Rust 异步运行时",
      userContext: { weeklyHours: 8 },
    });
    assert.notEqual(
      promptsEmpty.interview,
      promptsWithCtx.interview,
      "non-empty userContext should switch to summary prompt",
    );
    assert.ok(
      promptsWithCtx.interview.includes("摘要") ||
        promptsWithCtx.interview.includes("summary"),
      "summary prompt active when userContext non-empty",
    );

    // Critic / refine builders accept Plan parsed object and return non-empty strings.
    const critic = promptsWithCtx.critic({ subGoals: [{ name: "A" }] });
    assert.ok(critic.includes("verdict"), "critic prompt mentions verdict schema");
    const refine = promptsWithCtx.refine(
      { subGoals: [{ name: "A" }] },
      { verdict: "needs_refinement", notes: "missing detail" },
    );
    assert.ok(refine.includes("Refiner"), "refine prompt mentions Refiner role");
    assert.ok(refine.includes("Critic 决策"), "refine prompt includes critic decision");
    assert.ok(refine.includes("Planner 草稿"), "refine prompt includes planner draft");
    assert.ok(refine.includes("学习 Rust 异步运行时"), "refine prompt includes topic");

    // Presenter builder consumes plan and returns string.
    const present = promptsWithCtx.present({ subGoals: [{ name: "A", tasks: [{}, {}] }] });
    assert.equal(typeof present, "string");
    assert.ok(present.length > 0);
  }

  // -----------------------------------------------------------------------
  // 2. createDefaultTopicInitSagaInvokes — 5 keys + real refiner invoke
  // -----------------------------------------------------------------------
  {
    const invokes = createDefaultTopicInitSagaInvokes({
      cwd: "/tmp",
      runtimeEnv: fakeRuntimeEnvironment(),
    });
    for (const key of ["interview", "plan", "critic", "refine", "present"] as const) {
      assert.equal(typeof invokes[key], "function", `invokes.${key} is fn`);
    }

    // Refiner is now a real runtime-backed invoke; do not call it in this unit
    // spec because it would spawn the configured CLI.
    assert.equal(typeof invokes.refine, "function", "invokes.refine is real invoke fn");
  }

  // -----------------------------------------------------------------------
  // 3. createSagaInstance idempotency — same key reuses saga row.
  // (Validates the lookup branch used by runTopicInitSagaWithDefaults.)
  // -----------------------------------------------------------------------
  {
    const idempotencyKey = `topic-init-defaults-${Date.now()}`;
    const first = createSagaInstance({
      topicId: "topic-defaults-idem",
      type: "topic_init",
      idempotencyKey,
    });
    const second = createSagaInstance({
      topicId: "topic-defaults-idem",
      type: "topic_init",
      idempotencyKey,
    });
    assert.equal(first.id, second.id, "same idempotencyKey reuses saga row");

    const persisted = findSagaInstanceById(first.id);
    assert.ok(persisted, "saga row persisted");
    assert.equal(persisted?.type, "topic_init");
    assert.equal(persisted?.idempotencyKey, idempotencyKey);
  }

  // -----------------------------------------------------------------------
  // 4. runTopicInitSagaWithDefaults — input guards
  // -----------------------------------------------------------------------
  {
    // 4a. mutual exclusion of sagaInstanceId + idempotencyKey
    await assert.rejects(
      () =>
        runTopicInitSagaWithDefaults({
          topicId: "topic-defaults-guard",
          topicText: "x",
          cwd: "/tmp",
          runtimeEnv: fakeRuntimeEnvironment(),
          sagaInstanceId: "saga-x",
          idempotencyKey: "key-x",
        }),
      /mutually exclusive/,
      "passing both sagaInstanceId and idempotencyKey throws",
    );

    // 4b. unknown sagaInstanceId rejected
    await assert.rejects(
      () =>
        runTopicInitSagaWithDefaults({
          topicId: "topic-defaults-guard",
          topicText: "x",
          cwd: "/tmp",
          runtimeEnv: fakeRuntimeEnvironment(),
          sagaInstanceId: "saga-does-not-exist",
        }),
      /not found/,
      "unknown sagaInstanceId rejected",
    );

    // 4c. terminal-status saga cannot be re-run via sagaInstanceId
    const terminalSaga = createSagaInstance({
      topicId: "topic-defaults-terminal",
      type: "topic_init",
    });
    const finished = markCompleted(terminalSaga.id);
    assert.equal(finished?.status, "completed");
    await assert.rejects(
      () =>
        runTopicInitSagaWithDefaults({
          topicId: "topic-defaults-terminal",
          topicText: "x",
          cwd: "/tmp",
          runtimeEnv: fakeRuntimeEnvironment(),
          sagaInstanceId: terminalSaga.id,
        }),
      /terminal status/,
      "terminal-status saga cannot be re-run",
    );

    // 4d. terminal-status saga also rejected via idempotencyKey reuse
    const terminalKey = `topic-init-terminal-${Date.now()}`;
    const reusedSaga = createSagaInstance({
      topicId: "topic-defaults-terminal-key",
      type: "topic_init",
      idempotencyKey: terminalKey,
    });
    markCompleted(reusedSaga.id);
    await assert.rejects(
      () =>
        runTopicInitSagaWithDefaults({
          topicId: "topic-defaults-terminal-key",
          topicText: "x",
          cwd: "/tmp",
          runtimeEnv: fakeRuntimeEnvironment(),
          idempotencyKey: terminalKey,
        }),
      /terminal status/,
      "terminal-status saga rejected via idempotencyKey reuse",
    );
  }
}
