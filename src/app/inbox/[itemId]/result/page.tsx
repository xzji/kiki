"use client";

import { Minimize2, X } from "lucide-react";
import { notFound, useRouter } from "next/navigation";

import { ExecutionResultBody, buildInstanceCardTitle } from "@/components/task/ExecutionResultBody";
import { resolveInboxTaskContext } from "@/lib/inboxItem";
import { taskDrawerReturnPath } from "@/lib/routes";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";

export default function InboxResultPage({ params }: { params: { itemId: string } }) {
  const router = useRouter();
  const item = useInboxStore((state) => state.items.find((entry) => entry.id === params.itemId));
  const goals = useGoalStore(selectVisibleGoals);

  if (!item) return notFound();

  const context = resolveInboxTaskContext(item, goals);
  if (!context) return notFound();

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex min-h-12 shrink-0 items-center border-b border-[#E5E7EB] bg-white px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] md:h-12 md:px-4 md:py-0">
        <button
          type="button"
          aria-label="关闭"
          onClick={() => router.push("/")}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
        >
          <X className="h-4 w-4" />
        </button>
          <div className="ml-3 min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[#1F2328] md:ml-auto md:text-right">
          {buildInstanceCardTitle(context.task, context.instance)}
        </div>
        <button
          type="button"
          aria-label="收起为右侧边栏"
          onClick={() => router.push(taskDrawerReturnPath(context.goal.id, context.task.id, context.instance.id))}
            className="ml-3 hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8] md:flex"
        >
          <Minimize2 className="h-4 w-4" />
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-3xl px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 md:px-2 md:py-5">
          <ExecutionResultBody
            goal={context.goal}
            task={context.task}
            instance={context.instance}
            mode="result"
          />
        </div>
      </main>
    </div>
  );
}
