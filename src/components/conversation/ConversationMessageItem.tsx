"use client";

import { Ellipsis, LayoutList } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { KikiAvatar } from "@/components/layout/KikiAvatar";
import { TaskMessageCard } from "@/components/conversation/TaskMessageCard";
import { formatMessageTime } from "@/lib/date";
import { cn } from "@/lib/utils";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useSagaInstancesStore } from "@/stores/sagaInstancesStore";
import type { SagaInstance } from "@/types/agentRuntime";
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
  const goals = useGoalStore(selectVisibleGoals);
  const sagaRequestId = message.kind === "text" ? message.sagaRequestId : undefined;
  const saga = useSagaInstancesStore((state) =>
    sagaRequestId
      ? Object.values(state.sagas).find((item) => item.idempotencyKey === sagaRequestId) ?? null
      : null,
  );
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

        {sagaRequestId && message.status === "streaming" ? (
          <SagaProgressCard saga={saga} />
        ) : null}

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

const SAGA_STEPS = [
  {
    key: "interview",
    role: "Interviewer",
    title: "理解目标",
    description: "确认背景信息与关键约束",
  },
  {
    key: "plan",
    role: "Planner",
    title: "拆解方案",
    description: "生成板块与任务草案",
  },
  {
    key: "critic",
    role: "Critic",
    title: "评审草案",
    description: "检查是否贴合目标",
  },
  {
    key: "refine",
    role: "Refiner",
    title: "按需修正",
    description: "根据评审意见调整草案",
  },
  {
    key: "present",
    role: "Presenter",
    title: "整理结果",
    description: "生成可确认的目标规划",
  },
] as const;

function SagaProgressCard({ saga }: { saga: SagaInstance | null }) {
  const currentStep = saga?.currentStep ?? "interview";
  const currentIndex = SAGA_STEPS.findIndex((step) => step.key === currentStep);
  const activeIndex = currentIndex >= 0 ? currentIndex : 0;
  const isTerminal = saga?.status === "completed" || saga?.status === "failed";

  return (
    <div className="mt-3 w-full max-w-xl rounded-2xl border border-[#E5E7EB] bg-[#FBFCFE] px-4 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-[12px] font-medium text-[#1F2328]">拆解进度</div>
        <div className="text-[12px] text-[#6B7280]">
          {saga ? formatSagaStatus(saga) : "启动中"}
        </div>
      </div>
      <div className="space-y-2">
        {SAGA_STEPS.map((step, index) => {
          const state = resolveSagaStepState({
            index,
            activeIndex,
            saga,
            isTerminal,
          });
          return (
            <div key={step.key} className="flex items-start gap-3">
              <div
                className={cn(
                  "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium",
                  state === "completed" && "border-[#1A7F37] bg-[#DAFBE1] text-[#1A7F37]",
                  state === "running" && "border-[#8250DF] bg-[#F0EDFF] text-[#5B3DBE]",
                  state === "failed" && "border-[#D1242F] bg-[#FFEBE9] text-[#D1242F]",
                  state === "pending" && "border-[#D0D7DE] bg-white text-[#8C9198]",
                )}
              >
                {state === "completed" ? "✓" : index + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-medium text-[#1F2328]">{step.title}</span>
                  <span className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[11px] text-[#6B7280]">
                    {step.role}
                  </span>
                  <span className={cn("text-[11px]", sagaStepStateClassName(state))}>
                    {formatSagaStepState(state)}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] leading-5 text-[#6B7280]">{step.description}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function resolveSagaStepState(input: {
  index: number;
  activeIndex: number;
  saga: SagaInstance | null;
  isTerminal: boolean;
}) {
  if (!input.saga) return input.index === 0 ? "running" : "pending";
  if (input.saga.status === "failed" && input.index === input.activeIndex) return "failed";
  if (input.saga.status === "completed") return "completed";
  if (input.index < input.activeIndex) return "completed";
  if (input.index === input.activeIndex && !input.isTerminal) return "running";
  return "pending";
}

function formatSagaStatus(saga: SagaInstance) {
  if (saga.status === "awaiting_user") return "等待补充信息";
  if (saga.status === "completed") return "已完成";
  if (saga.status === "failed") return "执行失败";
  const step = SAGA_STEPS.find((item) => item.key === saga.currentStep);
  return step ? `进行中：${step.title}` : "进行中";
}

function formatSagaStepState(state: ReturnType<typeof resolveSagaStepState>) {
  if (state === "completed") return "已完成";
  if (state === "running") return "进行中";
  if (state === "failed") return "失败";
  return "待开始";
}

function sagaStepStateClassName(state: ReturnType<typeof resolveSagaStepState>) {
  if (state === "completed") return "text-[#1A7F37]";
  if (state === "running") return "text-[#5B3DBE]";
  if (state === "failed") return "text-[#D1242F]";
  return "text-[#8C9198]";
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
