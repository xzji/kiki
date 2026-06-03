import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";

export type DependencyStatus =
  | "completed"
  | "awaiting_user"
  | "in_progress"
  | "not_started"
  | "failed"
  | "missing";

export type ContextSuggestedAction =
  | {
      kind: "free_text";
      label: string;
    }
  | {
      kind: "navigate_task";
      label: string;
      taskId: string;
    };

export type DependencyDigest = {
  summary: string;
  userDecision?: string;
  keyPoints: string[];
  tableRows?: Array<Record<string, string>>;
  keyValues?: Array<{ key: string; value: string }>;
  lists?: Array<{ heading?: string; items: string[] }>;
  artifacts: Array<{ id: string; label: string; localPath?: string }>;
  resultPointer: { kind: "fs"; relativePath: string };
  sourceResultFilePath?: string;
};

export type DependencyView = {
  ref: {
    taskId: string;
    title: string;
    expectedOutcome: string;
  };
  status: DependencyStatus;
  digest?: DependencyDigest;
  blocker?: {
    reason: string;
    hint: string;
  };
};

export type ContextBlocker = {
  kind: "dependency" | "missing_user_input" | "cycle" | "config";
  severity: "block" | "soft_wait";
  source: "user" | "agent" | "system";
  id: string;
  label: string;
  message: string;
  reason: string;
  value?: string;
  options?: string[];
  optionQuestion?: string;
  inputPlaceholder?: string;
  inputKind?: "text" | "image" | "file" | "image_or_text";
  suggestedActions: ContextSuggestedAction[];
};

export type TaskExecutionContext = {
  identity: {
    conversationId: string;
    goalId: string;
    subGoalId: string;
    taskId: string;
    instanceId?: string;
    requestId?: string;
  };
  readiness: {
    state: "ready" | "blocked";
    blockers: ContextBlocker[];
    summary: string;
  };
  dependencies: DependencyView[];
  inputs: {
    goal: Goal;
    subGoal: SubGoal;
    task: Task;
    instance?: TaskInstance;
  };
  workspace?: {
    taskWorkspaceDir: string;
    dependenciesDir: string;
    artifactsDir: string;
  };
  budget: {
    maxPromptBytes: number;
    maxKeyPoints: number;
    maxArtifacts: number;
  };
};

export const DEFAULT_TASK_EXECUTION_CONTEXT_BUDGET = {
  maxPromptBytes: 8 * 1024,
  maxKeyPoints: 8,
  maxArtifacts: 5,
} satisfies TaskExecutionContext["budget"];
