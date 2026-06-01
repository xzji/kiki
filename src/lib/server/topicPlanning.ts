/**
 * topicPlanning — Thin wrapper around legacy goalPlanning.ts
 *
 * Plan ref: §3.3.2 + §10.9 PR10.
 *
 * Goal of this PR (PR10): introduce Topic-named entry point so that downstream
 * call sites can migrate from `goalPlanning` import to `topicPlanning` import
 * without behavior change. The actual Saga-based rewrite happens in PR11.
 *
 * Until PR11 lands:
 *  - `generateTopicPlanWithClaude` ≡ `generateGoalPlanWithClaude`
 *  - `generateTopicClarificationQuestionsWithClaude` ≡ `generateGoalClarificationQuestionsWithClaude`
 *  - `advanceTopicInfoCollectionWithClaude` ≡ `advanceGoalInfoCollectionWithClaude`
 *
 * After PR11, this module will host the new 5-role saga; legacy goalPlanning
 * will be reduced to a re-export shim until removed in a later PR.
 */

export {
  generateGoalPlanWithClaude as generateTopicPlanWithClaude,
  generateGoalClarificationQuestionsWithClaude as generateTopicClarificationQuestionsWithClaude,
  advanceGoalInfoCollectionWithClaude as advanceTopicInfoCollectionWithClaude,
  getGoalPlanningCheckpointStatus as getTopicPlanningCheckpointStatus,
  getGoalPlanningCheckpointForResume as getTopicPlanningCheckpointForResume,
} from "./goalPlanning";

export type {
  GoalClarificationQuestions as TopicClarificationQuestions,
  GoalInfoCollectionHistoryItem as TopicInfoCollectionHistoryItem,
  GoalInfoCollectionTurnDecision as TopicInfoCollectionTurnDecision,
  GoalPlanningCheckpointStatus as TopicPlanningCheckpointStatus,
} from "./goalPlanning";

/**
 * PR11 Saga entry point — re-export the default-wired Topic Init Saga runner so
 * that downstream PRs (PR12+, command service swap) can import a single Topic-
 * scoped path instead of reaching into goalPlanning/* internals.
 *
 * `runTopicInitSagaWithDefaults` orchestrates createSagaInstance + 5 default
 * prompts + 5 default LlmInvokes (built on createClaudeJsonInvoke). The legacy
 * `generateTopicPlanWithClaude` thin wrapper above remains the active call site
 * during the migration window — see §11.3 PR11 / §12.1 in the implementation plan.
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
