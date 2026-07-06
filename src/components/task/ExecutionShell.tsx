"use client";

import { MessageCircle } from "lucide-react";
import Link from "next/link";

import { ExecutionResultBody } from "@/components/task/ExecutionResultBody";
import type { Goal, Task, TaskInstance } from "@/types/kiki";

export function ExecutionShell({ goal, task, instance }: { goal: Goal; task: Task; instance: TaskInstance }) {
  return (
    <div className="px-2 py-2">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="text-xs text-ink-soft"><Link href={`/goals/${goal.id}`} className="hover:text-[#111]">{goal.title}</Link> / <Link href={`/goals/${goal.id}/tasks/${task.id}`} className="hover:text-[#111]">{task.title.replace(/^任务\d+：/, "")}</Link></div>
        <button className="rounded-full border border-line-strong p-2 text-ink-soft hover:bg-white"><MessageCircle className="h-4 w-4" /></button>
      </div>
      <ExecutionResultBody goal={goal} task={task} instance={instance} />
    </div>
  );
}
