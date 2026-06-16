import type { ConversationMessage } from "@/types/kiki";

export type MessageFeedbackRating = "good" | "bad";

export const MESSAGE_FEEDBACK_REASON_CODES = [
  "not_helpful",
  "incorrect",
  "missed_context",
  "too_verbose",
  "unsafe_or_risky",
  "other",
] as const;

export type MessageFeedbackReasonCode = (typeof MESSAGE_FEEDBACK_REASON_CODES)[number];

export type MessageFeedbackSnapshotMessage = {
  id: string;
  kind: ConversationMessage["kind"];
  role: ConversationMessage["role"];
  content: string;
  createdAt: string;
  status?: ConversationMessage["status"];
  source?: ConversationMessage["source"];
  truncated?: boolean;
  refs?: {
    taskRef?: Extract<ConversationMessage, { kind: "task_card" }>["taskRef"];
    goalRef?: Extract<ConversationMessage, { kind: "goal_plan_card" }>["goalRef"];
    sagaRequestId?: string;
    cliProcessRunId?: string;
    governanceIntent?: string;
  };
};

export type MessageFeedbackContextSnapshot = {
  conversationId: string;
  runtimeEnvId?: string;
  createdAt: string;
  source: "database" | "client_fallback";
  targetMessage: MessageFeedbackSnapshotMessage;
  previousMessages: MessageFeedbackSnapshotMessage[];
};

export type MessageFeedbackRecord = {
  id: string;
  conversationId: string;
  messageId: string;
  rating: MessageFeedbackRating;
  reasonCodes: MessageFeedbackReasonCode[];
  comment?: string;
  contextSnapshot: MessageFeedbackContextSnapshot;
  runtimeEnvId?: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageFeedbackTargetFallback = {
  id: string;
  kind: "text";
  role: "kiki";
  content: string;
  createdAt: string;
  status?: ConversationMessage["status"];
  source?: ConversationMessage["source"];
};
