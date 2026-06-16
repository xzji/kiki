import type { InteractionRequirement } from "@/types/kiki";

export type ExecutionBlockerDecision = "approved" | "rejected";

export type ExecutionBlocker = {
  kind?: "interaction" | "tool_permission";
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
  toolPermission?: {
    requestId: string;
    runtimeEnvId: string;
    toolName: string;
    suggestedRule: string;
  };
};
