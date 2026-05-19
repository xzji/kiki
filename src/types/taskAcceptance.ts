import type { ResultBlock } from "@/types/taskResult";

export type LocalValidationIssueCode =
  | "json_parse_failed"
  | "missing_task_result"
  | "empty_blocks"
  | "artifact_only"
  | "missing_interactive_surface"
  | "missing_file_surface"
  | "surface_requirement_mismatch"
  | "invalid_block_schema"
  | "missing_required_blocks"
  | "blocked_state_invalid"
  | "deliverable_check_invalid";

export type LocalValidationIssue = {
  code: LocalValidationIssueCode;
  severity: "critical" | "major" | "minor";
  message: string;
  evidence?: string;
  repairHint: string;
};

export type LocalValidationReport = {
  passed: boolean;
  repairMode:
    | "format_repair"
    | "structure_repair"
    | "presentation_repair"
    | "state_repair"
    | "content_completion";
  allowToolCalls: boolean;
  issues: LocalValidationIssue[];
  reusableContent: {
    summary?: string;
    finalMessage?: string;
    artifacts?: unknown[];
    taskResult?: unknown;
  };
};

export type AcceptanceReport = {
  verdict: "pass" | "needs_repair" | "needs_user" | "fail";
  confidence: "high" | "medium" | "low";
  summary: string;
  hardFailures: string[];
  passedCriteria: Array<{
    criterion: string;
    evidence: string;
  }>;
  failedCriteria: Array<{
    criterion: string;
    evidence: string;
    severity: "critical" | "major" | "minor";
    repairableByAgent: boolean;
    requiresUserInput: boolean;
  }>;
  blockAssessment: {
    keepBlocks: string[];
    rewriteBlocks: string[];
    missingBlocks: ResultBlock["kind"][];
  };
  repairStrategy: {
    mode: "presentation_only" | "content_gap" | "restructure" | "rerun_with_tools";
    reuseExistingContent: boolean;
    allowNewToolCalls: boolean;
  };
  repairInstructions: string[];
  userBlockers: string[];
};

export type TaskAcceptanceRuntimeState = {
  localValidationReports: LocalValidationReport[];
  acceptanceReports: AcceptanceReport[];
  repairAttempts: Array<{
    type: "local_validation" | "semantic_repair";
    attempt: number;
    promptKind: string;
    startedAt: string;
    finishedAt?: string;
    status: "running" | "passed" | "failed";
    issueCodes?: LocalValidationIssueCode[];
    verdict?: AcceptanceReport["verdict"];
  }>;
};
