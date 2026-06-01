import type { AgentRole } from "@/types/agentOrchestration";
import type { TaskResult } from "@/types/taskResult";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { ExecutionBlocker } from "@/types/executionBlocker";

export type TaskInstanceStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "awaiting_user"
  | "paused"
  | "error";

export type TaskResultViewKind = "generic_result";

// Legacy alias kept to reduce churn while the UI migrates to resultViewKind.
export type ExecutionKind = TaskResultViewKind;

export function normalizeTaskResultViewKind(_value?: unknown): TaskResultViewKind {
  void _value;
  return "generic_result";
}

export function normalizeExecutionKind(value?: unknown): ExecutionKind {
  return normalizeTaskResultViewKind(value);
}

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
export type TaskCollaborationRequirements = {
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
export type MissingFieldQuestion = {
  id: string;
  label: string;
  question: string;
  description: string;
  options: string[];
  inputPlaceholder?: string;
  source: "user" | "agent" | "system";
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
  fields?: MissingFieldQuestion[];
  suggestedActions?: string[];
  shouldNotifyUser: boolean;
};

export type InteractionSubmission = {
  type: InteractionRequirement["type"];
  status: "submitted" | "confirmed" | "rejected" | "completed";
  action: string;
  approved?: boolean;
  feedback?: string;
  fields?: Record<string, string>;
  submittedAt: string;
};
export type TaskExecutionPhase =
  | "queued"
  | "preparing"
  | "running"
  | "awaiting_user"
  | "completed"
  | "paused"
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

export type GoalPlanningRecoveryAction = "retry_collect" | "retry_plan" | "resume_plan";

export type GoalPlanningRunState = {
  status: "failed";
  phase: GoalWorkflowPhase;
  action: GoalPlanningRecoveryAction;
  goalText: string;
  errorMessage: string;
  failedAt: string;
  updatedAt: string;
  lastUserMessage?: string;
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

export type ResultSurfaceKind = "interactive" | "files";
export type InteractiveSurfaceKind = "blocks" | "iframe" | "webapp" | "dashboard" | "form" | "table";
export type FileArtifactKind = "markdown" | "text" | "csv" | "json" | "zip" | "html";

export type TaskExpectedResult = {
  type: "information" | "deliverable" | "decision" | "action" | "confirmation";
  description: string;
  format: "json" | "markdown" | "table" | "text" | "code" | "other";
  surfaces?: ResultSurfaceKind[];
  interactiveSurface?: {
    required?: boolean;
    kind?: InteractiveSurfaceKind;
  };
  fileSurface?: {
    required?: boolean;
    acceptedKinds?: FileArtifactKind[];
    minCount?: number;
  };
  deliveryMode?: "inline" | "file";
  presentation?: "summary_card" | "visual_report" | "comparison_table" | "checklist" | "timeline" | "document" | "dashboard" | "handoff_package";
  primaryFormat?: "structured_blocks" | "json" | "markdown" | "html" | "text" | "code";
  exportableFormats?: Array<"html" | "markdown" | "json" | "text">;
  requiredBlocks?: Array<"heading" | "paragraph" | "markdown" | "list" | "key_value" | "comparison_table" | "decision" | "callout">;
  completionCriteria?: string;
};

export type TaskExecutionStep = {
  id: string;
  title: string;
  type: "phase" | "tool" | "assistant" | "system" | "retry" | "result";
  status: "pending" | "running" | "completed" | "failed" | "awaiting_user";
  agentRole?: AgentRole;
  detail?: string;
  toolName?: string;
  toolInput?: unknown;
  handoff?: {
    fromRole?: AgentRole;
    toRole?: AgentRole;
    summary: string;
  };
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
  waitingReason?: string;
  errorCategory?: TaskRunErrorCategory;
  errorMessage?: string;
};

export type TaskInstanceResult = {
  summary?: string;
  finalMessage?: string;
  taskResult?: TaskResult;
  structuredOutput?: Record<string, unknown> | null;
  artifacts?: TaskRunArtifact[];
  interactionRequirement?: InteractionRequirement;
  interactionSubmission?: InteractionSubmission;
};

export type TaskInstanceAwaitingUser = {
  reason: string;
  suggestedActions?: string[];
  interactionRequirement?: InteractionRequirement;
  blocker?: ExecutionBlocker;
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
  notificationSequence?: number;
  pushedConversationMessageIds?: string[];
  lastDeliveredHash?: string;
};

export type ExecutionPayload = {
  kind: "generic_result";
  summary: string;
  details?: string;
  artifacts?: TaskRunArtifact[];
};

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
  trajectory?: ExecutionTrajectoryStep[];
  result?: TaskInstanceResult;
  awaitingUser?: TaskInstanceAwaitingUser;
  blocker?: ExecutionBlocker;
  notification?: TaskInstanceNotificationState;
};

/**
 * @deprecated 旧 Task 模型，新代码请使用 Topic/Thread 体系下的 Task（threadId 替代 subGoalId）。
 * Plan ref: §3.2.1 + §9.4 问题 13。保留原结构 1 个版本，PR15 后置清理 UI/inbox/history。
 */
export type Task = {
  id: string;
  /** @deprecated 使用 threadId；§9.4 问题 14 分两批迁移。 */
  subGoalId: string;
  title: string;
  description: string;
  expectedOutcome: string;
  taskType: "repeat" | "one_shot";
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
  expectedResult?: TaskExpectedResult;
  executionObjective?: string;
  recommendedWorkingDirectory?: string;
  autoRunDisabled?: boolean;
  requiresConfirmation?: boolean;
  collaboration?: TaskCollaborationRequirements;
};

/**
 * @deprecated 改用 Thread（src/types/topic.ts）。SubGoal 字段（successCriteria/tasks）
 * 与 Thread 不同形不能 type alias，需通过 legacySubGoalToThread() 显式转换。
 * Plan ref: §9.4 问题 13。
 */
export type SubGoal = {
  id: string;
  goalId: string;
  title: string;
  description?: string;
  why?: string;
  priority?: TaskPriority;
  weight?: number;
  dependencies?: string[];
  estimatedDurationMinutes?: number;
  successCriteria?: string[];
  tasks: Task[];
};

export type GoalKind = "collab" | "digest" | "chat_history";

export type ChatTurn = {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: string;
};

/**
 * @deprecated 改用 Topic（src/types/topic.ts）。Goal.subGoals[] 与 Topic.threads[] 字段不同，
 * 必须通过 legacyGoalToTopic() 显式转换。
 * Plan ref: §9.4 问题 13。
 */
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
      taskSnapshot?: {
        task: Task;
        instance: TaskInstance;
      };
    };

export type Conversation = {
  id: string;
  title: string;
  goalId?: string;
  goalInfoCollection?: GoalInfoCollection;
  planningRunState?: GoalPlanningRunState;
  workspacePath?: string;
  workspaceInitializedAt?: string;
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
    why?: string;
    priority?: TaskPriority;
    weight?: number;
    dependencies?: string[];
    estimatedDurationMinutes?: number;
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
      expectedResult?: TaskExpectedResult;
      executionObjective?: string;
      recommendedWorkingDirectory?: string;
      autoRunDisabled?: boolean;
      requiresConfirmation?: boolean;
      collaboration?: TaskCollaborationRequirements;
    }[];
  }[];
};
