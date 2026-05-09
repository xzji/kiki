"use client";

import { useEffect, useState } from "react";

import { ConfirmActionView } from "@/components/execution/ConfirmActionView";
import { DraftReviewView } from "@/components/execution/DraftReviewView";
import { FlashcardView } from "@/components/execution/FlashcardView";
import { FreeformChatView } from "@/components/execution/FreeformChatView";
import { ListeningQAView } from "@/components/execution/ListeningQAView";
import { ReadingDigestView } from "@/components/execution/ReadingDigestView";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import type { Goal, Task, TaskInstance } from "@/types/kiki";

const EXECUTION_KIND_LABEL: Record<Task["executionKind"], string> = {
  flashcard: "记忆闪卡",
  listening_qa: "听力问答",
  reading_digest: "阅读摘要",
  confirm_action: "确认执行",
  draft_review: "草稿审阅",
  freeform_chat: "自由对话",
};

const PRACTICE_EXECUTION_KINDS = new Set<Task["executionKind"]>([
  "flashcard",
  "listening_qa",
  "reading_digest",
]);

export function buildInstanceCardTitle(task: Task, instance: TaskInstance) {
  const cleanTaskTitle = task.title.replace(/^任务\d+：/, "");
  const dateLabel = instance.dateLabel?.replace(/-/g, "") ?? "";
  return dateLabel ? `${dateLabel} ${cleanTaskTitle}` : cleanTaskTitle;
}

export function ExecutionResultBody({
  goal,
  task,
  instance,
  mode = "shell",
}: {
  goal: Goal;
  task: Task;
  instance: TaskInstance;
  mode?: "shell" | "result";
}) {
  const completeTaskInstance = useGoalStore((state) => state.completeTaskInstance);
  const markInstanceStatus = useGoalStore((state) => state.markInstanceStatus);
  const items = useInboxStore((state) => state.items);
  const markRead = useInboxStore((state) => state.markRead);
  const archiveItem = useInboxStore((state) => state.archiveItem);
  const shouldKeepStartGate =
    mode === "shell" || PRACTICE_EXECUTION_KINDS.has(task.executionKind);
  const [started, setStarted] = useState(
    shouldKeepStartGate ? instance.status === "in_progress" : true,
  );
  const [overrideKind, setOverrideKind] = useState<Task["executionKind"] | null>(null);
  const [done, setDone] = useState(instance.status === "completed");

  const currentKind = overrideKind ?? task.executionKind;
  const currentInboxItem = items.find((item) => item.linkTo.includes(task.id));

  useEffect(() => {
    if (mode !== "result" || shouldKeepStartGate) return;
    setStarted(true);
    if (instance.status === "pending" || instance.status === "awaiting_user") {
      markInstanceStatus(task.id, instance.id, "in_progress");
    }
  }, [instance.id, instance.status, markInstanceStatus, mode, shouldKeepStartGate, task.id]);

  const finish = () => {
    completeTaskInstance(task.id, instance.id);
    if (currentInboxItem) {
      if (task.executionKind === "confirm_action" || task.executionKind === "draft_review") {
        archiveItem(currentInboxItem.id);
      } else {
        markRead(currentInboxItem.id);
      }
    }
    setDone(true);
  };

  return (
    <div className="space-y-6">
      {done ? (
        <div className="rounded-xl border border-[#E5E7EB] bg-white p-6 text-center text-sm text-[#374151]">
          已完成，本次结果已经同步回实例列表。
        </div>
      ) : (
        <div className="rounded-xl border border-[#E5E7EB] bg-white p-6">
          {!started ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-[#1F2328]">
                  {buildInstanceCardTitle(task, instance)}
                </div>
                <div className="mt-1 text-[12px] text-[#8C9198]">
                  {EXECUTION_KIND_LABEL[task.executionKind]}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setStarted(true);
                  markInstanceStatus(task.id, instance.id, "in_progress");
                }}
                className="shrink-0 rounded-md border border-[#D0D7DE] bg-white px-4 py-1.5 text-[13px] text-[#1F2328] hover:border-[#111]"
              >
                开始
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <div className="text-[15px] font-semibold text-[#1F2328]">
                  {buildInstanceCardTitle(task, instance)}
                </div>
                <div className="mt-1 text-[12px] text-[#8C9198]">
                  {EXECUTION_KIND_LABEL[task.executionKind]}
                </div>
              </div>
              {currentKind === "flashcard" && instance.payload.kind === "flashcard" ? (
                <FlashcardView cards={instance.payload.cards} onComplete={finish} />
              ) : null}
              {currentKind === "listening_qa" && instance.payload.kind === "listening_qa" ? (
                <ListeningQAView questions={instance.payload.questions} onComplete={finish} />
              ) : null}
              {currentKind === "reading_digest" && instance.payload.kind === "reading_digest" ? (
                <ReadingDigestView articles={instance.payload.articles} onComplete={finish} />
              ) : null}
              {currentKind === "confirm_action" && instance.payload.kind === "confirm_action" ? (
                <ConfirmActionView
                  summary={instance.payload.summary}
                  onConfirm={finish}
                  onRevise={() => setOverrideKind("freeform_chat")}
                />
              ) : null}
              {currentKind === "draft_review" && instance.payload.kind === "draft_review" ? (
                <DraftReviewView
                  drafts={instance.payload.drafts}
                  onComplete={finish}
                  onRewrite={() => setOverrideKind("freeform_chat")}
                />
              ) : null}
              {currentKind === "freeform_chat" ? (
                <FreeformChatView
                  threadId={`${goal.id}-${task.id}-${instance.id}`}
                  seed={
                    instance.payload.kind === "freeform_chat"
                      ? instance.payload.seed
                      : "我会根据你的反馈继续推进。"
                  }
                />
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
