"use client";

import { useState } from "react";

import { ConfirmActionView } from "@/components/execution/ConfirmActionView";
import { DraftReviewView } from "@/components/execution/DraftReviewView";
import { FlashcardView } from "@/components/execution/FlashcardView";
import { FreeformChatView } from "@/components/execution/FreeformChatView";
import { ListeningQAView } from "@/components/execution/ListeningQAView";
import { ReadingDigestView } from "@/components/execution/ReadingDigestView";
import { useGoalStore } from "@/stores/goalStore";
import type { Task, TaskInstance } from "@/types/dora";

const EXECUTION_KIND_LABEL: Record<Task["executionKind"], string> = {
  flashcard: "记忆闪卡",
  listening_qa: "听力问答",
  reading_digest: "阅读摘要",
  confirm_action: "确认执行",
  draft_review: "草稿审阅",
  freeform_chat: "自由对话",
};

function buildInstanceCardTitle(task: Task, instance: TaskInstance) {
  const cleanTaskTitle = task.title.replace(/^任务\d+：/, "");
  const dateLabel = instance.dateLabel?.replace(/-/g, "") ?? "";
  return dateLabel ? `${dateLabel} ${cleanTaskTitle}` : cleanTaskTitle;
}

/**
 * 会话消息里的任务卡片。
 * - 未开始：显示标题 + 执行方式 + 开始按钮
 * - 开始后：原地切换为对应 payload 的执行视图，卡片容器尺寸保持一致
 * - 完成：显示简短完成提示
 */
export function TaskMessageCard({ task, instance }: { task: Task; instance: TaskInstance }) {
  const completeTaskInstance = useGoalStore((state) => state.completeTaskInstance);
  const markInstanceStatus = useGoalStore((state) => state.markInstanceStatus);
  const [started, setStarted] = useState(instance.status === "in_progress");
  const [overrideKind, setOverrideKind] = useState<Task["executionKind"] | null>(null);
  const [done, setDone] = useState(instance.status === "completed");

  const currentKind = overrideKind ?? task.executionKind;

  const finish = () => {
    completeTaskInstance(task.id, instance.id);
    setDone(true);
  };

  if (done) {
    return (
      <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-white p-5 text-center text-sm text-[#374151]">
        已完成，本次结果已经同步回任务实例。
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-white p-5">
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
        <div className="space-y-4">
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
              threadId={`${task.id}-${instance.id}`}
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
  );
}
