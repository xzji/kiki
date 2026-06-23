"use client";

import { ArtifactSummaryChip } from "@/components/execution/ArtifactRenderer";
import { buildInstanceCardTitle } from "@/components/task/ExecutionResultBody";
import { SubmittedInteractionPanel } from "@/components/task/AwaitingUserResumePanel";
import { ToolPermissionRequestDialog } from "@/components/runtime/ToolPermissionRequestDialog";
import { OptionalFeedbackSuggestions } from "@/components/task/OptionalFeedbackSuggestions";
import { TaskInlineResultView, canRenderInlineAgentResult } from "@/components/task/TaskInlineResultView";
import { buildAwaitingDisplayModel, stripNotificationPrefix } from "@/lib/taskInstance/awaitingDisplayModel";
import { shouldShowTaskCardMeta } from "@/lib/taskMessagePresentation";
import { getOptionalResultFeedbackRequirement, hasOptionalResultFeedback } from "@/lib/taskResult/optionalFeedback";
import { normalizeTaskResultViewKind } from "@/types/kiki";
import type { Task, TaskInstance } from "@/types/kiki";
import type { ClaudeStreamEvent } from "@/types/runtime";

const EXECUTION_KIND_LABEL: Record<Task["executionKind"], string> = {
  generic_result: "Agent 任务",
};

function awaitingStatusLabel(task: Task, instance: TaskInstance) {
  const displayModel = buildAwaitingDisplayModel(task, instance, "card");
  if (displayModel.active) return displayModel.statusLabel;
  const type = instance.awaitingUser?.interactionRequirement?.type ?? instance.result?.interactionRequirement?.type;
  if (type === "answer") return "需作答";
  if (type === "provide_context") return "需填写";
  if (type === "perform_offline_action") return "需线下完成";
  if (type === "agent_revision_required") return "等待 Agent 补齐";
  if (type === "deliverable_gap") return "未通过验收";
  return "需确认";
}

function hasSubmittedInteraction(instance: TaskInstance) {
  return Boolean(instance.result?.interactionSubmission && !instance.awaitingUser);
}

function errorReason(instance: TaskInstance) {
  return instance.execution?.errorMessage || instance.result?.summary || instance.result?.finalMessage;
}

function buildTaskToolPermissionRequest(instance: TaskInstance): Extract<ClaudeStreamEvent, { type: "tool_permission_request" }> | null {
  const toolPermission = instance.awaitingUser?.blocker?.toolPermission ?? instance.blocker?.toolPermission;
  if (!toolPermission) return null;
  return {
    type: "tool_permission_request",
    requestId: toolPermission.requestId,
    runtimeEnvId: toolPermission.runtimeEnvId,
    toolName: toolPermission.toolName,
    suggestedRule: toolPermission.suggestedRule,
    taskInstanceId: instance.id,
  };
}

function TaskCardMetaContent({
  task,
  instance,
  statusLabel,
  badgeLabel,
  summaryText,
  hasInteractiveSurface,
  hideSummary,
}: {
  task: Task;
  instance: TaskInstance;
  statusLabel: string;
  badgeLabel: string | null;
  summaryText: string | undefined;
  hasInteractiveSurface: boolean;
  hideSummary: boolean;
}) {
  return (
    <>
      <div className="text-[15px] font-semibold text-[#1F2328]">
        {buildInstanceCardTitle(task, instance)}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
        <span>{EXECUTION_KIND_LABEL[normalizeTaskResultViewKind(task.resultViewKind ?? task.executionKind)]}</span>
        <span className="text-[#D0D7DE]">/</span>
        <span>{statusLabel}</span>
        {badgeLabel ? (
          <>
            <span className="text-[#D0D7DE]">/</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F8F1DF] px-2 py-0.5 font-medium text-[#9A7A34] before:h-1 before:w-1 before:rounded-full before:bg-current">
              {badgeLabel}
            </span>
          </>
        ) : null}
        <ArtifactSummaryChip refs={instance.result?.taskResult?.artifactRefs} hasInteractiveSurface={hasInteractiveSurface} />
      </div>
      {hideSummary ? null : (
        <div className="mt-2 line-clamp-2 text-[13px] leading-6 text-[#374151]">{summaryText}</div>
      )}
    </>
  );
}

function TaskCardMeta({
  task,
  instance,
  statusLabel,
  badgeLabel,
  summaryText,
  hasInteractiveSurface,
  hideSummary,
  interactive,
  onOpen,
}: {
  task: Task;
  instance: TaskInstance;
  statusLabel: string;
  badgeLabel: string | null;
  summaryText: string | undefined;
  hasInteractiveSurface: boolean;
  hideSummary: boolean;
  interactive: boolean;
  onOpen: () => void;
}) {
  const content = (
    <TaskCardMetaContent
      task={task}
      instance={instance}
      statusLabel={statusLabel}
      badgeLabel={badgeLabel}
      summaryText={summaryText}
      hasInteractiveSurface={hasInteractiveSurface}
      hideSummary={hideSummary}
    />
  );

  if (!interactive) return content;

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
      className="cursor-pointer rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-[#D0D7DE]"
    >
      {content}
    </div>
  );
}

/**
 * 会话消息里的任务卡片。
 * - 展示任务结果摘要
 * - 有内联产出物时：元信息平铺，产出物卡片为主体
 * - 点击元信息区域，打开右侧结果边栏
 */
export function TaskMessageCard({
  task,
  instance,
  onOpen,
  onExpandStart,
  onOptionalFeedbackSelect,
}: {
  task: Task;
  instance: TaskInstance;
  onOpen: () => void;
  /** 内联产出物全屏展开时回调，用于收起结果抽屉等 */
  onExpandStart?: () => void;
  onOptionalFeedbackSelect?: (message: string) => Promise<void> | void;
}) {
  const submittedInteraction = hasSubmittedInteraction(instance);
  const optionalFeedback = getOptionalResultFeedbackRequirement(instance);
  const isOptionalFeedbackResult = hasOptionalResultFeedback(instance);
  const awaitingDisplay = buildAwaitingDisplayModel(task, instance, "card");
  const statusLabel =
    isOptionalFeedbackResult
      ? "已结束"
      : instance.awaitingUser
      ? awaitingStatusLabel(task, instance)
      : instance.status === "completed"
      ? "已结束"
      : instance.status === "in_progress"
        ? "进行中"
        : instance.status === "awaiting_user"
          ? awaitingStatusLabel(task, instance)
          : instance.status === "paused"
            ? "已暂停"
            : instance.status === "terminated"
              ? "已终止"
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
  const hasInteractiveSurface =
    (instance.result?.taskResult?.blocks.length ?? 0) > 0 ||
    Boolean(instance.result?.taskResult?.artifactRefs?.some((ref) => ref.kind === "webapp"));
  const showInlineResult = canRenderInlineAgentResult(task, instance);
  const showMeta = shouldShowTaskCardMeta({ inlineResultVisible: showInlineResult });
  const toolPermissionRequest = buildTaskToolPermissionRequest(instance);

  const meta = showMeta ? (
    <TaskCardMeta
      task={task}
      instance={instance}
      statusLabel={statusLabel}
      badgeLabel={badgeLabel}
      summaryText={summaryText}
      hasInteractiveSurface={hasInteractiveSurface}
      hideSummary={awaitingDisplay.hideOuterSummary}
      interactive={showInlineResult}
      onOpen={onOpen}
    />
  ) : null;

  const interactionPanels = (
    <>
      {toolPermissionRequest ? (
        <div className="mt-4" onClick={(event) => event.stopPropagation()}>
          <ToolPermissionRequestDialog
            request={toolPermissionRequest}
            variant="inline"
            onResolved={() => undefined}
          />
        </div>
      ) : instance.result?.interactionSubmission ? (
        <div className="mt-4" onClick={(event) => event.stopPropagation()}>
          <SubmittedInteractionPanel instance={instance} />
        </div>
      ) : null}
    </>
  );

  const inlineResult = showInlineResult ? (
    <div className="mt-4" onClick={(event) => event.stopPropagation()}>
      <TaskInlineResultView task={task} instance={instance} onExpandStart={onExpandStart} />
      {optionalFeedback ? (
        <OptionalFeedbackSuggestions requirement={optionalFeedback} onSelect={onOptionalFeedbackSelect} />
      ) : null}
    </div>
  ) : null;

  if (showInlineResult) {
    return (
      <div className="mt-3 w-full text-left">
        {interactionPanels}
        {inlineResult}
      </div>
    );
  }

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
        className="mt-3 w-full cursor-pointer rounded-[20px] border border-[#D0D7DE] bg-white p-4 text-left transition hover:border-[#111] hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[#D0D7DE] md:p-6"
    >
      {meta}
      {interactionPanels}
    </div>
  );
}
