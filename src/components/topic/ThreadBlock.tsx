"use client";

import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useState } from "react";

import {
  ReviewCyclePopover,
  reviewIntervalLabel,
  threadGovernanceStatusLabel,
  threadGovernanceTone,
} from "@/components/topic/ReviewCyclePopover";
import { TaskCreateDrawer } from "@/components/topic/TaskCreateDrawer";
import { TaskRow } from "@/components/topic/TaskRow";
import type { Goal, Task } from "@/types/kiki";

export function ThreadBlock({
  index,
  goal,
  subGoal,
  unreadByTask,
  highlighted = false,
  isPendingCreate = false,
  pendingTaskCreateIds = new Set<string>(),
  pendingTaskUpdateIds = new Set<string>(),
  onOpenTask,
}: {
  index: number;
  goal: Goal;
  subGoal: Goal["subGoals"][number];
  unreadByTask: Record<string, number>;
  highlighted?: boolean;
  isPendingCreate?: boolean;
  pendingTaskCreateIds?: Set<string>;
  pendingTaskUpdateIds?: Set<string>;
  onOpenTask: (task: Task) => void;
}) {
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const displayTasks = subGoal.tasks;

  const completedCount = displayTasks.filter((task) => {
    const latest = task.instances[0];
    const latestStatus = latest?.status;
    if (latestStatus === "awaiting_user" || latest?.awaitingUser) return false;
    return latestStatus === "completed" || task.progress >= 100;
  }).length;
  const progress = displayTasks.length === 0 ? 0 : Math.round((completedCount / displayTasks.length) * 100);
  const dependencyTitles =
    subGoal.dependencies?.map((dependencyId) => {
      const dependency = goal.subGoals.find((item) => item.id === dependencyId);
      return dependency ? stripPrefix(dependency.title) : dependencyId;
    }) ?? [];
  const hasDetails =
    Boolean(subGoal.description?.trim()) ||
    Boolean(subGoal.why?.trim()) ||
    Boolean(subGoal.reviewInterval?.trim()) ||
    Boolean(subGoal.priority) ||
    typeof subGoal.estimatedDurationMinutes === "number" ||
    dependencyTitles.length > 0 ||
    (subGoal.successCriteria?.length ?? 0) > 0;

  return (
    <section
        className={`rounded-[18px] border bg-white px-4 py-4 md:px-6 md:py-5 ${
        highlighted ? "border-ink" : "border-line"
      }`}
    >
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-4">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-ink">
              {index}
            </div>
            <div className="min-w-0 flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 text-[15px] font-semibold text-ink md:truncate">
                {stripPrefix(subGoal.title)}
              </h2>
              {isPendingCreate ? (
                <span className="inline-flex shrink-0 items-center rounded-md bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-faint">
                  保存中
                </span>
              ) : null}
              {hasDetails ? (
                <button
                  type="button"
                  onClick={() => setDetailsOpen((open) => !open)}
                  aria-expanded={detailsOpen}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-1 text-[11px] font-medium text-ink-strong hover:border-ink hover:text-ink"
                >
                  {detailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  详情
                </button>
              ) : null}
            </div>
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-ink" style={{ width: `${progress}%` }} />
          </div>
          {hasDetails && detailsOpen ? (
            <div className="mt-4 rounded-2xl border border-line bg-surface-subtle px-4 py-3">
              <div className="flex flex-wrap gap-2">
                {subGoal.reviewInterval?.trim() ? (
                  <ReviewCyclePopover
                    kind="thread"
                    entityId={subGoal.id}
                    label={reviewIntervalLabel(subGoal.reviewInterval)}
                    phaseLabel={threadGovernanceStatusLabel(subGoal)}
                    phaseTone={threadGovernanceTone(subGoal)}
                    lastTickAt={subGoal.lastTickAt}
                    nextTickAt={subGoal.nextTickAt}
                    silentCount={subGoal.silentCount}
                    failureCount={subGoal.failureCount}
                  />
                ) : null}
                {subGoal.priority ? <DetailBadge label={`优先级：${priorityLabel(subGoal.priority)}`} /> : null}
                {typeof subGoal.estimatedDurationMinutes === "number" ? (
                  <DetailBadge label={`预计耗时：${formatDuration(subGoal.estimatedDurationMinutes)}`} />
                ) : null}
                {dependencyTitles.length > 0 ? (
                  <DetailBadge label={`依赖：${dependencyTitles.length} 个线程`} />
                ) : null}
              </div>

              <ul className="mt-3 list-disc space-y-3 pl-5 text-left text-[13px] leading-6 text-ink">
                {subGoal.description?.trim() ? (
                  <DetailGroup label="线程说明" items={[subGoal.description]} />
                ) : null}

                {subGoal.why?.trim() ? (
                  <DetailGroup label="为什么做" items={[subGoal.why]} />
                ) : null}

                {(subGoal.successCriteria?.length ?? 0) > 0 ? (
                  <DetailGroup label="完成标准" items={subGoal.successCriteria ?? []} ordered />
                ) : null}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="shrink-0 text-[12px] font-medium tabular-nums text-ink-faint md:text-right">
          {completedCount} / {displayTasks.length}
        </div>
      </div>

      <div className="space-y-1.5">
        {displayTasks.map((task) => (
          <TaskRow
            key={task.id}
            goalId={goal.id}
            task={task}
            isPendingCreate={pendingTaskCreateIds.has(task.id)}
            isPendingUpdate={pendingTaskUpdateIds.has(task.id)}
            unreadCount={unreadByTask[task.id] ?? 0}
            onOpen={() => onOpenTask(task)}
          />
        ))}
        {!isPendingCreate ? (
          <button
            type="button"
            onClick={() => setTaskDrawerOpen(true)}
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line bg-transparent px-3 py-2.5 text-[13px] text-ink-soft hover:border-ink hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" />
            添加任务
          </button>
        ) : null}
      </div>

      {!isPendingCreate ? (
        <TaskCreateDrawer
          open={taskDrawerOpen}
          goalId={goal.id}
          subGoalId={subGoal.id}
          onClose={() => setTaskDrawerOpen(false)}
        />
      ) : null}
    </section>
  );
}

function stripPrefix(value: string) {
  return value.replace(/^线程\d+：/, "");
}

function priorityLabel(priority: Goal["subGoals"][number]["priority"]) {
  switch (priority) {
    case "critical":
      return "最高";
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
      return "低";
    default:
      return "未设置";
  }
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours} 小时`;
  return `${hours} 小时 ${remainingMinutes} 分钟`;
}

function DetailGroup({ label, items, ordered = false }: { label: string; items: string[]; ordered?: boolean }) {
  const displayItems = items.map((item) => item.trim()).filter(Boolean);
  if (displayItems.length === 0) return null;

  return (
    <li className="pl-0.5">
        <div className="grid grid-cols-1 items-start gap-1 md:grid-cols-[5.5rem_minmax(0,1fr)]">
        <span className="font-medium text-ink-soft">{label}</span>
        {ordered || displayItems.length > 1 ? (
          <ol className="list-decimal space-y-1 pl-5 text-ink">
            {displayItems.map((item, index) => (
              <li key={`${label}-${index}`} className="whitespace-pre-wrap break-words pl-0.5">
                {item}
              </li>
            ))}
          </ol>
        ) : (
          <span className="whitespace-pre-wrap break-words text-ink">{displayItems[0]}</span>
        )}
      </div>
    </li>
  );
}

function DetailBadge({ label, tone = "default" }: { label: string; tone?: "default" | "light" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] ${
        tone === "light" ? "bg-white text-ink-strong" : "bg-surface-subtle text-ink"
      }`}
    >
      {label}
    </span>
  );
}
