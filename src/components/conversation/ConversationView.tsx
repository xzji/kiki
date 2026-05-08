"use client";

import { ChevronsRight, LayoutList, Maximize2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AssistantComposer } from "@/components/layout/AssistantComposer";
import { ConversationMessageItem } from "@/components/conversation/ConversationMessageItem";
import { GoalPlanDrawer } from "@/components/conversation/GoalPlanDrawer";
import { GoalPlanBreadcrumb } from "@/components/goal/GoalPlanContent";
import { TaskDetailBody } from "@/components/goal/TaskDetailBody";
import { TaskResultDrawer } from "@/components/task/TaskResultDrawer";
import { useConversationStore } from "@/stores/conversationStore";
import { useGoalStore } from "@/stores/goalStore";
import { useNavSidebarStore } from "@/stores/navSidebarStore";
import type { ConversationMessage } from "@/types/dora";

/**
 * 会话视图：
 * - 顶部栏：会话标题 + 右上角「目标规划」按钮（仅绑定目标时显示）
 * - 中间：消息流（KiKi + 用户 + 任务卡片）
 * - 底部：输入框
 */
export function ConversationView({ conversationId }: { conversationId: string }) {
  const conversations = useConversationStore((state) => state.conversations);
  const appendMessage = useConversationStore((state) => state.appendMessage);
  const markConversationRead = useConversationStore((state) => state.markConversationRead);
  const deleteMessage = useConversationStore((state) => state.deleteMessage);
  const goals = useGoalStore((state) => state.goals);
  const conversation = conversations.find((c) => c.id === conversationId);
  const [planOpen, setPlanOpen] = useState(false);
  const [planFocus, setPlanFocus] = useState<string | null>(null);
  const [quotedMessage, setQuotedMessage] = useState<ConversationMessage | null>(null);
  const [resultMessage, setResultMessage] = useState<ConversationMessage | null>(null);
  const [taskInfoMessage, setTaskInfoMessage] = useState<ConversationMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstUnreadMarkerRef = useRef<HTMLDivElement>(null);
  const initializedConversationRef = useRef<string | null>(null);
  const [entryUnreadIds, setEntryUnreadIds] = useState<string[]>([]);
  const [showUnreadJump, setShowUnreadJump] = useState(false);

  // 进入会话标记为已读
  useEffect(() => {
    if (!conversation) return;
    if (initializedConversationRef.current === conversation.id) return;
    initializedConversationRef.current = conversation.id;

    const unreadIds = conversation.messages
      .filter((message) => message.unread)
      .map((message) => message.id);
    setEntryUnreadIds(unreadIds);
    setShowUnreadJump(unreadIds.length > 0);
    markConversationRead(conversation.id);
  }, [conversation, markConversationRead]);

  const sortedMessages = useMemo(() => {
    if (!conversation) return [] as ConversationMessage[];
    return [...conversation.messages].sort(
      (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
    );
  }, [conversation]);

  // 默认定位到最新消息
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [sortedMessages.length]);

  const firstUnreadId = entryUnreadIds[0] ?? null;
  const unreadCount = entryUnreadIds.length;

  useEffect(() => {
    if (!firstUnreadId) {
      setShowUnreadJump(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      const marker = firstUnreadMarkerRef.current;
      if (!container || !marker) return;
      const markerVisible =
        marker.offsetTop >= container.scrollTop &&
        marker.offsetTop + marker.offsetHeight <= container.scrollTop + container.clientHeight;
      setShowUnreadJump(!markerVisible);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [firstUnreadId, sortedMessages.length]);

  if (!conversation) return notFound();

  const taskInfo = (() => {
    if (!taskInfoMessage || taskInfoMessage.kind !== "task_card") return null;
    const goal = goals.find((item) => item.id === taskInfoMessage.taskRef.goalId);
    if (!goal) return null;
    const task =
      goal.subGoals
        .flatMap((subGoal) => subGoal.tasks)
        .find((item) => item.id === taskInfoMessage.taskRef.taskId) ?? null;
    if (!task) return null;
    return { goal, task };
  })();

  const resultInfo = (() => {
    if (!resultMessage || resultMessage.kind !== "task_card") return null;
    const goal = goals.find((item) => item.id === resultMessage.taskRef.goalId);
    if (!goal) return null;
    const task =
      goal.subGoals
        .flatMap((subGoal) => subGoal.tasks)
        .find((item) => item.id === resultMessage.taskRef.taskId) ?? null;
    if (!task) return null;
    const instance = task.instances.find((item) => item.id === resultMessage.taskRef.instanceId) ?? null;
    if (!instance) return null;
    return { goal, task, instance, message: resultMessage };
  })();

  const onSend = (text: string) => {
    const now = new Date().toISOString();
    appendMessage(conversation.id, {
      id: `msg-user-${Date.now()}`,
      kind: "text",
      role: "user",
      content: text,
      createdAt: now,
    });
    // mock KiKi 回复
    window.setTimeout(() => {
      appendMessage(conversation.id, {
        id: `msg-kiki-${Date.now()}`,
        kind: "text",
        role: "kiki",
        content: "收到，我会在合适的时机推进。",
        createdAt: new Date().toISOString(),
      });
    }, 400);
    setQuotedMessage(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* 顶部栏 */}
      <header className="flex h-11 flex-none items-center justify-between border-b border-[#E5E7EB] px-2">
        <div className="text-[15px] font-semibold text-[#1F2328]">{conversation.title}</div>
        {conversation.goalId ? (
          <button
            type="button"
            onClick={() => {
              setPlanFocus(null);
              setPlanOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#D0D7DE] bg-white px-2.5 py-1 text-[12px] text-[#1F2328] hover:border-[#111]"
          >
            <LayoutList className="h-3.5 w-3.5" />
            目标规划
          </button>
        ) : null}
      </header>

      {/* 消息流 */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="flex h-full overflow-y-auto overscroll-contain px-2 pb-5 pt-3"
        >
          {sortedMessages.length === 0 ? (
            <div className="mx-auto mt-20 max-w-md text-center text-[13px] text-[#8C9198]">
              和 KiKi 聊聊你的目标或想法，输入 <span className="font-mono text-[#1F2328]">/goal</span>{" "}
              可以进入目标规划模式。
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
              {sortedMessages.map((msg) => (
                <div key={msg.id}>
                  {firstUnreadId === msg.id ? (
                    <div
                      ref={firstUnreadMarkerRef}
                      className="mb-5 flex items-center gap-3 text-[12px] text-[#8C9198]"
                    >
                      <div className="h-px flex-1 bg-[#E5E7EB]" />
                      <span>以下为新消息</span>
                      <div className="h-px flex-1 bg-[#E5E7EB]" />
                    </div>
                  ) : null}
                  <ConversationMessageItem
                    message={msg}
                    onQuote={(message) => setQuotedMessage(message)}
                    onOpenResult={(message) => {
                      setTaskInfoMessage(null);
                      setPlanOpen(false);
                      setResultMessage(message);
                    }}
                    onOpenTaskInfo={(message) => {
                      setResultMessage(null);
                      setTaskInfoMessage(message);
                    }}
                    onDelete={(messageId) => {
                      deleteMessage(conversation.id, messageId);
                      if (quotedMessage?.id === messageId) {
                        setQuotedMessage(null);
                      }
                      if (resultMessage?.id === messageId) {
                        setResultMessage(null);
                      }
                      if (taskInfoMessage?.id === messageId) {
                        setTaskInfoMessage(null);
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {showUnreadJump && unreadCount > 0 ? (
          <button
            type="button"
            onClick={() => {
              firstUnreadMarkerRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
              setShowUnreadJump(false);
            }}
            className="absolute bottom-4 right-6 rounded-full border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] text-[#1F2328] shadow-sm hover:border-[#111]"
          >
            {unreadCount}条新消息
          </button>
        ) : null}
      </div>

      {/* 底部输入 */}
      <div className="flex-none bg-white px-2 pb-3 pt-3">
        <div className="mx-auto max-w-3xl">
          <AssistantComposer
            onSubmit={onSend}
            quotedMessage={
              quotedMessage
                ? {
                    roleLabel: quotedMessage.role === "user" ? "你" : "KiKi",
                    content: quotedMessage.content,
                  }
                : null
            }
            onClearQuote={() => setQuotedMessage(null)}
          />
        </div>
      </div>

      <GoalPlanDrawer
        goalId={conversation.goalId}
        open={planOpen}
        focusSubGoalId={planFocus}
        onClose={() => setPlanOpen(false)}
      />

      {taskInfo ? (
        <>
          <button
            type="button"
            aria-label="关闭任务信息"
            onClick={() => setTaskInfoMessage(null)}
            className="fixed inset-0 z-30 bg-transparent"
          />
          <aside className="fixed inset-y-0 right-0 z-40 flex w-[60vw] min-w-[640px] flex-col border-l border-[#E5E7EB] bg-white">
            <div className="flex h-12 flex-none items-center border-b border-[#E5E7EB] px-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="关闭任务信息"
                  onClick={() => setTaskInfoMessage(null)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
                >
                  <ChevronsRight className="h-4 w-4" />
                </button>
                <Link
                  href={`/goals/${taskInfo.goal.id}/tasks/${taskInfo.task.id}`}
                  aria-label="全屏查看任务信息"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
                >
                  <Maximize2 className="h-4 w-4" />
                </Link>
              </div>
              <GoalPlanBreadcrumb
                goalId={taskInfo.goal.id}
                goalTitle={taskInfo.goal.title}
                taskTitle={taskInfo.task.title.replace(/^任务\d+：/, "")}
                className="ml-auto"
                disableLinks
                onGoalPlanClick={() => {
                  setTaskInfoMessage(null);
                  setPlanFocus(
                    taskInfoMessage?.kind === "task_card"
                      ? taskInfoMessage.taskRef.subGoalId
                      : null,
                  );
                  setPlanOpen(true);
                }}
                onGoalClick={() => {
                  setTaskInfoMessage(null);
                  setPlanFocus(null);
                  setPlanOpen(true);
                }}
              />
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5">
              <div className="mx-auto w-full max-w-3xl">
                <TaskDetailBody goal={taskInfo.goal} task={taskInfo.task} />
              </div>
            </div>
          </aside>
        </>
      ) : null}

      <TaskResultDrawer
        open={Boolean(resultInfo)}
        goal={resultInfo?.goal ?? null}
        task={resultInfo?.task ?? null}
        instance={resultInfo?.instance ?? null}
        fullscreenHref={
          resultInfo ? `/conversations/${conversation.id}/results/${resultInfo.message.id}` : "#"
        }
        onClose={() => setResultMessage(null)}
      />
    </div>
  );
}
