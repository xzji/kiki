"use client";

import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DoraAvatar } from "@/components/layout/DoraAvatar";
import { ConfirmActionView } from "@/components/execution/ConfirmActionView";
import { DraftReviewView } from "@/components/execution/DraftReviewView";
import { FlashcardView } from "@/components/execution/FlashcardView";
import { FreeformChatView } from "@/components/execution/FreeformChatView";
import { ListeningQAView } from "@/components/execution/ListeningQAView";
import { ReadingDigestView } from "@/components/execution/ReadingDigestView";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import type { Goal, Task, TaskInstance } from "@/types/dora";

export function ExecutionShell({ goal, task, instance }: { goal: Goal; task: Task; instance: TaskInstance }) {
  const router = useRouter();
  const completeTaskInstance = useGoalStore((state) => state.completeTaskInstance);
  const markInstanceStatus = useGoalStore((state) => state.markInstanceStatus);
  const items = useInboxStore((state) => state.items);
  const markRead = useInboxStore((state) => state.markRead);
  const archiveItem = useInboxStore((state) => state.archiveItem);
  const [started, setStarted] = useState(false);
  const [overrideKind, setOverrideKind] = useState<Task["executionKind"] | null>(null);
  const [done, setDone] = useState(false);

  const currentKind = overrideKind ?? task.executionKind;
  const currentInboxItem = items.find((item) => item.linkTo.includes(task.id));

  const finish = () => {
    completeTaskInstance(task.id, instance.id);
    if (currentInboxItem) {
      if (task.executionKind === "confirm_action" || task.executionKind === "draft_review") archiveItem(currentInboxItem.id);
      else markRead(currentInboxItem.id);
    }
    setDone(true);
    window.setTimeout(() => router.push(`/goals/${goal.id}/tasks/${task.id}`), 700);
  };

  return (
    <div className="px-2 py-2">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="text-xs text-[#6B7280]"><Link href={`/goals/${goal.id}`} className="hover:text-[#111]">{goal.title}</Link> / <Link href={`/goals/${goal.id}/tasks/${task.id}`} className="hover:text-[#111]">{task.title.replace(/^任务\d+：/, "")}</Link></div>
        <button className="rounded-full border border-[#D0D7DE] p-2 text-[#6B7280] hover:bg-white"><MessageCircle className="h-4 w-4" /></button>
      </div>
      {!started ? (
        <div className="rounded-xl border border-[#7D8590] bg-[#F5F6F8] p-8 text-center">
          <div className="mb-4 flex justify-center"><DoraAvatar size="sm" /></div>
          <p className="mx-auto max-w-2xl text-sm leading-7 text-[#374151]">{instance.intro}</p>
          <button className="mt-8 rounded-md border border-[#7D8590] px-6 py-1.5 text-xs text-[#111] hover:bg-[#F5F6F8]" onClick={() => { setStarted(true); markInstanceStatus(task.id, instance.id, "in_progress"); }}>开始</button>
        </div>
      ) : done ? (
        <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-10 text-center text-sm text-[#374151]">已完成，本次结果已经同步回实例列表。</div>
      ) : (
        <div className="space-y-6 rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-6">
          <div className="flex items-start gap-3">
            <DoraAvatar size="sm" />
            <div className="rounded-2xl border border-[#E5E7EB] bg-white px-4 py-3 text-sm leading-6 text-[#374151]">{instance.intro}</div>
          </div>
          {currentKind === "flashcard" && instance.payload.kind === "flashcard" ? <FlashcardView cards={instance.payload.cards} onComplete={finish} /> : null}
          {currentKind === "listening_qa" && instance.payload.kind === "listening_qa" ? <ListeningQAView questions={instance.payload.questions} onComplete={finish} /> : null}
          {currentKind === "reading_digest" && instance.payload.kind === "reading_digest" ? <ReadingDigestView articles={instance.payload.articles} onComplete={finish} /> : null}
          {currentKind === "confirm_action" && instance.payload.kind === "confirm_action" ? <ConfirmActionView summary={instance.payload.summary} onConfirm={finish} onRevise={() => setOverrideKind("freeform_chat")} /> : null}
          {currentKind === "draft_review" && instance.payload.kind === "draft_review" ? <DraftReviewView drafts={instance.payload.drafts} onComplete={finish} onRewrite={() => setOverrideKind("freeform_chat")} /> : null}
          {currentKind === "freeform_chat" ? <FreeformChatView threadId={`${task.id}-${instance.id}`} seed={instance.payload.kind === "freeform_chat" ? instance.payload.seed : "我会根据你的反馈继续推进。"} /> : null}
        </div>
      )}
    </div>
  );
}
