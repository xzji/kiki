"use client";

import { X } from "lucide-react";
import { notFound, useRouter } from "next/navigation";

import { ExecutionResultBody, buildInstanceCardTitle } from "@/components/task/ExecutionResultBody";
import { resolveInboxTaskContext } from "@/lib/inboxItem";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";

export default function InboxResultPage({ params }: { params: { itemId: string } }) {
  const router = useRouter();
  const item = useInboxStore((state) => state.items.find((entry) => entry.id === params.itemId));
  const goals = useGoalStore((state) => state.goals);

  if (!item) return notFound();

  const context = resolveInboxTaskContext(item, goals);
  if (!context) return notFound();

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex h-12 shrink-0 items-center border-b border-[#E5E7EB] bg-white px-4">
        <button
          type="button"
          aria-label="关闭"
          onClick={() => router.push("/")}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="ml-auto text-right text-[13px] font-medium text-[#1F2328]">
          {buildInstanceCardTitle(context.task, context.instance)}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-3xl px-2 py-5">
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
