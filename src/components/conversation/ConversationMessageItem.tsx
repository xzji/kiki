"use client";

import { Ellipsis } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DoraAvatar } from "@/components/layout/DoraAvatar";
import { TaskMessageCard } from "@/components/conversation/TaskMessageCard";
import { cn } from "@/lib/utils";
import { useGoalStore } from "@/stores/goalStore";
import type { ConversationMessage } from "@/types/dora";

/**
 * 单条对话消息。
 * - KiKi：头像 + 昵称 + 文本 +（可选）任务卡片
 * - 用户：右侧气泡
 * - 未读：消息左侧有小红点（仅 KiKi）
 * - hover：右上角「更多」菜单（仅 KiKi task_card）
 */
export function ConversationMessageItem({
  message,
  onQuote,
  onOpenTaskInfo,
  onDelete,
}: {
  message: ConversationMessage;
  onQuote: (message: ConversationMessage) => void;
  onOpenTaskInfo?: (message: ConversationMessage) => void;
  onDelete: (messageId: string) => void;
}) {
  const goals = useGoalStore((state) => state.goals);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const taskInfo = useMemo(() => {
    if (message.kind !== "task_card") return null;
    const goal = goals.find((g) => g.id === message.taskRef.goalId);
    if (!goal) return null;
    const subGoal = goal.subGoals.find((sg) => sg.id === message.taskRef.subGoalId);
    if (!subGoal) return null;
    const task = subGoal.tasks.find((t) => t.id === message.taskRef.taskId);
    if (!task) return null;
    const instance = task.instances.find((i) => i.id === message.taskRef.instanceId);
    if (!instance) return null;
    return { goal, subGoal, task, instance };
  }, [goals, message]);

  const timeLabel = formatMessageTime(message.createdAt);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  if (message.role === "user") {
    return (
      <div className="group flex justify-end">
        <div className="max-w-[60%]">
          <div className="mb-1 flex items-center justify-end gap-2 text-[12px]">
            <div className="font-medium text-[#1F2328]">你</div>
            <div className="text-[#8C9198] opacity-0 transition-opacity group-hover:opacity-100">
              {timeLabel}
            </div>
            <div ref={menuRef} className="relative">
              <button
                type="button"
                aria-label="更多"
                onClick={() => setMenuOpen((prev) => !prev)}
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-md text-[#9AA0A6] transition-opacity hover:bg-[#F5F6F8] hover:text-[#1F2328]",
                  "opacity-0 group-hover:opacity-100",
                  menuOpen && "opacity-100",
                )}
              >
                <Ellipsis className="h-4 w-4" />
              </button>
              {menuOpen ? (
                <MessageMenu
                  canOpenTaskInfo={false}
                  onQuote={() => onQuote(message)}
                  onOpenTaskInfo={onOpenTaskInfo ? () => onOpenTaskInfo(message) : undefined}
                  onDelete={() => onDelete(message.id)}
                  onClose={() => setMenuOpen(false)}
                />
              ) : null}
            </div>
          </div>
          <div className="rounded-2xl rounded-br-sm bg-[#111] px-4 py-2.5 text-sm leading-6 text-white">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative flex items-start gap-3">
      <DoraAvatar size="sm" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[13px] font-medium text-[#1F2328]">KiKi</div>
          <div ref={menuRef} className="relative flex items-center gap-1.5">
            <div className="text-[12px] text-[#8C9198] opacity-0 transition-opacity group-hover:opacity-100">
              {timeLabel}
            </div>
            <button
              type="button"
              aria-label="更多"
              onClick={() => setMenuOpen((prev) => !prev)}
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-md text-[#9AA0A6] transition-opacity hover:bg-[#F5F6F8] hover:text-[#1F2328]",
                "opacity-0 group-hover:opacity-100",
                menuOpen && "opacity-100",
              )}
            >
              <Ellipsis className="h-4 w-4" />
            </button>
            {menuOpen ? (
              <MessageMenu
                canOpenTaskInfo={Boolean(taskInfo)}
                onQuote={() => onQuote(message)}
                onOpenTaskInfo={onOpenTaskInfo ? () => onOpenTaskInfo(message) : undefined}
                onDelete={() => onDelete(message.id)}
                onClose={() => setMenuOpen(false)}
              />
            ) : null}
          </div>
        </div>
        <div className="max-w-3xl whitespace-pre-wrap text-sm leading-6 text-[#374151]">
          {message.content}
        </div>

        {message.kind === "task_card" && taskInfo ? (
          <TaskMessageCard task={taskInfo.task} instance={taskInfo.instance} />
        ) : null}
      </div>
    </div>
  );
}

function MessageMenu({
  canOpenTaskInfo,
  onQuote,
  onOpenTaskInfo,
  onDelete,
  onClose,
}: {
  canOpenTaskInfo: boolean;
  onQuote: () => void;
  onOpenTaskInfo?: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-0 top-7 z-20 w-36 overflow-hidden rounded-lg border border-[#E5E7EB] bg-white py-1 text-[12px] text-[#1F2328] shadow-sm">
      <button
        type="button"
        onClick={() => {
          onQuote();
          onClose();
        }}
        className="block w-full px-3 py-2 text-left hover:bg-[#F8F9FB]"
      >
        引用
      </button>
      <button
        type="button"
        disabled={!canOpenTaskInfo}
        onClick={() => {
          if (!canOpenTaskInfo || !onOpenTaskInfo) return;
          onOpenTaskInfo();
          onClose();
        }}
        className={cn(
          "block w-full px-3 py-2 text-left hover:bg-[#F8F9FB]",
          !canOpenTaskInfo && "cursor-not-allowed text-[#B0B6BE] hover:bg-white",
        )}
      >
        查看任务信息
      </button>
      <button
        type="button"
        onClick={() => {
          onDelete();
          onClose();
        }}
        className="block w-full px-3 py-2 text-left text-[#D1242F] hover:bg-[#F8F9FB]"
      >
        删除
      </button>
    </div>
  );
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}
