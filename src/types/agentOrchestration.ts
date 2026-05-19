export type AgentRole = "coordinator" | "researcher" | "executor" | "reviewer" | "synthesizer";

export type AgentRoleRunStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "awaiting_user";

export type AgentCollaborationStrategy =
  | "single_agent"
  | "quality_review"
  | "research_then_write"
  | "build_then_review"
  | "custom";

export type AgentRoleRun = {
  id: string;
  role: AgentRole;
  title: string;
  objective: string;
  inputSummary: string;
  outputSummary?: string;
  status: AgentRoleRunStatus;
  startedAt?: string;
  finishedAt?: string;
  rawOutput?: string;
  parsedOutput?: Record<string, unknown>;
  error?: string;
  filesTouched?: string[];
};

export type AgentHandoffClaim = {
  text: string;
  confidence: "low" | "medium" | "high";
  evidence?: string[];
};

export type AgentHandoff = {
  fromRole: AgentRole;
  toRole: AgentRole;
  summary: string;
  claims: AgentHandoffClaim[];
  decisions: string[];
  openQuestions: string[];
  risks: string[];
  filesTouched?: string[];
  artifactRefs?: string[];
  createdAt: string;
};

export type AgentReviewDecision = {
  passed: boolean;
  severity: "info" | "warning" | "blocking";
  issues: Array<{
    id: string;
    severity: "info" | "warning" | "blocking";
    message: string;
    expected: string;
    actual: string;
    suggestedFix?: string;
  }>;
  decisionReason: string;
};

export type AgentRunPlan = {
  schemaVersion: 1;
  mode: "single_agent" | "role_collaboration";
  strategy: Exclude<AgentCollaborationStrategy, "single_agent"> | "custom";
  roles: AgentRoleRun[];
  handoffs: AgentHandoff[];
  review?: AgentReviewDecision;
  finalRole: AgentRole;
};
