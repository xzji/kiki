import type { AgentRunPlan } from "@/types/agentOrchestration";
import type { ArtifactRef } from "@/types/artifact";
import type { InteractiveSurfaceKind, ResultSurfaceKind } from "@/types/kiki";

export type TaskResultStatus = "draft" | "pending_user" | "done" | "blocked" | "failed";
export type TaskResultPresentation = "summary_card" | "visual_report" | "comparison_table" | "checklist" | "timeline" | "document" | "dashboard" | "handoff_package";
export type TaskResultPrimaryFormat = "structured_blocks" | "json" | "markdown" | "html" | "text" | "code";
export type TaskResultExportFormat = "html" | "markdown" | "json" | "text";

export type ResultCell =
  | string
  | number
  | boolean
  | {
      text: string;
      tone?: "default" | "good" | "bad" | "warn";
    };

export type HeadingBlock = {
  kind: "heading";
  text: string;
  level: 1 | 2 | 3;
};

export type ParagraphBlock = {
  kind: "paragraph";
  text: string;
};

export type MarkdownBlock = {
  kind: "markdown";
  content: string;
};

export type ListBlock = {
  kind: "list";
  ordered?: boolean;
  items: string[];
};

export type KeyValueBlock = {
  kind: "key_value";
  entries: Array<{
    label: string;
    value: ResultCell;
    emphasis?: boolean;
  }>;
};

export type ComparisonTableBlock = {
  kind: "comparison_table";
  columns: string[];
  rows: Array<Record<string, ResultCell>>;
  highlight?: number[];
};

export type DecisionBlock = {
  kind: "decision";
  question: string;
  options: Array<{
    id: string;
    label: string;
    rationale?: string;
    recommended?: boolean;
  }>;
  selectedOptionId?: string;
};

export type CalloutBlock = {
  kind: "callout";
  tone: "info" | "warn" | "success" | "risk";
  text: string;
};

export type ResultBlock =
  | HeadingBlock
  | ParagraphBlock
  | MarkdownBlock
  | ListBlock
  | KeyValueBlock
  | ComparisonTableBlock
  | DecisionBlock
  | CalloutBlock;

export type TaskResult = {
  schemaVersion: 1;
  taskId: string;
  instanceId: string;
  title: string;
  status: TaskResultStatus;
  blocks: ResultBlock[];
  artifactRefs?: ArtifactRef[];
  meta: {
    producedAt: string;
    surfaces?: ResultSurfaceKind[];
    interactiveSurfaceKind?: InteractiveSurfaceKind;
    fileSurfaceRequired?: boolean;
    presentation?: TaskResultPresentation;
    primaryFormat?: TaskResultPrimaryFormat;
    exportableFormats?: TaskResultExportFormat[];
    agentRunPlan?: AgentRunPlan;
    qualityReview?: {
      passed: boolean;
      issues: string[];
      reviewerRole: "reviewer";
    };
    durationMs?: number;
    tokensUsed?: number;
  };
};
