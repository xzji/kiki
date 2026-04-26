"use client";

import Link from "next/link";

import { DoraAvatar } from "@/components/layout/DoraAvatar";
import { DetailPanel } from "@/components/task/DetailPanel";
import type { Goal, Task } from "@/types/dora";

export function InstanceList({ goal, task, showDetail = false, activeInstanceId }: { goal: Goal; task: Task; showDetail?: boolean; activeInstanceId?: string }) {
  return (
    <div className="rounded-[20px] border border-[#D8DDE4] bg-[#F5F6F8] px-8 py-7">
      <div className="mb-6 flex items-start justify-between gap-6">
        <div>
          <div className="mb-2 text-xs text-[#6B7280]"><Link href={`/goals/${goal.id}`} className="hover:text-[#111]">{goal.title}</Link> / {task.title.replace(/^任务\d+：/, "")}</div>
          <h1 className="text-[28px] font-semibold text-[#111]">{task.title.replace(/^任务\d+：/, "")}</h1>
          <p className="mt-2 text-sm text-[#6B7280]">完成进度：{task.progress}%（{task.expectedOutcome}）</p>
        </div>
        <Link href={`/goals/${goal.id}/tasks/${task.id}?view=${showDetail ? "list" : "detail"}`} className="rounded-lg border border-[#D0D7DE] px-3 py-2 text-sm text-[#111] hover:bg-white">
          {showDetail ? "隐藏信息" : "详细信息"}
        </Link>
      </div>
      {showDetail ? <DetailPanel task={task} /> : null}
      <div className="space-y-4">
        {[...task.instances].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).map((instance) => {
          const isToday = instance.dateLabel === "04-26" || instance.id === activeInstanceId;
          const canStart = instance.status !== "completed";
          return (
            <div key={instance.id} className="flex items-start gap-3">
              <DoraAvatar size="sm" />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between gap-2 text-xs text-[#6B7280]">
                  <div className="font-medium text-[#111]">Dora</div>
                  <span>{instance.dateLabel} {new Date(instance.createdAt).toISOString().slice(11, 16)}</span>
                </div>
                <div className="rounded-xl border border-[#7D8590] bg-white p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[#111]">
                    <span>{instance.dateLabel} {task.title.replace(/^任务\d+：/, "")}</span>
                    {isToday && canStart ? <span className="inline-flex h-2 w-2 rounded-full bg-[#E5484D]" /> : null}
                  </div>
                  <p className="text-sm leading-6 text-[#6B7280]">{instance.intro}</p>
                  {isToday && canStart ? (
                    <div className="mt-4 flex justify-center">
                      <Link href={`/goals/${goal.id}/tasks/${task.id}?view=exec&instanceId=${instance.id}`} className="rounded-md border border-[#7D8590] px-5 py-1.5 text-xs text-[#111] hover:bg-[#F5F6F8]">开始</Link>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
