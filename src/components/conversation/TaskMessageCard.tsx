"use client";

import { ArtifactSummaryChip } from "@/components/execution/ArtifactRenderer";
import { buildInstanceCardTitle } from "@/components/task/ExecutionResultBody";
import { AwaitingUserResumePanel, SubmittedInteractionPanel } from "@/components/task/AwaitingUserResumePanel";
import { OptionalFeedbackSuggestions } from "@/components/task/OptionalFeedbackSuggestions";
import { TaskInlineResultView, canRenderInlineAgentResult } from "@/components/task/TaskInlineResultView";
import { canStopTaskInstance, runTaskExecutionAction } from "@/lib/taskExecution";
import { getOptionalResultFeedbackRequirement, hasOptionalResultFeedback } from "@/lib/taskResult/optionalFeedback";
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

function hasSubmittedInteraction(instance: TaskInstance) {
  return Boolean(instance.result?.interactionSubmission && !instance.awaitingUser);
}

function errorReason(instance: TaskInstance) {
  return instance.execution?.errorMessage || instance.result?.summary || instance.result?.finalMessage;
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
  onOptionalFeedbackSelect,
}: {
  task: Task;
  instance: TaskInstance;
  onOpen: () => void;
  onOptionalFeedbackSelect?: (message: string) => Promise<void> | void;
}) {
  const submittedInteraction = hasSubmittedInteraction(instance);
  const optionalFeedback = getOptionalResultFeedbackRequirement(instance);
  const isOptionalFeedbackResult = hasOptionalResultFeedback(instance);
  const statusLabel =
    isOptionalFeedbackResult
      ? "已结束"
      : instance.awaitingUser
      ? awaitingStatusLabel(instance)
      : instance.status === "completed"
      ? "已结束"
      : instance.status === "in_progress"
        ? "进行中"
        : instance.status === "awaiting_user"
          ? awaitingStatusLabel(instance)
          : instance.status === "paused"
            ? "已暂停"
            : "待处理";
  const badgeLabel =
    submittedInteraction || isOptionalFeedbackResult
      ? null
      : instance.notification?.badge === "need_confirm"
        ? "需要确认"
        : instance.notification?.badge === "need_answer"
          ? "需要作答"
          : null;
  const summaryText =
    (instance.status === "error" ? errorReason(instance) : undefined) ||
    (submittedInteraction ? undefined : stripNotificationPrefix(instance.notification?.snippet)) ||
    instance.result?.summary ||
    instance.awaitingUser?.reason ||
    instance.intro;
  const canStop = !isOptionalFeedbackResult && canStopTaskInstance(instance);
  const hasInteractiveSurface =
    (instance.result?.taskResult?.blocks.length ?? 0) > 0 ||
    Boolean(instance.result?.taskResult?.artifactRefs?.some((ref) => ref.kind === "webapp"));
  const showInlineResult = canRenderInlineAgentResult(task, instance);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="mt-3 w-full cursor-pointer rounded-[20px] bg-white p-6 text-left shadow-[0_1px_0_rgba(17,17,17,0.06),0_18px_50px_rgba(17,17,17,0.035)] transition hover:shadow-[0_1px_0_rgba(17,17,17,0.08),0_20px_56px_rgba(17,17,17,0.05)] focus:outline-none focus:ring-2 focus:ring-[#D0D7DE]"
    >
      <div className="flex items-start gap-3">
        <div className="block min-w-0 flex-1 text-left">
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
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F8F1DF] px-2 py-0.5 font-medium text-[#9A7A34] before:h-1 before:w-1 before:rounded-full before:bg-current">{badgeLabel}</span>
              </>
            ) : null}
            <ArtifactSummaryChip refs={instance.result?.taskResult?.artifactRefs} hasInteractiveSurface={hasInteractiveSurface} />
          </div>
          <div className="mt-2 line-clamp-2 text-[13px] leading-6 text-[#374151]">
            {summaryText}
          </div>
        </div>
        {canStop ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void runTaskExecutionAction(task.id, "pause", {
                instanceId: instance.id,
              }).catch((error) => {
                window.alert(error instanceof Error ? error.message : "任务停止失败");
              });
            }}
            className="shrink-0 bg-transparent px-0 py-1 text-[13px] text-[#B4534C]/75 hover:text-[#B4534C]"
          >
            停止执行
          </button>
        ) : null}
      </div>
      {instance.awaitingUser && !isOptionalFeedbackResult ? (
        <div className="mt-4" onClick={(event) => event.stopPropagation()}>
          <AwaitingUserResumePanel task={task} instance={instance} />
        </div>
      ) : instance.result?.interactionSubmission ? (
        <div className="mt-4" onClick={(event) => event.stopPropagation()}>
          <SubmittedInteractionPanel instance={instance} />
        </div>
      ) : null}
      {showInlineResult ? (
        <div onClick={(event) => event.stopPropagation()}>
          <TaskInlineResultView task={task} instance={instance} />
          {optionalFeedback ? (
            <OptionalFeedbackSuggestions
              requirement={optionalFeedback}
              onSelect={onOptionalFeedbackSelect}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
