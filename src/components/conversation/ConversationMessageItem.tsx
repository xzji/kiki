"use client";

import { Ellipsis, LayoutList } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { KikiAvatar } from "@/components/layout/KikiAvatar";
import { TaskMessageCard } from "@/components/conversation/TaskMessageCard";
import { cn } from "@/lib/utils";
import { useGoalStore } from "@/stores/goalStore";
import type { ConversationMessage } from "@/types/kiki";

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
  onOpenResult,
  onOpenTaskInfo,
  onOpenGoalPlan,
  onTaskOptionalFeedback,
  onDelete,
}: {
  message: ConversationMessage;
  onQuote: (message: ConversationMessage) => void;
  onOpenResult?: (message: ConversationMessage) => void;
  onOpenTaskInfo?: (message: ConversationMessage) => void;
  onOpenGoalPlan?: (goalId: string) => void;
  onTaskOptionalFeedback?: (message: ConversationMessage, feedback: string) => Promise<void> | void;
  onDelete: (messageId: string) => void;
}) {
  const goals = useGoalStore((state) => state.goals);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const taskInfo = useMemo(() => {
    if (message.kind !== "task_card") return null;
    const goal = goals.find((g) => g.id === message.taskRef.goalId);
    if (!goal) {
      return message.taskSnapshot ? { goal: null, subGoal: null, ...message.taskSnapshot } : null;
    }
    const subGoal = goal.subGoals.find((sg) => sg.id === message.taskRef.subGoalId);
    if (!subGoal) {
      return message.taskSnapshot ? { goal, subGoal: null, ...message.taskSnapshot } : null;
    }
    const task = subGoal.tasks.find((t) => t.id === message.taskRef.taskId);
    if (!task) {
      return message.taskSnapshot ? { goal, subGoal, ...message.taskSnapshot } : null;
    }
    const instance = task.instances.find((i) => i.id === message.taskRef.instanceId);
    if (!instance) {
      return message.taskSnapshot ? { goal, subGoal, task: message.taskSnapshot.task, instance: message.taskSnapshot.instance } : null;
    }
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
        <div className="flex max-w-[66%] items-end gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-end gap-2 text-[12px]">
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
          <div className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#534f69]/25 bg-[#E9E6FF] text-[11px] text-[#5F5AA2]">
            J
          </div>
        </div>
      </div>
    );
  }

  const isKikiLoading = message.status === "streaming" && message.content.trim().length === 0;

  return (
    <div className="group relative flex items-start gap-3">
      <KikiAvatar size="sm" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
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
        <div className="max-w-3xl">
          {isKikiLoading ? <LoadingDots /> : <MarkdownRenderer content={message.content} />}
        </div>

        {message.kind === "task_card" && taskInfo ? (
          <TaskMessageCard
            task={taskInfo.task}
            instance={taskInfo.instance}
            onOpen={() => onOpenResult?.(message)}
            onOptionalFeedbackSelect={
              message.kind === "task_card" && onTaskOptionalFeedback
                ? (feedback) => onTaskOptionalFeedback(message, feedback)
                : undefined
            }
          />
        ) : null}

        {message.kind === "goal_plan_card" ? (
          <GoalPlanMessageCard
            title={message.goalRef.title}
            summary={message.goalRef.summary}
            subGoalCount={message.goalRef.subGoalCount}
            taskCount={message.goalRef.taskCount}
            onOpen={() => onOpenGoalPlan?.(message.goalRef.goalId)}
          />
        ) : null}
      </div>
    </div>
  );
}

function GoalPlanMessageCard({
  title,
  summary,
  subGoalCount,
  taskCount,
  onOpen,
}: {
  title: string;
  summary?: string;
  subGoalCount: number;
  taskCount: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-3 block w-full max-w-xl rounded-2xl border border-[#D0D7DE] bg-white p-4 text-left shadow-sm transition hover:border-[#111] hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-[#F0EDFF] text-[#5B3DBE]">
          <LayoutList className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-[#6B7280]">目标规划草案</div>
          <div className="mt-1 text-base font-semibold leading-6 text-[#1F2328]">{title}</div>
          {summary ? (
            <div className="mt-2 line-clamp-2 text-[13px] leading-5 text-[#6B7280]">{summary}</div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-[#6B7280]">
            <span className="rounded-md bg-[#F5F6F8] px-2 py-1">{subGoalCount} 个子目标</span>
            <span className="rounded-md bg-[#F5F6F8] px-2 py-1">{taskCount} 个任务</span>
            <span className="ml-auto font-medium text-[#1F2328]">打开规划</span>
          </div>
        </div>
      </div>
    </button>
  );
}

function LoadingDots() {
  return (
    <span className="inline-flex h-6 items-center gap-1" aria-label="KiKi 正在输入">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#9AA0A6]"
          style={{ animationDelay: `${index * 120}ms` }}
        />
      ))}
    </span>
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
