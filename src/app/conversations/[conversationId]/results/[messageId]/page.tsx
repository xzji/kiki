"use client";

import { Minimize2, X } from "lucide-react";
import { notFound, useRouter } from "next/navigation";

import { ExecutionResultBody, buildInstanceCardTitle } from "@/components/task/ExecutionResultBody";
import { useConversationStore } from "@/stores/conversationStore";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";

export default function ConversationResultPage({
  params,
}: {
  params: { conversationId: string; messageId: string };
}) {
  const router = useRouter();
  const conversations = useConversationStore((state) => state.conversations);
  const goals = useGoalStore(selectVisibleGoals);

  const conversation = conversations.find((c) => c.id === params.conversationId) ?? null;
  const message =
    conversation?.messages.find((m) => m.id === params.messageId) ?? null;

  if (!conversation || !message || message.kind !== "task_card") return notFound();

  const goal = goals.find((g) => g.id === message.taskRef.goalId) ?? null;
  const task =
    goal?.subGoals
      .flatMap((subGoal) => subGoal.tasks)
      .find((t) => t.id === message.taskRef.taskId) ?? null;
  const instance = task?.instances.find((i) => i.id === message.taskRef.instanceId) ?? null;

  if (!goal || !task || !instance) return notFound();

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex min-h-12 shrink-0 items-center border-b border-line bg-white px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] md:h-12 md:px-4 md:py-0">
        <button
          type="button"
          aria-label="关闭"
          onClick={() => router.push(`/conversations/${conversation.id}`)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-surface"
        >
          <X className="h-4 w-4" />
        </button>
          <div className="ml-3 min-w-0 flex-1 truncate text-left text-[13px] font-medium text-ink md:ml-auto md:text-right">
          {buildInstanceCardTitle(task, instance)}
        </div>
        <button
          type="button"
          aria-label="收起为右侧边栏"
          onClick={() =>
            router.push(`/conversations/${conversation.id}?resultMessageId=${encodeURIComponent(message.id)}`)
          }
            className="ml-3 hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-surface md:flex"
        >
          <Minimize2 className="h-4 w-4" />
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-3xl px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 md:px-2 md:py-5">
          <ExecutionResultBody goal={goal} task={task} instance={instance} mode="result" />
        </div>
      </main>
    </div>
  );
}
