"use client";

import { buildInstanceCardTitle } from "@/components/task/ExecutionResultBody";
import type { Task, TaskInstance } from "@/types/dora";

const EXECUTION_KIND_LABEL: Record<Task["executionKind"], string> = {
  flashcard: "记忆闪卡",
  listening_qa: "听力问答",
  reading_digest: "阅读摘要",
  confirm_action: "确认执行",
  draft_review: "草稿审阅",
  freeform_chat: "自由对话",
};

/**
 * 会话消息里的任务卡片。
 * - 展示任务结果摘要
 * - 点击整张卡片，打开右侧结果边栏
 */
export function TaskMessageCard({
  task,
  instance,
  onOpen,
}: {
  task: Task;
  instance: TaskInstance;
  onOpen: () => void;
}) {
  const statusLabel =
    instance.status === "completed"
      ? "已完成"
      : instance.status === "in_progress"
        ? "进行中"
        : instance.status === "awaiting_user"
          ? "待确认"
          : instance.status === "paused"
            ? "已暂停"
            : "待处理";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-3 block w-full rounded-xl border border-[#E5E7EB] bg-white p-5 text-left hover:border-[#111]"
    >
      <div className="min-w-0">
        <div className="text-[15px] font-semibold text-[#1F2328]">
          {buildInstanceCardTitle(task, instance)}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[#8C9198]">
          <span>{EXECUTION_KIND_LABEL[task.executionKind]}</span>
          <span className="text-[#D0D7DE]">/</span>
          <span>{statusLabel}</span>
        </div>
        <div className="mt-2 line-clamp-2 text-[13px] leading-6 text-[#374151]">
          {instance.intro}
        </div>
      </div>
    </button>
  );
}
