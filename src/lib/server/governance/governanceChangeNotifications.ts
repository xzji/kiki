import { appendGovernanceConversationMessage } from "@/lib/server/repositories/conversationMessagesRepository";
import type { DispatchThreadActionsResult } from "@/lib/server/governance/dispatchActions";

export type PushGovernanceChangeNotificationInput = {
  topicId: string;
  threadId?: string;
  dispatch?: DispatchThreadActionsResult;
  paused?: boolean;
  topicFailureReason?: string;
  traceId: string;
};

function buildThreadChangeText(input: PushGovernanceChangeNotificationInput) {
  const dispatched = input.dispatch?.dispatchedTasks.length ?? 0;
  const updated = input.dispatch?.updatedTasks.length ?? 0;
  const cancelled = input.dispatch?.cancelledTasks.length ?? 0;
  const parts: string[] = [];
  if (dispatched > 0) parts.push(`新增 ${dispatched} 个任务`);
  if (updated > 0) parts.push(`调整 ${updated} 个任务`);
  if (cancelled > 0) parts.push(`取消 ${cancelled} 个任务`);

  if (parts.length > 0) {
    return `线程治理更新：${parts.join("、")}。`;
  }
  if (input.paused) {
    return "线程治理更新：线程已因连续失败自动暂停。";
  }
  return null;
}

function buildTopicChangeText(input: PushGovernanceChangeNotificationInput) {
  if (!input.paused && !input.topicFailureReason) return null;
  if (input.paused) return "主题治理更新：主题已自动暂停，需要检查治理状态。";
  return `主题治理更新：${input.topicFailureReason ?? "治理失败"}。`;
}

export function pushGovernanceChangeNotification(input: PushGovernanceChangeNotificationInput) {
  const text = input.threadId ? buildThreadChangeText(input) : buildTopicChangeText(input);
  if (!text) return null;
  try {
    return appendGovernanceConversationMessage({
      topicId: input.topicId,
      threadId: input.threadId,
      text,
      traceId: input.traceId,
      messageIdPrefix: input.threadId ? "msg-gov-thread" : "msg-gov-topic",
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("no conversation linked")) return null;
    throw error;
  }
}
