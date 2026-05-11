"use client";

import { useEffect, useState } from "react";

import { fetchTaskRunProgress } from "@/lib/api/taskRuns";
import { ConfirmActionView } from "@/components/execution/ConfirmActionView";
import { DraftReviewView } from "@/components/execution/DraftReviewView";
import { FlashcardView } from "@/components/execution/FlashcardView";
import { ListeningQAView } from "@/components/execution/ListeningQAView";
import { ReadingDigestView } from "@/components/execution/ReadingDigestView";
import { AwaitingUserResumePanel } from "@/components/task/AwaitingUserResumePanel";
import { GenericAgentResultView } from "@/components/task/GenericAgentResultView";
import { TaskExecutionTimeline } from "@/components/task/TaskExecutionTimeline";
import { useGoalStore } from "@/stores/goalStore";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { Goal, InteractionSubmission, Task, TaskInstance } from "@/types/kiki";

const EXECUTION_KIND_LABEL: Record<Task["executionKind"], string> = {
  flashcard: "记忆闪卡",
  listening_qa: "听力问答",
  reading_digest: "阅读摘要",
  confirm_action: "确认执行",
  draft_review: "草稿审阅",
  freeform_chat: "补充对话",
  generic_result: "Agent 任务",
};

export function buildInstanceCardTitle(task: Task, instance: TaskInstance) {
  const cleanTaskTitle = task.title.replace(/^任务\d+：/, "");
  const dateLabel = instance.dateLabel?.replace(/-/g, "") ?? "";
  return dateLabel ? `${dateLabel} ${cleanTaskTitle}` : cleanTaskTitle;
}

function trajectoryToTimeline(trajectory: ExecutionTrajectoryStep[] | undefined) {
  if (!trajectory?.length) return undefined;
  return trajectory.map((step) => ({
    id: step.id,
    title: step.title,
    type:
      step.type === "tool_call" || step.type === "tool_result"
        ? "tool" as const
        : step.type === "assistant"
          ? "assistant" as const
          : step.type === "result"
            ? "result" as const
            : "phase" as const,
    status: step.status,
    detail: step.thought,
    toolName: step.toolCall?.name,
    startedAt: step.startedAt,
    finishedAt: step.endedAt,
  }));
}

export function ExecutionResultBody(props: {
  goal: Goal;
  task: Task;
  instance: TaskInstance;
  mode?: "shell" | "result";
}) {
  const { task, instance } = props;
  const syncTaskInstanceRun = useGoalStore((state) => state.syncTaskInstanceRun);
  const completeTaskInstance = useGoalStore((state) => state.completeTaskInstance);
  const retryTaskInstanceRun = useGoalStore((state) => state.retryTaskInstanceRun);
  const stopTaskInstanceRun = useGoalStore((state) => state.stopTaskInstanceRun);
  const [refreshTick, setRefreshTick] = useState(0);
  const currentKind = task.resultViewKind ?? task.executionKind;
  const displayStatus =
    instance.status === "completed"
      ? "已完成"
      : instance.status === "awaiting_user"
        ? awaitingUserStatusLabel(instance)
        : instance.status === "in_progress"
          ? "执行中"
          : instance.status === "error"
            ? "执行失败"
            : instance.status === "paused"
              ? "已暂停"
              : "排队中";

  useEffect(() => {
    if (!instance.runner?.requestId && !instance.id) return;
    let cancelled = false;
    const poll = async () => {
      const state = await fetchTaskRunProgress({
        requestId: instance.runner?.requestId,
        taskInstanceId: instance.id,
      });
      if (cancelled) return;
      syncTaskInstanceRun({
        taskId: task.id,
        instanceId: instance.id,
        progress: state.progress,
        logs: state.logs,
        trajectory: state.trajectory,
      });
      if (state.progress?.status === "running") {
        window.setTimeout(() => {
          if (!cancelled) setRefreshTick((value) => value + 1);
        }, 1000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [instance.id, instance.runner?.requestId, refreshTick, syncTaskInstanceRun, task.id]);

  const finish = (submission: Omit<InteractionSubmission, "submittedAt">) => {
    completeTaskInstance(task.id, instance.id, {
      ...submission,
      submittedAt: new Date().toISOString(),
    });
  };
  const hasBuiltInDeliverable =
    (currentKind === "flashcard" && instance.payload.kind === "flashcard") ||
    (currentKind === "listening_qa" && instance.payload.kind === "listening_qa") ||
    (currentKind === "reading_digest" && instance.payload.kind === "reading_digest") ||
    (currentKind === "confirm_action" && instance.payload.kind === "confirm_action") ||
    (currentKind === "draft_review" && instance.payload.kind === "draft_review");
  const shouldRenderGenericDeliverable =
    (currentKind === "generic_result" || instance.payload.kind === "generic_result" || !instance.payload) &&
    Boolean(instance.result?.taskResult);
  const hasDeliverable = hasBuiltInDeliverable || shouldRenderGenericDeliverable;
  const resultBlock = hasDeliverable ? (
    <div>
      <div className="mb-3 text-[13px] font-medium text-[#1F2328]">产出物</div>
      {currentKind === "flashcard" && instance.payload.kind === "flashcard" ? (
        <FlashcardView
          cards={instance.payload.cards}
          onComplete={() =>
            finish({
              type: "answer",
              status: "completed",
              action: "记忆练习",
              feedback: "已完成全部闪卡",
            })
          }
        />
      ) : null}
      {currentKind === "listening_qa" && instance.payload.kind === "listening_qa" ? (
        <ListeningQAView
          questions={instance.payload.questions}
          onComplete={() =>
            finish({
              type: "answer",
              status: "completed",
              action: "听力作答",
              feedback: "已完成全部题目",
            })
          }
        />
      ) : null}
      {currentKind === "reading_digest" && instance.payload.kind === "reading_digest" ? (
        <ReadingDigestView
          articles={instance.payload.articles}
          onComplete={() =>
            finish({
              type: "perform_offline_action",
              status: "completed",
              action: "阅读材料",
              feedback: "已标记已读",
            })
          }
        />
      ) : null}
      {currentKind === "confirm_action" && instance.payload.kind === "confirm_action" ? (
        <ConfirmActionView
          summary={instance.payload.summary}
          onConfirm={() =>
            finish({
              type: "confirm",
              status: "confirmed",
              action: "确认执行",
              approved: true,
              feedback: "已确认执行",
            })
          }
          onRevise={() =>
            finish({
              type: "confirm",
              status: "rejected",
              action: "要求修改",
              approved: false,
              feedback: "用户要求 KiKi 修改方案",
            })
          }
        />
      ) : null}
      {currentKind === "draft_review" && instance.payload.kind === "draft_review" ? (
        <DraftReviewView
          drafts={instance.payload.drafts}
          onComplete={() =>
            finish({
              type: "confirm",
              status: "confirmed",
              action: "草稿确认",
              approved: true,
              feedback: "已完成草稿审阅",
            })
          }
          onRewrite={() =>
            finish({
              type: "confirm",
              status: "rejected",
              action: "要求重写",
              approved: false,
              feedback: "用户要求 KiKi 重写草稿",
            })
          }
        />
      ) : null}
      {shouldRenderGenericDeliverable ? (
        <GenericAgentResultView
          summary={instance.result?.summary}
          finalMessage={instance.result?.finalMessage}
          taskResult={instance.result?.taskResult}
          artifacts={instance.result?.artifacts}
          structuredOutput={instance.result?.structuredOutput}
          notification={instance.notification}
        />
      ) : null}
      {instance.awaitingUser ? (
        <div className="mt-4">
          <AwaitingUserResumePanel task={task} instance={instance} onRunning={() => setRefreshTick((value) => value + 1)} />
        </div>
      ) : null}
    </div>
  ) : instance.awaitingUser ? (
    <AwaitingUserResumePanel task={task} instance={instance} onRunning={() => setRefreshTick((value) => value + 1)} />
  ) : null;
  const timelineBlock = (
    <details className="rounded-xl border border-[#E5E7EB] bg-white" open={instance.notification?.detailPolicy.showTimelineByDefault || instance.status === "in_progress"}>
      <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium text-[#1F2328]">
        执行链路
      </summary>
      <div className="border-t border-[#E5E7EB] p-4">
        <TaskExecutionTimeline steps={trajectoryToTimeline(instance.trajectory) ?? instance.timeline ?? []} />
      </div>
    </details>
  );
  const resultFirst = instance.status === "completed" || instance.status === "awaiting_user";

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-[#E5E7EB] bg-white p-6">
        <div className="mb-3 text-[13px] font-medium text-[#1F2328]">任务信息</div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[15px] font-semibold text-[#1F2328]">
              {buildInstanceCardTitle(task, instance)}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
              <span>{EXECUTION_KIND_LABEL[currentKind]}</span>
              <span className="text-[#D0D7DE]">/</span>
              <span>{displayStatus}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {instance.status === "error" || instance.status === "paused" ? (
              <button
                type="button"
                onClick={() => retryTaskInstanceRun(task.id, instance.id)}
                className="rounded-md border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] text-[#1F2328] hover:border-[#111]"
              >
                重试
              </button>
            ) : null}
            {instance.status === "in_progress" ? (
              <button
                type="button"
                onClick={() => stopTaskInstanceRun(task.id, instance.id)}
                className="rounded-md border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] text-[#1F2328] hover:border-[#111]"
              >
                停止
              </button>
            ) : null}
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-[#E5E7EB] bg-[#F8F9FB] px-4 py-3">
          <div className="text-[12px] text-[#8C9198]">预期产出</div>
          <div className="mt-1 text-[13px] leading-6 text-[#1F2328]">{task.expectedOutcome}</div>
        </div>
        <div className="mt-4 rounded-xl border border-[#E5E7EB] bg-[#F8F9FB] px-4 py-3 text-[12px] text-[#6B7280]">
          {instance.execution?.lastUpdatedAt ? `最近更新：${new Date(instance.execution.lastUpdatedAt).toLocaleString("zh-CN")}` : "等待调度器同步执行状态"}
        </div>
      </div>
      {resultFirst ? resultBlock : timelineBlock}
      {resultFirst ? timelineBlock : resultBlock}
    </div>
  );
}

function awaitingUserStatusLabel(instance: TaskInstance) {
  const type = instance.awaitingUser?.interactionRequirement?.type ?? instance.result?.interactionRequirement?.type;
  if (type === "answer") return "待作答";
  if (type === "provide_context") return "待补充";
  if (type === "perform_offline_action") return "待线下完成";
  if (type === "agent_revision_required") return "等待 Agent 补齐";
  if (type === "deliverable_gap") return "未通过验收";
  return "待确认";
}
