import { appendGovernanceConversationMessage } from "@/lib/server/repositories/conversationMessagesRepository";
import type { DispatchThreadActionsResult } from "@/lib/server/governance/dispatchActions";
import type { GovernanceActionPresentation } from "@/lib/server/governance/governanceActionPresentation";

export type PushGovernanceChangeNotificationInput = {
  topicId: string;
  threadId?: string;
  dispatch?: DispatchThreadActionsResult;
  actionDetails?: GovernanceActionPresentation[];
  paused?: boolean;
  topicFailureReason?: string;
  traceId: string;
};

function buildThreadChangeText(input: PushGovernanceChangeNotificationInput) {
  const fromDetails = buildThreadChangeTextFromDetails(input.actionDetails);
  if (fromDetails) return fromDetails;

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
  const fromDetails = buildTopicChangeTextFromDetails(input.actionDetails);
  if (fromDetails) return fromDetails;

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

function buildThreadChangeTextFromDetails(details: GovernanceActionPresentation[] | undefined) {
  const important = (details ?? []).filter(
    (detail): detail is Extract<GovernanceActionPresentation, { scope: "thread" }> =>
      detail.scope === "thread" &&
      (detail.kind === "dispatch_task" ||
        detail.kind === "update_task" ||
        detail.kind === "cancel_task" ||
        detail.kind === "archive_thread"),
  );
  if (important.length === 0) return null;
  if (important.length === 1) {
    const detail = important[0]!;
    if (detail.kind === "update_task") {
      const firstChange = detail.fieldChanges?.[0];
      const changeText = firstChange
        ? `：${firstChange.label} 从「${firstChange.before ?? "未设置"}」改为「${firstChange.after ?? "未设置"}」`
        : "";
      return `线程治理更新：${detail.summary}${changeText}。${reasonSuffix(detail.reason)}`;
    }
    return `线程治理更新：${detail.summary}。${reasonSuffix(detail.reason)}`;
  }

  const counts = {
    dispatch_task: important.filter((detail) => detail.kind === "dispatch_task").length,
    update_task: important.filter((detail) => detail.kind === "update_task").length,
    cancel_task: important.filter((detail) => detail.kind === "cancel_task").length,
    archive_thread: important.filter((detail) => detail.kind === "archive_thread").length,
  };
  const parts: string[] = [];
  if (counts.dispatch_task > 0) parts.push(`新增 ${counts.dispatch_task} 个任务`);
  if (counts.update_task > 0) parts.push(`调整 ${counts.update_task} 个任务`);
  if (counts.cancel_task > 0) parts.push(`取消 ${counts.cancel_task} 个任务`);
  if (counts.archive_thread > 0) parts.push("归档 Thread");
  return `线程治理更新：${parts.join("、")}。${reasonSuffix(important[0]?.reason)}`;
}

function buildTopicChangeTextFromDetails(details: GovernanceActionPresentation[] | undefined) {
  const important = (details ?? []).filter(
    (detail): detail is Extract<GovernanceActionPresentation, { scope: "topic" }> =>
      detail.scope === "topic" &&
      (detail.kind === "mark_completed" ||
        detail.kind === "mark_failed" ||
        detail.kind === "adjust_loop" ||
        (detail.kind === "mark_running" && detail.summary.includes("恢复"))),
  );
  if (important.length === 0) return null;
  const detail = important[0]!;
  return `主题治理更新：${detail.summary}。${reasonSuffix(detail.reason)}`;
}

function reasonSuffix(reason: string | undefined) {
  if (!reason?.trim()) return "";
  const clipped = reason.length > 80 ? `${reason.slice(0, 79)}…` : reason;
  return `原因：${clipped}`;
}
