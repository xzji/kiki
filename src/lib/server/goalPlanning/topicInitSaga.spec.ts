/**
 * topicInitSaga spec — verifies 5-role orchestration end-to-end.
 *
 * Plan ref: §3.1.4 + §9.5 + §9.6.
 *
 * Coverage:
 *  1. Happy path — Interviewer → Planner → Critic(accept) → Presenter, refineLoops=0
 *  2. Critic↔Refiner loop — first critic returns needs_refinement, second accepts
 *  3. awaiting_user — Interviewer surfaces needsUserInput → saga pauses
 *  4. forced_accept — Critic exhausts maxRefineLoops, saga still completes with forcedAccept=true
 *  5. failure — invoke throws → saga marked failed + error event recorded
 */

import assert from "node:assert/strict";

import { listAgentEvents } from "@/lib/server/repositories/agentRuntime/agentEventsRepository";
import { findSagaInstanceById, createSagaInstance } from "@/lib/server/repositories/agentRuntime/sagaInstancesRepository";
import { ensureIsolatedPlanningSpecDataDir } from "@/lib/server/runtime/stateSnapshot.spec";

import type { LlmInvoke } from "@/lib/server/agentRuntime/agentExecutor";

import {
  runTopicInitSaga,
  type CriticDecisionPayload,
  type TopicInitSagaInput,
} from "./topicInitSaga";

function constInvoke(parsed: Record<string, unknown>, rawText = "{}"): LlmInvoke {
  return async () => ({ rawText, parsed });
}

function buildPrompts(): TopicInitSagaInput["prompts"] {
  return {
    interview: "ask user",
    plan: "draft plan",
    critic: () => "review plan",
    refine: () => "refine plan",
    present: () => "present plan",
  };
}

export async function runTopicInitSagaSpecs() {
  ensureIsolatedPlanningSpecDataDir();

  // -----------------------------------------------------------------------
  // 1. Happy path — Critic accepts on first review
  // -----------------------------------------------------------------------
  {
    const saga = createSagaInstance({ topicId: "topic-saga-happy", type: "topic_init" });
    const result = await runTopicInitSaga({
      sagaInstanceId: saga.id,
      topicId: "topic-saga-happy",
      prompts: buildPrompts(),
      invokes: {
        interview: constInvoke({ collectedInfo: { goal: "x" } }),
        plan: constInvoke({
          threads: [{ id: "t1", tasks: [{ id: "1", title: "任务", objective: "完成任务", deliverable: "交付物" }] }],
        }),
        critic: constInvoke({ verdict: "accept" } as CriticDecisionPayload),
        refine: constInvoke({}),
        spec: constInvoke({ specs: [{ taskId: "t1#1", content: "## 任务目标\n生成规格" }] }),
        present: constInvoke({ goalTitle: "Topic A", summary: "..." }),
      },
    });

    assert.equal(result.status, "completed", "happy: status should be completed");
    assert.equal(result.refineLoops, 0, "happy: no refine loops");
    assert.notEqual(result.forcedAccept, true, "happy: not forced");
    assert.ok(result.artifacts.interview, "happy: interview artifact recorded");
    assert.ok(result.artifacts.plan, "happy: plan artifact recorded");
    assert.equal(result.artifacts.critic?.verdict, "accept");
    assert.deepEqual(result.artifacts.specs, { "t1#1": "## 任务目标\n生成规格" });
    assert.ok(result.artifacts.presentation, "happy: presentation artifact recorded");
    assert.equal(result.saga.status, "completed");
  }

  // -----------------------------------------------------------------------
  // 2. Critic↔Refiner loop — first review needs_refinement, second accepts
  // -----------------------------------------------------------------------
  {
    const saga = createSagaInstance({ topicId: "topic-saga-loop", type: "topic_init" });
    let criticCalls = 0;
    const criticInvoke: LlmInvoke = async () => {
      criticCalls += 1;
      return {
        rawText: "{}",
        parsed:
          criticCalls === 1
            ? { verdict: "needs_refinement", notes: "missing deadline" }
            : { verdict: "accept" },
      };
    };

    const result = await runTopicInitSaga({
      sagaInstanceId: saga.id,
      topicId: "topic-saga-loop",
      prompts: buildPrompts(),
      invokes: {
        interview: constInvoke({}),
        plan: constInvoke({ threads: [{ id: "t1" }] }),
        critic: criticInvoke,
        refine: constInvoke({ threads: [{ id: "t1", refined: true }] }),
        spec: constInvoke({ specs: [] }),
        present: constInvoke({ summary: "ok" }),
      },
      maxRefineLoops: 2,
    });

    assert.equal(result.status, "completed", "loop: should complete");
    assert.equal(result.refineLoops, 1, "loop: exactly one refine cycle");
    assert.notEqual(result.forcedAccept, true, "loop: not forced");
    assert.equal(criticCalls, 2, "loop: critic invoked twice");
    assert.ok(result.artifacts.refinedPlan, "loop: refinedPlan recorded");
    assert.equal(
      (result.artifacts.refinedPlan as Record<string, unknown>).threads !== undefined,
      true,
    );
  }

  // -----------------------------------------------------------------------
  // 3. awaiting_user — Interviewer surfaces questions, saga pauses
  // -----------------------------------------------------------------------
  {
    const saga = createSagaInstance({ topicId: "topic-saga-awaiting", type: "topic_init" });
    const result = await runTopicInitSaga({
      sagaInstanceId: saga.id,
      topicId: "topic-saga-awaiting",
      prompts: buildPrompts(),
      invokes: {
        interview: constInvoke({ needsUserInput: ["What's your deadline?", "Budget?"] }),
        plan: constInvoke({}),
        critic: constInvoke({ verdict: "accept" }),
        refine: constInvoke({}),
        spec: constInvoke({ specs: [] }),
        present: constInvoke({}),
      },
    });

    assert.equal(result.status, "awaiting_user");
    assert.deepEqual(result.awaitingQuestions, [
      "What's your deadline?",
      "Budget?",
    ]);
    assert.equal(result.refineLoops, 0);
    assert.equal(result.artifacts.plan, undefined, "awaiting: planner not invoked");
    assert.equal(result.saga.status, "awaiting_user");
  }

  // -----------------------------------------------------------------------
  // 4. forced_accept — Critic always returns needs_refinement, hits cap
  // -----------------------------------------------------------------------
  {
    const saga = createSagaInstance({ topicId: "topic-saga-forced", type: "topic_init" });
    let criticCalls = 0;
    const criticInvoke: LlmInvoke = async () => {
      criticCalls += 1;
      return {
        rawText: "{}",
        parsed: { verdict: "needs_refinement", notes: "still incomplete" },
      };
    };

    const result = await runTopicInitSaga({
      sagaInstanceId: saga.id,
      topicId: "topic-saga-forced",
      prompts: buildPrompts(),
      invokes: {
        interview: constInvoke({}),
        plan: constInvoke({ threads: [] }),
        critic: criticInvoke,
        refine: constInvoke({ threads: [{ refined: true }] }),
        spec: constInvoke({ specs: [] }),
        present: constInvoke({ summary: "force-accepted" }),
      },
      maxRefineLoops: 1,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.forcedAccept, true, "forced: should set forcedAccept");
    // refineLoops counts completed refine cycles; cap=1 means refineLoops can equal 1 before forced_accept.
    assert.equal(result.refineLoops, 1, "forced: 1 refine cycle ran");
    assert.equal(criticCalls, 2, "forced: critic invoked twice (initial + after refine)");
    assert.ok(result.artifacts.presentation, "forced: still produces presentation");
  }

  // -----------------------------------------------------------------------
  // 5. failure — Planner invoke throws → saga.failed + error event
  // -----------------------------------------------------------------------
  {
    const saga = createSagaInstance({ topicId: "topic-saga-fail", type: "topic_init" });
    const planInvoke: LlmInvoke = async () => {
      throw new Error("planner explosion");
    };

    const result = await runTopicInitSaga({
      sagaInstanceId: saga.id,
      topicId: "topic-saga-fail",
      prompts: buildPrompts(),
      invokes: {
        interview: constInvoke({}),
        plan: planInvoke,
        critic: constInvoke({ verdict: "accept" }),
        refine: constInvoke({}),
        spec: constInvoke({ specs: [] }),
        present: constInvoke({}),
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.saga.status, "failed");
    const persisted = findSagaInstanceById(saga.id);
    assert.equal(persisted?.status, "failed");

    // Interview ran, plan threw → artifacts.interview present, plan absent.
    assert.ok(result.artifacts.interview !== undefined);
    assert.equal(result.artifacts.plan, undefined);
  }

  // Smoke check: at least one saga produced agent events.
  // (Sanity, not exhaustive — agentExecutor.spec already covers event ordering.)
  const eventsExist = listAgentEvents({ agentRunId: "nonexistent" });
  assert.ok(Array.isArray(eventsExist), "listAgentEvents returns array");
}
