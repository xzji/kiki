import type { InteractionRequirement } from "@/types/kiki";

export type ExecutionBlockerDecision = "approved" | "rejected";

export type ExecutionBlocker = {
  executionId: string;
  taskId: string;
  instanceId: string;
  blockedStepIndex: number;
  resumeToken: string;
  interactionRequirement: InteractionRequirement;
  resumeStrategy: "complete_on_approve" | "rerun_with_feedback";
  status: "waiting" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  decision?: ExecutionBlockerDecision;
  feedback?: string;
};
