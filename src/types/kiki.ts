export type TaskInstanceStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "awaiting_user"
  | "paused"
  | "error";

export type TaskResultViewKind =
  | "flashcard"
  | "listening_qa"
  | "reading_digest"
  | "confirm_action"
  | "draft_review"
  | "freeform_chat"
  | "generic_result";

// Legacy alias kept to reduce churn while the UI migrates to resultViewKind.
export type ExecutionKind = TaskResultViewKind;
export type TaskExecutionStrategy = "agent_autonomous" | "user_interactive" | "hybrid";
export type TaskCollaborationMode =
  | "agent_autonomous"
  | "agent_with_user_confirmation"
  | "agent_user_collaborative"
  | "user_primary_agent_assistive";
export type UserInteractionType =
  | "none"
  | "confirm"
  | "answer"
  | "provide_context"
  | "perform_offline_action";
export type UserInteractionTiming =
  | "not_required"
  | "before_execution"
  | "during_execution"
  | "after_agent_output"
  | "core_task_step";
export type TaskCollaborationContract = {
  mode: TaskCollaborationMode;
  agentResponsibilities: string[];
  userResponsibilities: string[];
  userInteractionType: UserInteractionType;
  userInteractionTiming: UserInteractionTiming;
  userFacingActionLabel: string;
  shouldNotifyUser: boolean;
  completionOwner: "agent" | "user" | "shared";
  completionDefinition: string;
};
export type InteractionRequirement = {
  type:
    | "none"
    | "confirm"
    | "answer"
    | "provide_context"
    | "perform_offline_action"
    | "deliverable_gap"
    | "agent_revision_required";
  timing: UserInteractionTiming;
  reason: string;
  question?: string;
  options?: string[];
  suggestedActions?: string[];
  shouldNotifyUser: boolean;
};
export type TaskExecutionPhase =
  | "queued"
  | "preparing"
  | "running"
  | "awaiting_user"
  | "completed"
  | "retrying"
  | "failed"
  | "cancelled";
export type TaskRunErrorCategory =
  | "transient_cli"
  | "transient_network"
  | "permission"
  | "logic"
  | "aborted"
  | "unknown";

export type GoalWorkflowPhase =
  | "idle"
  | "collecting_info"
  | "decomposing"
  | "generating_tasks"
  | "reviewing_tasks"
  | "presenting_plan"
  | "executing"
  | "monitoring"
  | "reviewing"
  | "paused"
  | "completed"
  | "error";

export type GoalPlanDecision = "pending" | "confirmed" | "revision_requested";

export type GoalWorkflow = {
  phase: GoalWorkflowPhase;
  planDecision: GoalPlanDecision;
  collectedInfo?: Record<string, unknown>;
  assumptions?: string[];
  risks?: string[];
  reasoning?: string;
  notificationStrategy?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  confirmedAt?: string;
};

export type GoalInfoCollectionStatus =
  | "awaiting_user"
  | "processing"
  | "ready_for_planning"
  | "completed";

export type GoalInfoCollectionRound = {
  id: string;
  questions: string[];
  askedAt: string;
  answer?: string;
  answeredAt?: string;
};

export type GoalInfoCollection = {
  goalText: string;
  status: GoalInfoCollectionStatus;
  rounds: GoalInfoCollectionRound[];
  currentRound: number;
  minRounds: number;
  maxRounds: number;
  startedAt: string;
  updatedAt: string;
  summary?: CollectedInfoSummary;
  assistantMessage?: string;
};

export type GoalAnalysis = {
  coreIntent: string;
  successState: string;
  assumptions?: string[];
};

export type CollectedInfoSummary = {
  goalDetails?: string;
  timeline?: string;
  resources?: string;
  constraints?: string;
  challenges?: string;
  preferences?: string;
  summary?: string;
};

export type TaskPriority = "critical" | "high" | "medium" | "low";

export type TaskExecutionMode = "standard" | "interactive" | "monitoring" | "event_triggered";

export type TaskExecutionCycle = "once" | "recurring";

export type TaskExpectedResult = {
  type: "information" | "deliverable" | "decision" | "action" | "confirmation";
  description: string;
  format: "json" | "markdown" | "table" | "text" | "code" | "other";
  completionCriteria?: string;
};

export type TaskExecutionStep = {
  id: string;
  title: string;
  type: "phase" | "tool" | "assistant" | "system" | "retry" | "result";
  status: "pending" | "running" | "completed" | "failed" | "awaiting_user";
  detail?: string;
  toolName?: string;
  startedAt: string;
  finishedAt?: string;
};

export type TaskRunArtifact = {
  id: string;
  label: string;
  kind: "markdown" | "text" | "json" | "code" | "link" | "other";
  content?: string;
  href?: string;
};

export type TaskInstanceRunnerState = {
  requestId?: string;
  runtimeEnvId?: string;
  permissionMode?: "readonly" | "confirm" | "execute";
  workingDirectory?: string;
  attemptCount: number;
  lastAttemptAt?: string;
};

export type TaskInstanceExecutionState = {
  phase: TaskExecutionPhase;
  status: TaskInstanceStatus;
  startedAt?: string;
  finishedAt?: string;
  lastUpdatedAt?: string;
  errorCategory?: TaskRunErrorCategory;
  errorMessage?: string;
};

export type TaskInstanceResult = {
  summary?: string;
  finalMessage?: string;
  structuredOutput?: Record<string, unknown> | null;
  artifacts?: TaskRunArtifact[];
  interactionRequirement?: InteractionRequirement;
};

export type TaskInstanceAwaitingUser = {
  reason: string;
  suggestedActions?: string[];
  interactionRequirement?: InteractionRequirement;
};

export type TaskResultNotificationChannel = "silent" | "inbox" | "conversation" | "both";

export type TaskResultNotificationType =
  | "action_required"
  | "answer_required"
  | "context_required"
  | "result_ready"
  | "digest_ready"
  | "silent_archive";

export type TaskResultNotificationPriority = "high" | "normal" | "low";

export type TaskResultNotificationDecision = {
  shouldNotify: boolean;
  channel: TaskResultNotificationChannel;
  notificationType: TaskResultNotificationType;
  priority: TaskResultNotificationPriority;
  reason: string;
  title: string;
  snippet: string;
  userMessage: string;
  badge?: "need_confirm" | "need_answer" | null;
  resultSummary: {
    headline: string;
    keyPoints: string[];
    nextActions: string[];
    primaryArtifactLabel?: string;
  };
  detailPolicy: {
    showTimelineByDefault: boolean;
    showRawOutputBehindMore: boolean;
    showArtifactsExpanded: boolean;
  };
  createdAt: string;
};

export type TaskInstanceNotificationState = TaskResultNotificationDecision & {
  deliveryState: "pending" | "delivered" | "silent";
  deliveredAt?: string;
  inboxItemId?: string;
  conversationMessageId?: string;
};

export type FlashCard = {
  id: string;
  word: string;
  phonetic: string;
  partOfSpeech: string;
  meaning: string;
  examples: { en: string; zh: string }[];
};

export type QA = {
  id: string;
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
};

export type Article = {
  id: string;
  title: string;
  source: string;
  summary: string;
  body: string;
};

export type EmailDraft = {
  id: string;
  recipient: string;
  subject: string;
  body: string;
};

export type ExecutionPayload =
  | { kind: "flashcard"; cards: FlashCard[] }
  | { kind: "listening_qa"; audioUrl: string; questions: QA[] }
  | { kind: "reading_digest"; articles: Article[] }
  | { kind: "confirm_action"; summary: string; options: string[] }
  | { kind: "draft_review"; drafts: EmailDraft[] }
  | { kind: "freeform_chat"; seed: string }
  | { kind: "generic_result"; summary: string; details?: string; artifacts?: TaskRunArtifact[] };

export type TaskInstance = {
  id: string;
  taskId: string;
  dateLabel: string;
  status: TaskInstanceStatus;
  intro: string;
  payload: ExecutionPayload;
  createdAt: string;
  runner?: TaskInstanceRunnerState;
  execution?: TaskInstanceExecutionState;
  timeline?: TaskExecutionStep[];
  result?: TaskInstanceResult;
  awaitingUser?: TaskInstanceAwaitingUser;
  notification?: TaskInstanceNotificationState;
};

export type Task = {
  id: string;
  subGoalId: string;
  title: string;
  description: string;
  expectedOutcome: string;
  taskType: "daily_repeat" | "one_shot" | "monitoring";
  triggerRule: string;
  deadline?: string;
  progress: number;
  instances: TaskInstance[];
  executionKind: ExecutionKind;
  resultViewKind?: TaskResultViewKind;
  executionStrategy?: TaskExecutionStrategy;
  priority?: TaskPriority;
  dependencies?: string[];
  executionMode?: TaskExecutionMode;
  executionCycle?: TaskExecutionCycle;
  expectedResult?: TaskExpectedResult;
  executionObjective?: string;
  recommendedWorkingDirectory?: string;
  autoRunDisabled?: boolean;
  requiresConfirmation?: boolean;
  collaboration?: TaskCollaborationContract;
};

export type SubGoal = {
  id: string;
  goalId: string;
  title: string;
  tasks: Task[];
};

export type GoalKind = "collab" | "digest" | "chat_history";

export type ChatTurn = {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: string;
};

export type Goal = {
  id: string;
  title: string;
  deadline: string;
  progress: number;
  subGoals: SubGoal[];
  createdAt: string;
  kind?: GoalKind;
  summary?: string;
  chatTurns?: ChatTurn[];
  conversationId?: string;
  workflow?: GoalWorkflow;
};

export type InboxItem = {
  id: string;
  iconType: "task" | "mail" | "news" | "booking";
  title: string;
  snippet: string;
  badge?: "need_answer" | "need_confirm" | null;
  unreadCount: number;
  timeLabel: string;
  linkTo: string;
  goalId?: string;
  createdAt: string;
};

export type KikiMessage = {
  id: string;
  role: "kiki" | "user";
  content: string;
  timestamp: string;
  taskInstanceId?: string;
};

/**
 * 会话中的单条消息。
 * - text：纯文本（KiKi 或用户发言）
 * - task_card：KiKi 推送的任务执行消息，带任务卡片
 */
export type ConversationMessage =
  | {
      id: string;
      kind: "text";
      role: "kiki" | "user";
      content: string;
      createdAt: string;
      unread?: boolean;
      status?: "streaming" | "done" | "error";
      source?: "user" | "kiki" | "system";
    }
  | {
      id: string;
      kind: "goal_plan_card";
      role: "kiki";
      content: string;
      createdAt: string;
      unread?: boolean;
      status?: "streaming" | "done" | "error";
      source?: "user" | "kiki" | "system";
      goalRef: {
        goalId: string;
        title: string;
        summary?: string;
        subGoalCount: number;
        taskCount: number;
      };
    }
  | {
      id: string;
      kind: "task_card";
      role: "kiki";
      content: string;
      createdAt: string;
      unread?: boolean;
      status?: "streaming" | "done" | "error";
      source?: "user" | "kiki" | "system";
      taskRef: {
        goalId: string;
        subGoalId: string;
        taskId: string;
        instanceId: string;
      };
    };

export type Conversation = {
  id: string;
  title: string;
  goalId?: string;
  goalInfoCollection?: GoalInfoCollection;
  runtimeEnvId?: string;
  claudeSessionId?: string;
  status?: "idle" | "streaming" | "error";
  messages: ConversationMessage[];
  updatedAt: string;
  pinned?: boolean;
};

export type GoalBreakdownDraft = {
  goalTitle: string;
  summary?: string;
  deadline?: string;
  goalAnalysis?: GoalAnalysis;
  collectedInfoSummary?: CollectedInfoSummary;
  assumptions?: string[];
  risks?: string[];
  reasoning?: string;
  executionOrder?: string;
  reviewSummary?: string[];
  notificationStrategy?: string;
  subGoals: {
    id: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    dependencies?: string[];
    successCriteria?: string[];
    tasks: {
      id: string;
      title: string;
      description: string;
      expectedOutcome: string;
      taskType: Task["taskType"];
      triggerRule: string;
      executionKind: ExecutionKind;
      resultViewKind?: TaskResultViewKind;
      executionStrategy?: TaskExecutionStrategy;
      priority?: TaskPriority;
      dependencies?: string[];
      executionMode?: TaskExecutionMode;
      executionCycle?: TaskExecutionCycle;
      expectedResult?: TaskExpectedResult;
      executionObjective?: string;
      recommendedWorkingDirectory?: string;
      autoRunDisabled?: boolean;
      requiresConfirmation?: boolean;
      collaboration?: TaskCollaborationContract;
    }[];
  }[];
};
