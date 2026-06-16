import type {
  MessageFeedbackRating,
  MessageFeedbackReasonCode,
  MessageFeedbackRecord,
  MessageFeedbackTargetFallback,
} from "@/types/messageFeedback";

type ApiErrorPayload = {
  reason?: string;
};

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & ApiErrorPayload;
  if (!response.ok) {
    throw new Error(data.reason || "消息反馈请求失败");
  }
  return data;
}

export async function fetchMessageFeedbacks(conversationId: string) {
  const search = new URLSearchParams({ conversationId });
  const response = await fetch(`/api/message-feedback?${search.toString()}`, {
    method: "GET",
    cache: "no-store",
  });
  const data = await parseJsonResponse<{
    ok?: boolean;
    reason?: string;
    feedbacks?: MessageFeedbackRecord[];
  }>(response);
  if (!data.ok) {
    throw new Error(data.reason || "读取消息反馈失败");
  }
  return data.feedbacks ?? [];
}

export async function submitMessageFeedback(input: {
  conversationId: string;
  messageId: string;
  rating: MessageFeedbackRating;
  reasonCodes?: MessageFeedbackReasonCode[];
  comment?: string;
  runtimeEnvId?: string;
  targetMessageFallback?: MessageFeedbackTargetFallback;
}) {
  const response = await fetch("/api/message-feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJsonResponse<{
    ok?: boolean;
    reason?: string;
    feedback?: MessageFeedbackRecord;
  }>(response);
  if (!data.ok || !data.feedback) {
    throw new Error(data.reason || "保存消息反馈失败");
  }
  return data.feedback;
}

export async function deleteMessageFeedback(input: {
  conversationId: string;
  messageId: string;
}) {
  const search = new URLSearchParams({
    conversationId: input.conversationId,
    messageId: input.messageId,
  });
  const response = await fetch(`/api/message-feedback?${search.toString()}`, {
    method: "DELETE",
  });
  const data = await parseJsonResponse<{
    ok?: boolean;
    reason?: string;
  }>(response);
  if (!data.ok) {
    throw new Error(data.reason || "取消消息反馈失败");
  }
}
