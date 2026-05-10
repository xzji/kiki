"use client";

import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { TaskEditDrawer } from "@/components/goal/TaskEditDrawer";
import { GenericAgentResultView } from "@/components/task/GenericAgentResultView";
import { runTaskExecutionAction } from "@/lib/taskExecution";
import { fetchTaskRunProgress } from "@/lib/api/taskRuns";
import { cn } from "@/lib/utils";
import { useGoalStore } from "@/stores/goalStore";
import type { Task, TaskExecutionStep, TaskInstance } from "@/types/kiki";

const TASK_TYPE_LABEL: Record<Task["taskType"], string> = {
  daily_repeat: "每日重复",
  one_shot: "一次性",
  monitoring: "监控追踪",
};

const EXECUTION_LABEL: Record<Task["executionKind"], string> = {
  flashcard: "记忆闪卡",
  listening_qa: "听力问答",
  reading_digest: "阅读摘要",
  confirm_action: "确认执行",
  draft_review: "草稿审阅",
  freeform_chat: "补充对话",
  generic_result: "Agent 任务",
};

const SECTION_COPY = {
  pending: {
    title: "待执行",
    description: "等待触发或等待再次开始的任务卡片。",
    empty: "暂无待执行任务卡片",
  },
  running: {
    title: "执行中",
    description: "可展开查看持续滚动的执行信息流。",
    empty: "暂无执行中的任务卡片",
  },
  completed: {
    title: "已完成",
    description: "可展开查看完整执行信息流与最终结果。",
    empty: "暂无已完成任务卡片",
  },
} as const;

type SectionKey = keyof typeof SECTION_COPY;

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isVisibleExecutionStep(step: TaskExecutionStep) {
  return step.toolName !== "debug.stream_event";
}

export function TaskDetailBody({
  task,
}: {
  task: Task;
}) {
  const [metaOpen, setMetaOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [expandedInstanceId, setExpandedInstanceId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [sectionOpen, setSectionOpen] = useState<Record<SectionKey, boolean>>({
    pending: pendingLength(task) > 0,
    running: runningLength(task) > 0,
    completed: completedLength(task) > 0,
  });
  const deleteTask = useGoalStore((state) => state.deleteTask);
  const syncTaskInstanceRun = useGoalStore((state) => state.syncTaskInstanceRun);

  const taskState = getTaskDisplayState(task);
  const statusLabel =
    taskState === "completed" ? "已完成" : taskState === "in_progress" ? "进行中" : taskState === "paused" ? "已暂停" : "待开始";
  const executionAction = getExecutionAction(task, taskState);
  const cleanTitle = task.title.replace(/^任务\d+：/, "");

  const sortedInstances = useMemo(
    () => [...task.instances].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
    [task.instances],
  );
  const pendingInstances = useMemo(
    () => sortedInstances.filter((item) => item.status === "pending" || item.status === "paused" || item.status === "error"),
    [sortedInstances],
  );
  const runningInstances = useMemo(
    () => sortedInstances.filter((item) => item.status === "in_progress" || item.status === "awaiting_user"),
    [sortedInstances],
  );
  const completedInstances = useMemo(
    () => sortedInstances.filter((item) => item.status === "completed"),
    [sortedInstances],
  );

  useEffect(() => {
    setSectionOpen((prev) => ({
      pending: pendingInstances.length === 0 ? false : prev.pending,
      running: runningInstances.length === 0 ? false : prev.running,
      completed: completedInstances.length === 0 ? false : prev.completed,
    }));
  }, [pendingInstances.length, runningInstances.length, completedInstances.length]);

  useEffect(() => {
    setSectionOpen((prev) => ({
      pending: pendingInstances.length > 0 && !prev.pending ? true : prev.pending,
      running: runningInstances.length > 0 && !prev.running ? true : prev.running,
      completed: completedInstances.length > 0 && !prev.completed ? true : prev.completed,
    }));
  }, [pendingInstances.length, runningInstances.length, completedInstances.length]);

  useEffect(() => {
    if (expandedInstanceId && !task.instances.some((item) => item.id === expandedInstanceId)) {
      setExpandedInstanceId(null);
    }
  }, [expandedInstanceId, task.instances]);

  useEffect(() => {
    if (runningInstances.length === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        await Promise.all(
          runningInstances.map(async (instance) => {
            const state = await fetchTaskRunProgress({
              requestId: instance.runner?.requestId,
              taskInstanceId: instance.id,
              signal: controller.signal,
            });
            if (cancelled || controller.signal.aborted) return;
            syncTaskInstanceRun({
              taskId: task.id,
              instanceId: instance.id,
              progress: state.progress,
              logs: state.logs,
            });
          }),
        );
        if (!cancelled && !controller.signal.aborted) {
          setRefreshTick((value) => value + 1);
        }
      } catch (error) {
        if (isAbortError(error)) return;
        console.error("[TaskDetailBody] 轮询任务进度失败", error);
      }
    }, 1000);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [refreshTick, runningInstances, syncTaskInstanceRun, task.id]);

  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-[#1F2328]">{cleanTitle}</h2>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
          <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium", taskStatusClassName(taskState))}>
            {statusLabel}
          </span>
          <span>{EXECUTION_LABEL[task.resultViewKind ?? task.executionKind]}</span>
          <span className="text-[#D0D7DE]">/</span>
          <span>{task.triggerRule}</span>
        </div>
        <div className="relative ml-auto flex items-center justify-end gap-1">
          {executionAction ? (
            <button
              type="button"
              onClick={() => {
                void runTaskExecutionAction(task.id, executionAction.action).catch((error) => {
                  window.alert(error instanceof Error ? error.message : "任务执行失败");
                });
              }}
              className="rounded-md border border-[#D0D7DE] bg-white px-2 py-1 text-[12px] text-[#1F2328] hover:border-[#111]"
            >
              {executionAction.label}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setMetaOpen((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-md border border-[#D0D7DE] bg-white px-2 py-1 text-[12px] text-[#1F2328] hover:border-[#111]"
          >
            详细信息
            {metaOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-[#6B7280]" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-[#6B7280]" />
            )}
          </button>
          <button
            type="button"
            aria-label="更多任务操作"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#D0D7DE] bg-white text-[#6B7280] hover:border-[#111] hover:text-[#1F2328]"
          >
            <Ellipsis className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-8 z-20 w-28 overflow-hidden rounded-lg border border-[#E5E7EB] bg-white py-1 text-[12px] text-[#1F2328]">
              <button
                type="button"
                onClick={() => {
                  setEditOpen(true);
                  setMenuOpen(false);
                }}
                className="block w-full px-3 py-2 text-left hover:bg-[#F8F9FB]"
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteTask(task.id);
                  setMenuOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-[#D1242F] hover:bg-[#F8F9FB]"
              >
                删除
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <section>
        {metaOpen ? (
          <div className="mt-5 border-t border-[#E5E7EB] pt-4">
            <div className="grid grid-cols-[88px_1fr] gap-x-4 gap-y-3 text-[13px]">
              <MetaLabel>任务类型</MetaLabel>
              <MetaValue>{TASK_TYPE_LABEL[task.taskType]}</MetaValue>

              <MetaLabel>执行周期</MetaLabel>
              <MetaValue>
                {task.taskType === "daily_repeat"
                  ? "每日"
                  : task.taskType === "one_shot"
                    ? "一次性"
                    : "长期"}
              </MetaValue>

              <MetaLabel>触发时间</MetaLabel>
              <MetaValue>{task.triggerRule}</MetaValue>

              <MetaLabel>交付物</MetaLabel>
              <MetaValue>{task.expectedOutcome || "—"}</MetaValue>

              <MetaLabel>执行方式</MetaLabel>
              <MetaValue>{EXECUTION_LABEL[task.resultViewKind ?? task.executionKind]}</MetaValue>

              {task.deadline ? (
                <>
                  <MetaLabel>截止时间</MetaLabel>
                  <MetaValue>{new Date(task.deadline).toISOString().slice(0, 10)}</MetaValue>
                </>
              ) : null}
            </div>

            {task.description ? (
              <div className="mt-4 border-t border-[#E5E7EB] pt-4">
                <div className="mb-2 text-[12px] text-[#8C9198]">任务内容</div>
                <p className="whitespace-pre-wrap text-[13px] leading-6 text-[#1F2328]">{task.description}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="mt-8 space-y-8">
        <InstanceSection
          title={SECTION_COPY.pending.title}
          description={SECTION_COPY.pending.description}
          instances={pendingInstances}
          task={task}
          expandedInstanceId={expandedInstanceId}
          onToggle={setExpandedInstanceId}
          open={sectionOpen.pending}
          onToggleOpen={() => {
            if (pendingInstances.length === 0) return;
            setSectionOpen((prev) => ({ ...prev, pending: !prev.pending }));
          }}
        />
        <InstanceSection
          title={SECTION_COPY.running.title}
          description={SECTION_COPY.running.description}
          instances={runningInstances}
          task={task}
          expandedInstanceId={expandedInstanceId}
          onToggle={setExpandedInstanceId}
          open={sectionOpen.running}
          onToggleOpen={() => {
            if (runningInstances.length === 0) return;
            setSectionOpen((prev) => ({ ...prev, running: !prev.running }));
          }}
        />
        <InstanceSection
          title={SECTION_COPY.completed.title}
          description={SECTION_COPY.completed.description}
          instances={completedInstances}
          task={task}
          expandedInstanceId={expandedInstanceId}
          onToggle={setExpandedInstanceId}
          open={sectionOpen.completed}
          onToggleOpen={() => {
            if (completedInstances.length === 0) return;
            setSectionOpen((prev) => ({ ...prev, completed: !prev.completed }));
          }}
        />
      </div>

      <TaskEditDrawer task={task} open={editOpen} onClose={() => setEditOpen(false)} />
    </div>
  );
}

function InstanceSection({
  title,
  description,
  instances,
  task,
  expandedInstanceId,
  onToggle,
  open,
  onToggleOpen,
}: {
  title: string;
  description: string;
  instances: TaskInstance[];
  task: Task;
  expandedInstanceId: string | null;
  onToggle: (instanceId: string | null) => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const hasInstances = instances.length > 0;

  return (
    <section>
      <button
        type="button"
        onClick={onToggleOpen}
        disabled={!hasInstances}
        className={cn(
          "mb-3 flex w-full items-start justify-between gap-3 text-left",
          hasInstances ? "cursor-pointer" : "cursor-default",
        )}
      >
        <div>
          <h3 className="text-[14px] font-medium text-[#1F2328]">
            {title}
            <span className="ml-2 text-[12px] text-[#8C9198]">({instances.length})</span>
          </h3>
          <div className="mt-1 text-[12px] text-[#8C9198]">{description}</div>
        </div>
        <span className="mt-0.5 text-[#8C9198]">
          {open && hasInstances ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>
      {open && hasInstances ? (
        <div className="space-y-3">
          {instances.map((instance) => (
            <InstanceCard
              key={instance.id}
              task={task}
              instance={instance}
              expanded={expandedInstanceId === instance.id}
              onToggle={() => onToggle(expandedInstanceId === instance.id ? null : instance.id)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function pendingLength(task: Task) {
  return task.instances.filter((item) => item.status === "pending" || item.status === "paused" || item.status === "error").length;
}

function runningLength(task: Task) {
  return task.instances.filter((item) => item.status === "in_progress" || item.status === "awaiting_user").length;
}

function completedLength(task: Task) {
  return task.instances.filter((item) => item.status === "completed").length;
}

function InstanceCard({
  task,
  instance,
  expanded,
  onToggle,
}: {
  task: Task;
  instance: TaskInstance;
  expanded: boolean;
  onToggle: () => void;
}) {
  const canExpand = instance.status === "in_progress" || instance.status === "awaiting_user" || instance.status === "completed";
  const resultLine = instance.status === "completed" ? getInstanceResultLine(task, instance) : "";

  return (
    <div className="overflow-hidden rounded-[16px] border border-[#E5E7EB] bg-white">
      <button
        type="button"
        onClick={canExpand ? onToggle : undefined}
        disabled={!canExpand}
        className={cn("w-full px-4 py-4 text-left", canExpand && "transition-colors hover:bg-[#FCFCFD]")}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
              <span>{instance.dateLabel}</span>
              <span className={cn("rounded-md px-2 py-0.5 text-[11px]", instanceStatusClassName(instance.status))}>
                {instanceStatusLabel(instance)}
              </span>
              {instance.execution?.lastUpdatedAt ? (
                <span>最近更新 {new Date(instance.execution.lastUpdatedAt).toLocaleString("zh-CN")}</span>
              ) : null}
            </div>
            <p className="mt-2 text-[14px] leading-6 text-[#1F2328]">{instance.intro}</p>
            {resultLine ? (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#E5E7EB] bg-[#F8F9FB] px-3 py-3">
                <div className="shrink-0 text-[11px] text-[#8C9198]">执行结果</div>
                <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-[#1F2328]">
                  {resultLine}
                </div>
              </div>
            ) : null}
          </div>
          {canExpand ? (
            <div className="flex shrink-0 items-center gap-1 text-[12px] text-[#6B7280]">
              <span>{expanded ? "收起详情" : "展开详情"}</span>
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </div>
          ) : null}
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-[#E5E7EB] bg-[#FAFAFB] px-4 py-4">
          <div className="space-y-4">
            <div className="min-w-0">
              <div className="mb-2 text-[12px] font-medium text-[#6B7280]">执行过程</div>
              <ExecutionMessageStream steps={instance.timeline ?? []} />
            </div>
            {instance.status === "completed" || instance.status === "awaiting_user" ? (
              <div className="min-w-0">
                <div className="mb-2 text-[12px] font-medium text-[#6B7280]">执行结果</div>
                <InstanceResultPanel task={task} instance={instance} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InstanceResultPanel({ task, instance }: { task: Task; instance: TaskInstance }) {
  const resultLine = getInstanceResultLine(task, instance);
  const genericSummary =
    instance.result?.summary ??
    (instance.payload.kind === "generic_result" ? instance.payload.summary : undefined) ??
    instance.intro;
  const genericMessage =
    instance.result?.finalMessage ??
    (instance.payload.kind === "generic_result" ? instance.payload.details : undefined);
  const genericArtifacts =
    instance.result?.artifacts ??
    (instance.payload.kind === "generic_result" ? instance.payload.artifacts : undefined);
  const structuredOutput = instance.result?.structuredOutput;
  const resultSummary = genericSummary && genericSummary !== resultLine ? genericSummary : "";
  const extraPayloadLines = getPayloadSummaryLines(instance).slice(resultLine ? 1 : 0);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[#E5E7EB] bg-white p-4">
        <div className="text-[12px] text-[#8C9198]">结果内容</div>
        <div className="mt-2 text-[14px] leading-7 text-[#1F2328]">
          {resultLine || "该任务暂未产出最终结果。"}
        </div>
        {resultSummary ? (
          <div className="mt-4 border-t border-[#EEF1F4] pt-4">
            <div className="text-[12px] text-[#8C9198]">结果摘要</div>
            <div className="mt-2 whitespace-pre-wrap text-[14px] leading-7 text-[#1F2328]">
              {resultSummary}
            </div>
          </div>
        ) : null}
      </div>
      {(genericMessage && genericMessage !== resultLine) || genericArtifacts?.length ? (
        <GenericAgentResultView
          summary={genericSummary}
          finalMessage={genericMessage}
          artifacts={genericArtifacts}
          structuredOutput={structuredOutput}
          notification={instance.notification}
          hideSummaryCard
        />
      ) : null}
      {structuredOutput ? (
        <div className="rounded-xl border border-[#E5E7EB] bg-white p-4">
          <div className="text-[12px] text-[#8C9198]">结构化输出</div>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-[#F8F9FB] p-3 text-[12px] leading-6 text-[#374151]">
            {JSON.stringify(structuredOutput, null, 2)}
          </pre>
        </div>
      ) : null}
      {task.resultViewKind !== "generic_result" || instance.payload.kind !== "generic_result" ? (
        <PayloadSummaryCard lines={extraPayloadLines} />
      ) : null}
      {instance.awaitingUser ? (
        <div className="rounded-xl border border-[#F5D58B] bg-[#FFF9E8] p-4 text-[13px] leading-6 text-[#6E5A16]">
          <div className="font-medium text-[#8A6D3B]">{awaitingUserTitle(instance)}</div>
          <div className="mt-2">{instance.awaitingUser.reason}</div>
          {instance.awaitingUser.suggestedActions?.length ? (
            <div className="mt-2">建议操作：{instance.awaitingUser.suggestedActions.join(" / ")}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ExecutionMessageStream({ steps }: { steps: TaskExecutionStep[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const visibleSteps = useMemo(() => steps.filter(isVisibleExecutionStep), [steps]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [visibleSteps]);

  if (visibleSteps.length === 0) {
    return (
      <div className="rounded-2xl bg-[#F7F7F8] px-4 py-6 text-sm text-[#8C9198]">
        暂无执行消息。
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="max-h-[420px] space-y-2 overflow-y-auto rounded-2xl bg-[#F7F7F8] p-3"
    >
      {visibleSteps.map((step) => (
        <ExecutionFeedItem key={step.id} step={step} />
      ))}
    </div>
  );
}

function ExecutionFeedItem({ step }: { step: TaskExecutionStep }) {
  const timestamp = new Date(step.startedAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const message = step.detail?.trim() || step.title;

  if (step.type === "tool" || step.toolName) {
    return (
      <div className="rounded-full bg-[#EAEAEA] px-3 py-2 text-[12px] leading-5 text-[#5B6168]">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white text-[10px] text-[#8C9198]">
            {toolGlyph(step)}
          </span>
          <span className="truncate">{message}</span>
          <span className="shrink-0 text-[11px] text-[#9AA0A6]">{timestamp}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-1 py-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#9AA0A6]">
        <span className={cn("rounded-md px-2 py-0.5", streamStatusClassName(step.status))}>
          {streamStatusLabel(step.status)}
        </span>
        <span>{timestamp}</span>
      </div>
      <div className="mt-1 whitespace-pre-wrap text-[14px] leading-7 text-[#3B4046]">{message}</div>
    </div>
  );
}

function PayloadSummaryCard({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;

  return (
    <div className="rounded-xl border border-[#E5E7EB] bg-white p-4">
      <div className="text-[12px] text-[#8C9198]">更多结果</div>
      <div className="mt-2 space-y-2">
        {lines.map((line, index) => (
          <div key={`payload-line-${index}`} className="rounded-lg bg-[#F8F9FB] px-3 py-2 text-[13px] leading-6 text-[#1F2328]">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function getPayloadSummaryLines(instance: TaskInstance) {
  switch (instance.payload.kind) {
    case "flashcard":
      return [`共生成 ${instance.payload.cards.length} 张记忆卡片，可继续进入训练。`];
    case "listening_qa":
      return [`共准备 ${instance.payload.questions.length} 道听力问答，音频地址：${instance.payload.audioUrl}`];
    case "reading_digest":
      return instance.payload.articles.slice(0, 3).map((article) => `${article.title}：${article.summary}`);
    case "confirm_action":
      return [instance.payload.summary, `可选操作：${instance.payload.options.join(" / ")}`];
    case "draft_review":
      return instance.payload.drafts.slice(0, 3).map((draft) => `${draft.subject} -> ${draft.recipient}`);
    case "freeform_chat":
      return [instance.payload.seed];
    case "generic_result":
    default:
      return [];
  }
}

function getInstanceResultLine(task: Task, instance: TaskInstance) {
  const directResult =
    instance.notification?.resultSummary.headline ??
    instance.result?.summary ??
    instance.result?.finalMessage ??
    (instance.payload.kind === "generic_result" ? instance.payload.summary ?? instance.payload.details : undefined);
  if (directResult) return directResult;

  const payloadLines = getPayloadSummaryLines(instance);
  if (payloadLines.length > 0) return payloadLines[0];
  if (instance.status === "completed") return `${task.title.replace(/^任务\d+：/, "")} 已执行完成。`;
  return "";
}

function streamStatusClassName(status: TaskExecutionStep["status"]) {
  if (status === "completed") return "bg-[#E8F5E9] text-[#25663A]";
  if (status === "running") return "bg-[#DDE1E7] text-[#1F2328]";
  if (status === "awaiting_user") return "bg-[#FFF3CD] text-[#8A6D3B]";
  if (status === "failed") return "bg-[#FDECEC] text-[#B42318]";
  return "bg-[#F5F6F8] text-[#8C9198]";
}

function streamStatusLabel(status: TaskExecutionStep["status"]) {
  if (status === "completed") return "已完成";
  if (status === "running") return "进行中";
  if (status === "awaiting_user") return "待确认";
  if (status === "failed") return "失败";
  return "排队中";
}

function toolGlyph(step: TaskExecutionStep) {
  if (step.status === "failed") return "!";
  const toolName = step.toolName?.toLowerCase() || "";
  if (toolName.includes("web")) return "W";
  if (toolName.includes("search") || toolName.includes("grep") || toolName.includes("glob")) return "Q";
  if (toolName.includes("read")) return "R";
  if (toolName.includes("write") || toolName.includes("edit") || toolName.includes("patch")) return "E";
  if (toolName.includes("command") || toolName.includes("bash")) return "C";
  return "·";
}

function MetaLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] leading-6 text-[#8C9198]">{children}</div>;
}

function MetaValue({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] leading-6 text-[#1F2328]">{children}</div>;
}

function getTaskDisplayState(task: Task) {
  const latestStatus = task.instances[0]?.status;
  if (latestStatus === "completed" || task.progress >= 100) return "completed" as const;
  if (latestStatus === "paused") return "paused" as const;
  if (latestStatus === "awaiting_user" || latestStatus === "in_progress") return "in_progress" as const;
  if (latestStatus === "pending") return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
  return task.progress > 0 ? ("in_progress" as const) : ("pending" as const);
}

function getExecutionAction(task: Task, taskState: ReturnType<typeof getTaskDisplayState>) {
  if (taskState === "completed") return null;
  const latest = [...task.instances]
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .find((instance) => instance.status !== "completed");
  if (latest?.status === "error") return { label: "重试", action: "start" as const };
  if (taskState === "in_progress") return { label: "停止", action: "pause" as const };
  if (taskState === "paused") return { label: "继续执行", action: "resume" as const };
  if (!latest) return { label: "执行", action: "start" as const };
  if (latest.status === "pending") return { label: "执行", action: "start" as const };
  return null;
}

function taskStatusClassName(state: ReturnType<typeof getTaskDisplayState>) {
  if (state === "completed") return "bg-[#E5E7EB] text-[#6B7280]";
  if (state === "in_progress") return "bg-[#DDE1E7] text-[#1F2328]";
  if (state === "paused") return "bg-[#E5E7EB] text-[#6B7280]";
  return "bg-[#F5F6F8] text-[#8C9198]";
}

function instanceStatusClassName(status: Task["instances"][number]["status"]) {
  if (status === "completed") return "bg-[#E8F5E9] text-[#25663A]";
  if (status === "in_progress") return "bg-[#DDE1E7] text-[#1F2328]";
  if (status === "awaiting_user") return "bg-[#FFF3CD] text-[#8A6D3B]";
  if (status === "error") return "bg-[#FDECEC] text-[#B42318]";
  if (status === "paused") return "bg-[#E5E7EB] text-[#6B7280]";
  return "bg-[#F5F6F8] text-[#8C9198]";
}

function awaitingUserTitle(instance: TaskInstance) {
  const type = instance.awaitingUser?.interactionRequirement?.type ?? instance.result?.interactionRequirement?.type;
  if (type === "answer") return "等待你作答";
  if (type === "provide_context") return "等待你补充信息";
  if (type === "perform_offline_action") return "等待你完成线下动作";
  if (type === "agent_revision_required") return "等待 Agent 补齐";
  if (type === "deliverable_gap") return "未通过验收";
  return "等待你确认";
}

function instanceStatusLabel(instance: Task["instances"][number]) {
  const status = instance.status;
  if (status === "completed") return "已完成";
  if (status === "in_progress") return "进行中";
  if (status === "error") return "执行失败";
  if (status === "paused") return "已暂停";
  if (status === "awaiting_user") {
    const type = instance.awaitingUser?.interactionRequirement?.type ?? instance.result?.interactionRequirement?.type;
    if (type === "answer") return "待作答";
    if (type === "provide_context") return "待补充";
    if (type === "perform_offline_action") return "待线下完成";
    if (type === "agent_revision_required") return "等待 Agent 补齐";
    if (type === "deliverable_gap") return "未通过验收";
    return "待确认";
  }
  return "待处理";
}
