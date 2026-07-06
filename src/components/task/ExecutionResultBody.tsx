"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { fetchTaskRunProgress } from "@/lib/api/taskRuns";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { AwaitingUserResumePanel, SubmittedInteractionPanel } from "@/components/task/AwaitingUserResumePanel";
import { GenericAgentResultView } from "@/components/task/GenericAgentResultView";
import { TaskExecutionTimeline } from "@/components/task/TaskExecutionTimeline";
import { getTaskDependencyViews } from "@/lib/taskDependencies";
import { summarizeToolOperation } from "@/lib/execution/summarizeToolOperation";
import { runTaskExecutionAction } from "@/lib/taskExecution";
import { buildAwaitingDisplayModel } from "@/lib/taskInstance/awaitingDisplayModel";
import { hasOptionalResultFeedback } from "@/lib/taskResult/optionalFeedback";
import { useGoalStore } from "@/stores/goalStore";
import type { AgentRunPlan } from "@/types/agentOrchestration";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import { normalizeTaskResultViewKind } from "@/types/kiki";
import type { Goal, InteractionSubmission, Task, TaskInstance } from "@/types/kiki";

const EXECUTION_KIND_LABEL: Record<Task["executionKind"], string> = {
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
    agentRole: step.agentRole,
    detail: step.thought ?? summarizeToolOperation(step.toolCall?.name, step.toolCall?.input),
    toolName: step.toolCall?.name,
    toolInput: step.toolCall?.input,
    handoff: step.handoff,
    startedAt: step.startedAt,
    finishedAt: step.endedAt,
  }));
}

function applyWaitingReasonToSteps(steps: NonNullable<Task["instances"][number]["timeline"]>, waitingReason: string | undefined) {
  if (!waitingReason?.trim()) return steps;
  const nextSteps = [...steps];
  for (let index = nextSteps.length - 1; index >= 0; index -= 1) {
    const step = nextSteps[index];
    if (step.toolName) continue;
    if (step.status !== "pending" && step.status !== "running") continue;
    if (!/等待 Agent 开始执行|调度器已生成任务实例|任务已创建/.test(step.title)) continue;
    nextSteps[index] = {
      ...step,
      detail: waitingReason.trim(),
    };
    return nextSteps;
  }
  return nextSteps.concat({
    id: `waiting-reason-${nextSteps.at(-1)?.id ?? "step"}`,
    title: "等待 Agent 开始执行",
    type: "phase",
    status: "pending",
    detail: waitingReason.trim(),
    startedAt: nextSteps.at(-1)?.startedAt ?? new Date().toISOString(),
  });
}

function isAgentRunPlan(value: unknown): value is AgentRunPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AgentRunPlan>;
  return candidate.schemaVersion === 1 && candidate.mode === "role_collaboration" && Array.isArray(candidate.roles);
}

function getAgentRunPlan(instance: TaskInstance) {
  const metaPlan = instance.result?.taskResult?.meta?.agentRunPlan;
  if (isAgentRunPlan(metaPlan)) return metaPlan;
  const structuredPlan = instance.result?.structuredOutput?.agentRunPlan;
  if (isAgentRunPlan(structuredPlan)) return structuredPlan;
  return undefined;
}

function formatInteractionTime(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function getSubmittedInteractionText(submission: InteractionSubmission | undefined) {
  if (!submission) return undefined;
  const fieldLines = Object.entries(submission.fields ?? {})
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}：${value}`);
  if (fieldLines.length) return fieldLines.join("\n");
  return submission.feedback || submission.action;
}

function hasGenericDeliverableContent(instance: TaskInstance) {
  const taskResult = instance.result?.taskResult;
  if (!taskResult) return false;
  return (
    Boolean(taskResult.blocks?.length) ||
    Boolean(taskResult.artifactRefs?.length)
  );
}

function shouldDeferConcreteResultUntilUserInput(instance: TaskInstance) {
  const requirement = instance.awaitingUser?.interactionRequirement ?? instance.result?.interactionRequirement;
  if (!instance.awaitingUser || !requirement) return false;
  if (hasOptionalResultFeedback(instance)) return false;
  if (requirement.type === "confirm" && requirement.timing === "after_agent_output") {
    return instance.result?.taskResult?.status === "done";
  }
  return (
    requirement.type === "answer" ||
    requirement.type === "provide_context" ||
    requirement.type === "perform_offline_action" ||
    requirement.timing === "before_execution" ||
    requirement.timing === "during_execution" ||
    requirement.timing === "core_task_step"
  );
}

export function ExecutionResultBody(props: {
  goal: Goal;
  task: Task;
  instance: TaskInstance;
  mode?: "shell" | "result";
}) {
  const { goal, task, instance } = props;
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const [refreshTick, setRefreshTick] = useState(0);
  const awaitingDisplay = buildAwaitingDisplayModel(task, instance, "detail");
  const currentKind = normalizeTaskResultViewKind(task.resultViewKind ?? task.executionKind);
  const optionalFeedbackResult = hasOptionalResultFeedback(instance);
  const displayStatus =
    optionalFeedbackResult || instance.status === "completed"
      ? "已结束"
      : instance.status === "awaiting_user"
        ? awaitingUserStatusLabel(instance)
        : instance.status === "in_progress"
          ? "执行中"
          : instance.status === "error"
            ? "执行失败"
            : instance.status === "paused"
              ? "已暂停"
              : instance.status === "terminated"
                ? "已终止"
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
      const snapshot = await fetchRuntimeStateSnapshot();
      if (!cancelled) applyGoalsProjection(snapshot.goals, snapshot.meta?.revisions?.goals);
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
  }, [applyGoalsProjection, instance.id, instance.runner?.requestId, refreshTick]);

  const hasGenericResultContent =
    Boolean(instance.result?.taskResult) ||
    Boolean(instance.result?.summary) ||
    Boolean(instance.result?.finalMessage) ||
    Boolean(instance.result?.artifacts?.length);
  const shouldRenderGenericDeliverable =
    hasGenericResultContent || hasGenericDeliverableContent(instance);
  const agentRunPlan = getAgentRunPlan(instance);
  const shouldRenderConcreteDeliverable =
    shouldRenderGenericDeliverable && !shouldDeferConcreteResultUntilUserInput(instance);
  const dependencyViews = getTaskDependencyViews(goal, task);
  const resultBlock = shouldRenderConcreteDeliverable ? (
    <div>
      <div className="mb-3 text-[13px] font-medium text-ink">产出物</div>
      <GenericAgentResultView
        summary={instance.result?.summary}
        finalMessage={instance.result?.finalMessage}
        taskResult={instance.result?.taskResult}
        artifacts={instance.result?.artifacts}
        structuredOutput={instance.result?.structuredOutput}
        notification={instance.notification}
        hidePendingUserPlaceholder={awaitingDisplay.hidePendingTaskResultBlocks}
      />
    </div>
  ) : null;
  const interactionTurn = instance.awaitingUser && !optionalFeedbackResult ? (
    <AwaitingUserResumePanel task={task} instance={instance} onRunning={() => setRefreshTick((value) => value + 1)} />
  ) : instance.result?.interactionSubmission ? (
    <SubmittedInteractionPanel instance={instance} />
  ) : undefined;
  const userSubmissionText = getSubmittedInteractionText(instance.result?.interactionSubmission);
  const interactionTime = formatInteractionTime(
    instance.result?.interactionSubmission?.submittedAt ?? instance.execution?.lastUpdatedAt,
  );
  const timelineBlock = (
    <section>
      <details className="group/process">
        <summary className="mb-4 flex cursor-pointer list-none items-center justify-between gap-3 marker:hidden select-none [&::-webkit-details-marker]:hidden">
          <div>
            <div className="text-[15px] font-bold text-ink">执行过程</div>
            <div className="mt-0.5 text-[12px] text-ink-faint">
              {agentRunPlan?.mode === "role_collaboration"
                ? `${agentRunPlan.strategy} · 多 Agent 协同`
                : "single_agent · KiKi"}
            </div>
          </div>
          <span className="inline-block h-[8px] w-[8px] -rotate-45 border-r-2 border-b-2 border-ink-faint transition group-open/process:rotate-45" />
        </summary>
        <TaskExecutionTimeline
          steps={applyWaitingReasonToSteps(
            trajectoryToTimeline(instance.trajectory) ?? instance.timeline ?? [],
            instance.execution?.waitingReason,
          )}
          agentRunPlan={agentRunPlan}
          interactionTurn={interactionTurn}
          userSubmissionText={userSubmissionText}
          interactionTime={interactionTime}
        />
      </details>
    </section>
  );

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-line bg-white p-4 md:p-6">
        <div className="mb-3 text-[13px] font-medium text-ink">任务信息</div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[15px] font-semibold text-ink">
              {buildInstanceCardTitle(task, instance)}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-faint">
              <span>{EXECUTION_KIND_LABEL[currentKind]}</span>
              <span className="text-line-strong">/</span>
              <span>{displayStatus}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {instance.status === "error" || instance.status === "paused" || instance.status === "terminated" ? (
              <button
                type="button"
                onClick={() => {
                  void runTaskExecutionAction(task.id, instance.status === "paused" ? "resume" : "rerun", {
                    instanceId: instance.id,
                  }).catch((error) => {
                    toast.error(error instanceof Error ? error.message : "任务执行失败");
                  });
                }}
                className="rounded-md border border-line-strong bg-white px-3 py-1.5 text-[12px] text-ink hover:border-[#111]"
              >
                {instance.status === "paused" ? "继续执行本次" : instance.status === "terminated" ? "重新执行" : "重试本次"}
              </button>
            ) : null}
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-line bg-surface-hover px-3 py-3 md:px-4">
          <div className="text-[12px] text-ink-faint">预期产出</div>
          <div className="mt-1 text-[13px] leading-6 text-ink">{task.expectedOutcome}</div>
        </div>
        {dependencyViews.length ? (
          <div className="mt-4 rounded-xl border border-line bg-surface-hover px-3 py-3 md:px-4">
            <div className="text-[12px] text-ink-faint">依赖任务</div>
            <div className="mt-2 space-y-2">
              {dependencyViews.map((dependency) => (
                <div key={dependency.id} className="space-y-1 text-[13px] leading-6">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{dependency.displayTitle}</span>
                    <span className="font-mono text-[11px] text-ink-faint">
                      {dependency.missing ? `引用 ID：${dependency.taskId}` : `任务 ID：${dependency.taskId}`}
                    </span>
                    <span
                      className={
                        dependency.missing
                          ? "rounded-md bg-danger-bg px-2 py-0.5 text-[11px] text-danger-hover"
                          : dependency.satisfied
                            ? "rounded-md bg-success-bg px-2 py-0.5 text-[11px] text-success-strong"
                            : "rounded-md bg-surface px-2 py-0.5 text-[11px] text-ink-soft"
                      }
                    >
                      {dependency.statusLabel}
                    </span>
                  </div>
                  <div className="text-[12px] leading-5 text-ink-soft">
                    需要信息：{dependency.expectedOutcome || "依赖任务本身不存在，无法读取预期产出。"}
                  </div>
                  <div className={dependency.missing ? "text-[12px] leading-5 text-danger-hover" : "text-[12px] leading-5 text-ink-soft"}>
                    当前原因：{dependency.reason}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="mt-4 rounded-xl border border-line bg-surface-hover px-3 py-3 text-[12px] text-ink-soft md:px-4">
          {instance.execution?.lastUpdatedAt ? `最近更新：${new Date(instance.execution.lastUpdatedAt).toLocaleString("zh-CN")}` : "等待调度器同步执行状态"}
        </div>
      </div>
      {timelineBlock}
      {resultBlock}
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
