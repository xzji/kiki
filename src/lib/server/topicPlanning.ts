/**
 * topicPlanning — Topic Init Saga entry point.
 *
 * Plan ref: §3.3.2 + §10.9.
 *
 * The legacy Goal planning command (`generateGoalPlanWithClaude` and its
 * checkpoint helpers) has been removed; Topic planning now runs exclusively on
 * the 5-role Saga. This module re-exports the default-wired Topic Init Saga
 * runner so downstream call sites import a single Topic-scoped path instead of
 * reaching into goalPlanning/* internals.
 *
 * `runTopicInitSagaWithDefaults` orchestrates createSagaInstance + 5 default
 * prompts + 5 default LlmInvokes (built on createClaudeJsonInvoke).
 */
export {
  runTopicInitSagaWithDefaults,
  buildDefaultTopicInitSagaPrompts,
  createDefaultTopicInitSagaInvokes,
  runTopicInitSaga,
} from "./goalPlanning/runTopicInitSagaDefaults";

export type {
  TopicInitSagaSeed,
  RunTopicInitSagaWithDefaultsInput,
  CreateDefaultTopicInitSagaInvokesInput,
  TopicInitSagaInput,
  TopicInitSagaResult,
  CriticDecisionPayload,
} from "./goalPlanning/runTopicInitSagaDefaults";
