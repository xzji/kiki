"use client";

import { X } from "lucide-react";
import { notFound, useRouter } from "next/navigation";

import { ExecutionResultBody, buildInstanceCardTitle } from "@/components/task/ExecutionResultBody";
import { useConversationStore } from "@/stores/conversationStore";
import { useGoalStore } from "@/stores/goalStore";

export default function ConversationResultPage({
  params,
}: {
  params: { conversationId: string; messageId: string };
}) {
  const router = useRouter();
  const conversations = useConversationStore((state) => state.conversations);
  const goals = useGoalStore((state) => state.goals);

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
      <header className="flex h-12 shrink-0 items-center border-b border-[#E5E7EB] bg-white px-4">
        <button
          type="button"
          aria-label="关闭"
          onClick={() => router.push(`/conversations/${conversation.id}`)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="ml-auto text-right text-[13px] font-medium text-[#1F2328]">
          {buildInstanceCardTitle(task, instance)}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-3xl px-2 py-5">
          <ExecutionResultBody goal={goal} task={task} instance={instance} mode="result" />
        </div>
      </main>
    </div>
  );
}
