"use client";

import { Calendar, Inbox, Sparkles } from "lucide-react";
import Link from "next/link";

import { topicTaskDetailPath } from "@/lib/routes";

import { BASE_DATE, formatDateInput } from "@/lib/date";
import type { Goal, TaskInstance } from "@/types/kiki";

const STATUS_TEXT: Record<TaskInstance["status"], string> = {
  pending: "待处理",
  in_progress: "进行中",
  awaiting_user: "等待你确认",
  completed: "已结束",
  paused: "已暂停",
  terminated: "已终止",
  error: "执行失败",
};

export function DigestTopicView({ goal }: { goal: Goal }) {
  const mainTask = goal.subGoals[0]?.tasks[0];
  const instances = mainTask?.instances ?? [];
  const sortedInstances = [...instances].sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
  );
  const latest = sortedInstances[0];

  const daysLeft = Math.max(
    0,
    Math.ceil((new Date(goal.deadline).getTime() - BASE_DATE.getTime()) / (1000 * 60 * 60 * 24)),
  );

  return (
    <div className="max-w-[920px] pb-12">
      <div className="mb-6 text-xs text-ink-faint">
        进行中 <span className="mx-1">/</span>{" "}
        <span className="font-medium text-ink">{goal.title}</span>
      </div>

      <section className="mb-6 rounded-[20px] border border-line bg-white p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-ink">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-ink">{goal.title}</h1>
            {goal.summary ? (
              <p className="mt-2 text-[13px] leading-6 text-ink-soft">{goal.summary}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-soft">
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                截止 {formatDateInput(goal.deadline)}
              </span>
              <span className="rounded-md bg-surface-subtle px-2.5 py-1 text-xs font-medium text-ink">
                剩余 {daysLeft} 天
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Inbox className="h-3.5 w-3.5" />
                {instances.length} 条记录
              </span>
            </div>
          </div>
        </div>
      </section>

      {mainTask ? (
        <>
          <div className="mb-3 text-[13px] font-medium text-ink">当前任务</div>
          <section className="mb-8 rounded-[16px] border border-line bg-white px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink">
                  {mainTask.title.replace(/^任务\d+：/, "")}
                </div>
                <p className="mt-1 text-[12px] leading-5 text-ink-soft">{mainTask.description}</p>
                <div className="mt-2 inline-flex items-start gap-1.5 rounded-md bg-white px-2 py-1 text-[12px] leading-5 text-ink">
                  <span className="shrink-0 text-ink-faint">交付物</span>
                  <span>{mainTask.expectedOutcome}</span>
                </div>
              </div>
              <div className="shrink-0 text-right text-[11px] text-ink-faint">
                <div>{mainTask.triggerRule}</div>
                <div className="mt-1 text-[13px] font-semibold text-ink">{mainTask.progress}%</div>
              </div>
            </div>
          </section>

          {latest ? (
            <>
              <div className="mb-3 text-[13px] font-medium text-ink">最新一条</div>
              <Link
                href={`${topicTaskDetailPath(goal.id, mainTask.id)}?view=exec&instanceId=${latest.id}`}
                className="mb-8 block rounded-[16px] border border-line bg-white px-5 py-4 hover:border-ink"
              >
                <div className="flex items-center justify-between gap-3 text-[12px] text-ink-faint">
                  <span>{latest.dateLabel}</span>
                  <span className="rounded-md bg-white px-2 py-0.5 text-[11px] text-ink">
                    {STATUS_TEXT[latest.status]}
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-6 text-ink">{latest.intro}</p>
                <div className="mt-3 text-[12px] text-ink underline-offset-2 hover:underline">
                  进入处理 →
                </div>
              </Link>
            </>
          ) : null}

          {sortedInstances.length > 1 ? (
            <>
              <div className="mb-3 text-[13px] font-medium text-ink">历史记录</div>
              <div className="space-y-1.5">
                {sortedInstances.slice(1).map((item) => (
                  <Link
                    key={item.id}
                    href={`${topicTaskDetailPath(goal.id, mainTask.id)}?view=exec&instanceId=${item.id}`}
                    className="flex items-start justify-between gap-3 rounded-lg border border-line bg-white px-4 py-3 hover:border-ink"
                  >
                    <div className="min-w-0">
                      <div className="text-[12px] text-ink-faint">{item.dateLabel}</div>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-ink">{item.intro}</p>
                    </div>
                    <span className="shrink-0 rounded-md bg-white px-2 py-0.5 text-[11px] text-ink">
                      {STATUS_TEXT[item.status]}
                    </span>
                  </Link>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <div className="rounded-xl border border-line bg-white p-6 text-sm text-ink-soft">
          该主题暂未配置任务。
        </div>
      )}
    </div>
  );
}
