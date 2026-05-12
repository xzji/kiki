"use client";

import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useState } from "react";

import { TaskCreateDrawer } from "@/components/goal/TaskCreateDrawer";
import { TaskRow } from "@/components/goal/TaskRow";
import type { Goal, Task } from "@/types/kiki";

export function SubGoalBlock({
  index,
  goal,
  subGoal,
  unreadByTask,
  highlighted = false,
  onOpenTask,
}: {
  index: number;
  goal: Goal;
  subGoal: Goal["subGoals"][number];
  unreadByTask: Record<string, number>;
  highlighted?: boolean;
  onOpenTask: (task: Task) => void;
}) {
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const completedCount = subGoal.tasks.filter((task) => {
    const latest = task.instances[0];
    const latestStatus = latest?.status;
    if (latestStatus === "awaiting_user" || latest?.awaitingUser) return false;
    return latestStatus === "completed" || task.progress >= 100;
  }).length;
  const progress = subGoal.tasks.length === 0 ? 0 : Math.round((completedCount / subGoal.tasks.length) * 100);
  const dependencyTitles =
    subGoal.dependencies?.map((dependencyId) => {
      const dependency = goal.subGoals.find((item) => item.id === dependencyId);
      return dependency ? stripPrefix(dependency.title) : dependencyId;
    }) ?? [];
  const hasDetails =
    Boolean(subGoal.description?.trim()) ||
    Boolean(subGoal.why?.trim()) ||
    Boolean(subGoal.priority) ||
    typeof subGoal.weight === "number" ||
    typeof subGoal.estimatedDurationMinutes === "number" ||
    dependencyTitles.length > 0 ||
    (subGoal.successCriteria?.length ?? 0) > 0;

  return (
    <section
      className={`rounded-[18px] border bg-white px-6 py-5 ${
        highlighted ? "border-[#1F2328]" : "border-[#E5E7EB]"
      }`}
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#F5F6F8] text-[11px] font-semibold text-[#1F2328]">
              {index}
            </div>
            <div className="min-w-0 flex items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold text-[#1F2328]">
                {stripPrefix(subGoal.title)}
              </h2>
              {hasDetails ? (
                <button
                  type="button"
                  onClick={() => setDetailsOpen((open) => !open)}
                  aria-expanded={detailsOpen}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#E5E7EB] px-2 py-1 text-[11px] font-medium text-[#4B5563] hover:border-[#1F2328] hover:text-[#1F2328]"
                >
                  {detailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  详情
                </button>
              ) : null}
            </div>
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-[#E5E7EB]">
            <div className="h-full rounded-full bg-[#1F2328]" style={{ width: `${progress}%` }} />
          </div>
          {hasDetails && detailsOpen ? (
            <div className="mt-4 rounded-2xl border border-[#E5E7EB] bg-[#F8FAFC] px-4 py-3">
              <div className="flex flex-wrap gap-2">
                {subGoal.priority ? <DetailBadge label={`优先级：${priorityLabel(subGoal.priority)}`} /> : null}
                {typeof subGoal.weight === "number" ? (
                  <DetailBadge label={`权重：${Math.round(subGoal.weight * 100)}%`} />
                ) : null}
                {typeof subGoal.estimatedDurationMinutes === "number" ? (
                  <DetailBadge label={`预计耗时：${formatDuration(subGoal.estimatedDurationMinutes)}`} />
                ) : null}
                {dependencyTitles.length > 0 ? (
                  <DetailBadge label={`依赖：${dependencyTitles.length} 个子目标`} />
                ) : null}
              </div>

              {subGoal.description?.trim() ? (
                <div className="mt-3">
                  <div className="text-[12px] font-medium text-[#6B7280]">子目标说明</div>
                  <p className="mt-1 text-[13px] leading-6 text-[#1F2328]">{subGoal.description}</p>
                </div>
              ) : null}

              {subGoal.why?.trim() ? (
                <div className="mt-3">
                  <div className="text-[12px] font-medium text-[#6B7280]">为什么要做</div>
                  <p className="mt-1 text-[13px] leading-6 text-[#1F2328]">{subGoal.why}</p>
                </div>
              ) : null}

              {dependencyTitles.length > 0 ? (
                <div className="mt-3">
                  <div className="text-[12px] font-medium text-[#6B7280]">依赖子目标</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {dependencyTitles.map((dependencyTitle) => (
                      <DetailBadge key={dependencyTitle} label={dependencyTitle} />
                    ))}
                  </div>
                </div>
              ) : null}

              {(subGoal.successCriteria?.length ?? 0) > 0 ? (
                <div className="mt-3">
                  <div className="text-[12px] font-medium text-[#6B7280]">任务完成标准</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {subGoal.successCriteria?.map((criterion) => (
                      <DetailBadge key={criterion} label={criterion} tone="light" />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="shrink-0 text-[12px] font-medium tabular-nums text-[#8C9198]">
          {completedCount} / {subGoal.tasks.length}
        </div>
      </div>

      <div className="space-y-1.5">
        {subGoal.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            unreadCount={unreadByTask[task.id] ?? 0}
            onOpen={() => onOpenTask(task)}
          />
        ))}
        <button
          type="button"
          onClick={() => setTaskDrawerOpen(true)}
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[#D4D7DD] bg-transparent px-3 py-2.5 text-[13px] text-[#6B7280] hover:border-[#1F2328] hover:text-[#1F2328]"
        >
          <Plus className="h-3.5 w-3.5" />
          添加任务
        </button>
      </div>

      <TaskCreateDrawer
        open={taskDrawerOpen}
        goalId={goal.id}
        subGoalId={subGoal.id}
        onClose={() => setTaskDrawerOpen(false)}
      />
    </section>
  );
}

function stripPrefix(value: string) {
  return value.replace(/^子目标\d+：/, "");
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

function DetailBadge({ label, tone = "default" }: { label: string; tone?: "default" | "light" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] ${
        tone === "light" ? "bg-white text-[#4B5563]" : "bg-[#EEF2F6] text-[#1F2328]"
      }`}
    >
      {label}
    </span>
  );
}
