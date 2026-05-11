"use client";

import { buildInstanceCardTitle } from "@/components/task/ExecutionResultBody";
import { AwaitingUserResumePanel } from "@/components/task/AwaitingUserResumePanel";
import type { Task, TaskInstance } from "@/types/kiki";

const EXECUTION_KIND_LABEL: Record<Task["executionKind"], string> = {
  flashcard: "记忆闪卡",
  listening_qa: "听力问答",
  reading_digest: "阅读摘要",
  confirm_action: "确认执行",
  draft_review: "草稿审阅",
  freeform_chat: "补充对话",
  generic_result: "Agent 任务",
};

function stripNotificationPrefix(snippet?: string | null) {
  if (!snippet) return snippet;
  return snippet.replace(/^\[(需要作答|需要确认|待补充|待完成)\]\s*/, "");
}

function awaitingStatusLabel(instance: TaskInstance) {
  const type = instance.awaitingUser?.interactionRequirement?.type ?? instance.result?.interactionRequirement?.type;
  if (type === "answer") return "待作答";
  if (type === "provide_context") return "待补充";
  if (type === "perform_offline_action") return "待线下完成";
  if (type === "agent_revision_required") return "等待 Agent 补齐";
  if (type === "deliverable_gap") return "未通过验收";
  return "待确认";
}

/**
 * 会话消息里的任务卡片。
 * - 展示任务结果摘要
 * - 点击整张卡片，打开右侧结果边栏
 */
export function TaskMessageCard({
  task,
  instance,
  onOpen,
}: {
  task: Task;
  instance: TaskInstance;
  onOpen: () => void;
}) {
  const statusLabel =
    instance.awaitingUser
      ? awaitingStatusLabel(instance)
      : instance.status === "completed"
      ? "已完成"
      : instance.status === "in_progress"
        ? "进行中"
        : instance.status === "awaiting_user"
          ? awaitingStatusLabel(instance)
          : instance.status === "paused"
            ? "已暂停"
            : "待处理";
  const badgeLabel =
    instance.notification?.badge === "need_confirm"
      ? "需要确认"
      : instance.notification?.badge === "need_answer"
        ? "需要作答"
        : null;
  const summaryText =
    stripNotificationPrefix(instance.notification?.snippet) ||
    instance.result?.summary ||
    instance.awaitingUser?.reason ||
    instance.intro;
  return (
    <div className="mt-3 w-full rounded-xl border border-[#E5E7EB] bg-white p-5 text-left">
      <button type="button" onClick={onOpen} className="block w-full text-left hover:opacity-90">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-[#1F2328]">
            {buildInstanceCardTitle(task, instance)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
            <span>{EXECUTION_KIND_LABEL[task.resultViewKind ?? task.executionKind]}</span>
            <span className="text-[#D0D7DE]">/</span>
            <span>{statusLabel}</span>
            {badgeLabel ? (
              <>
                <span className="text-[#D0D7DE]">/</span>
                <span className="rounded-full bg-[#FFF3CD] px-2 py-0.5 text-[#8A6D3B]">{badgeLabel}</span>
              </>
            ) : null}
          </div>
          <div className="mt-2 line-clamp-2 text-[13px] leading-6 text-[#374151]">
            {summaryText}
          </div>
        </div>
      </button>
      {instance.awaitingUser ? (
        <div className="mt-4">
          <AwaitingUserResumePanel task={task} instance={instance} />
        </div>
      ) : null}
    </div>
  );
}
