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
import { streamClaudeChat } from "@/lib/api/claude";
import { continueGoalWorkflowAfterInfo, startGoalInfoCollection } from "@/lib/goalWorkflow";
import { openSettings } from "@/lib/settings";
import { parseSlashCommand } from "@/lib/slashCommands";
import { useConversationStore } from "@/stores/conversationStore";
import { useGoalStore } from "@/stores/goalStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { ConversationMessage } from "@/types/kiki";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * 会话视图：
 * - 顶部栏：会话标题 + 右上角「目标规划」按钮（仅绑定目标时显示）
 * - 中间：消息流（KiKi + 用户 + 任务卡片）
 * - 底部：输入框
 */
export function ConversationView({ conversationId }: { conversationId: string }) {
  const conversations = useConversationStore((state) => state.conversations);
  const appendMessage = useConversationStore((state) => state.appendMessage);
  const updateMessage = useConversationStore((state) => state.updateMessage);
  const markConversationRead = useConversationStore((state) => state.markConversationRead);
  const deleteMessage = useConversationStore((state) => state.deleteMessage);
  const setConversationRuntimeEnv = useConversationStore((state) => state.setConversationRuntimeEnv);
  const setClaudeSessionId = useConversationStore((state) => state.setClaudeSessionId);
  const setConversationStatus = useConversationStore((state) => state.setConversationStatus);
  const setGoalInfoCollection = useConversationStore((state) => state.setGoalInfoCollection);
  const goals = useGoalStore((state) => state.goals);
  const activeRuntimeEnv = useRuntimeEnvStore((state) => state.getActiveEnvironment());
  const conversation = conversations.find((c) => c.id === conversationId);
  const [planOpen, setPlanOpen] = useState(false);
  const [activePlanGoalId, setActivePlanGoalId] = useState<string | null>(null);
  const [planFocus, setPlanFocus] = useState<string | null>(null);
  const [quotedMessage, setQuotedMessage] = useState<ConversationMessage | null>(null);
  const [resultMessage, setResultMessage] = useState<ConversationMessage | null>(null);
  const [taskInfoMessage, setTaskInfoMessage] = useState<ConversationMessage | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
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

  const onSend = async (
    text: string,
    quoted?: {
      roleLabel: string;
      content: string;
    } | null,
  ) => {
    const parsedCommand = parseSlashCommand(text);
    if (
      conversation.goalInfoCollection &&
      !(parsedCommand.kind === "command" && parsedCommand.command === "goal")
    ) {
      const now = new Date().toISOString();
      const userId = `msg-user-${Date.now()}`;
      const assistantId = `msg-kiki-${Date.now() + 1}`;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      activeAssistantMessageIdRef.current = assistantId;
      appendMessage(conversation.id, {
        id: userId,
        kind: "text",
        role: "user",
        content: text,
        createdAt: now,
        source: "user",
        status: "done",
      });
      appendMessage(conversation.id, {
        id: assistantId,
        kind: "text",
        role: "kiki",
        content: "已收到背景信息，正在拆解子目标...",
        createdAt: now,
        status: "streaming",
        source: "kiki",
      });
      setConversationStatus(conversation.id, "streaming");
      setStreamError(null);

      try {
        const result = await continueGoalWorkflowAfterInfo({
          answer: text,
          source: "conversation",
          conversationId: conversation.id,
          signal: controller.signal,
          onProgress: (progress) => {
            updateMessage(conversation.id, assistantId, (message) => ({
              ...message,
              content: progress.message,
            }));
          },
        });
        if (result.kind === "collecting_info") {
          const latestRound = result.collection.rounds[result.collection.rounds.length - 1];
          const questionText = latestRound.questions
            .map((question, index) => `${index + 1}. ${question}`)
            .join("\n");
          updateMessage(conversation.id, assistantId, (message) => ({
            ...message,
            content: `${result.assistantMessage}\n\n${questionText}\n\n你可以继续在下一条消息里一次性回答这些问题。`,
            status: "done",
          }));
          setConversationStatus(conversation.id, "idle");
          return;
        }
        setGoalInfoCollection(conversation.id, null);
        updateMessage(conversation.id, assistantId, (message) => ({
          id: message.id,
          kind: "goal_plan_card",
          role: "kiki",
          content: "目标规划草案已生成。点击下方卡片或右上角「目标规划」查看详情并确认启动。",
          createdAt: message.createdAt,
          unread: message.unread,
          status: "done",
          source: "kiki",
          goalRef: {
            goalId: result.goalId,
            title: result.goalTitle,
            summary: result.summary,
            subGoalCount: result.subGoalCount,
            taskCount: result.taskCount,
          },
        }));
        setConversationStatus(conversation.id, "idle");
        setActivePlanGoalId(result.goalId);
      } catch (error) {
        if (isAbortError(error)) {
          setConversationStatus(conversation.id, "idle");
          return;
        }
        updateMessage(conversation.id, assistantId, (message) => ({
          ...message,
          content: error instanceof Error ? error.message : "目标规划生成失败",
          status: "error",
        }));
        setConversationStatus(conversation.id, "error");
        setStreamError(error instanceof Error ? error.message : "目标规划生成失败");
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
          activeAssistantMessageIdRef.current = null;
        }
      }
      setQuotedMessage(null);
      return;
    }

    if (parsedCommand.kind === "unknown") {
      setStreamError(`暂不支持 ${parsedCommand.commandText} 命令。你可以先使用 /goal 创建长程目标。`);
      return;
    }

    if (parsedCommand.kind === "command" && parsedCommand.command === "goal") {
      const now = new Date().toISOString();
      const userId = `msg-user-${Date.now()}`;
      const assistantId = `msg-kiki-${Date.now() + 1}`;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      activeAssistantMessageIdRef.current = assistantId;
      appendMessage(conversation.id, {
        id: userId,
        kind: "text",
        role: "user",
        content: text,
        createdAt: now,
        source: "user",
        status: "done",
      });
      appendMessage(conversation.id, {
        id: assistantId,
        kind: "text",
        role: "kiki",
        content: "正在理解目标和关键约束...",
        createdAt: now,
        status: "streaming",
        source: "kiki",
      });
      setConversationStatus(conversation.id, "streaming");
      setStreamError(null);

      try {
        const result = await startGoalInfoCollection({
          goalText: parsedCommand.payload,
          source: "conversation",
          conversationId: conversation.id,
          signal: controller.signal,
          onProgress: (progress) => {
            updateMessage(conversation.id, assistantId, (message) => ({
              ...message,
              content: progress.message,
            }));
          },
        });
        const latestRound = result.collection.rounds[result.collection.rounds.length - 1];
        const questionText = latestRound.questions
          .map((question, index) => `${index + 1}. ${question}`)
          .join("\n");
        updateMessage(conversation.id, assistantId, (message) => ({
          ...message,
          content: `${result.assistantMessage}\n\n${questionText}\n\n你可以直接在下一条消息里一次性回答这些问题。`,
          status: "done",
        }));
        setConversationStatus(conversation.id, "idle");
      } catch (error) {
        if (isAbortError(error)) {
          setConversationStatus(conversation.id, "idle");
          return;
        }
        updateMessage(conversation.id, assistantId, (message) => ({
          ...message,
          content: error instanceof Error ? error.message : "目标规划生成失败",
          status: "error",
        }));
        setConversationStatus(conversation.id, "error");
        setStreamError(error instanceof Error ? error.message : "目标规划生成失败");
      }
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
        activeAssistantMessageIdRef.current = null;
      }
      setQuotedMessage(null);
      return;
    }

    if (!activeRuntimeEnv || activeRuntimeEnv.type !== "local") {
      setStreamError("当前没有连接本地 Claude CLI，请先到设置 -> 运行环境完成连接。");
      return;
    }

    if ((activeRuntimeEnv.runtimeKind || "claude") !== "claude") {
      setStreamError("当前会话对话链路暂只支持 Claude CLI。请在运行环境中切换到 Claude CLI，Codex/Gemini 后续可继续接入。");
      return;
    }

    if (activeRuntimeEnv.health?.status !== "online") {
      setStreamError("当前本地 Claude 环境离线，请先重新检测连接状态。");
      return;
    }

    const now = new Date().toISOString();
    const userId = `msg-user-${Date.now()}`;
    const assistantId = `msg-kiki-${Date.now() + 1}`;
    const controller = new AbortController();
    streamAbortRef.current = controller;
    activeAssistantMessageIdRef.current = assistantId;
    appendMessage(conversation.id, {
      id: userId,
      kind: "text",
      role: "user",
      content: text,
      createdAt: now,
      source: "user",
      status: "done",
    });
    appendMessage(conversation.id, {
      id: assistantId,
      kind: "text",
      role: "kiki",
      content: "",
      createdAt: new Date().toISOString(),
      status: "streaming",
      source: "kiki",
    });
    setConversationRuntimeEnv(conversation.id, activeRuntimeEnv.id);
    setConversationStatus(conversation.id, "streaming");
    setStreamError(null);

    try {
      await streamClaudeChat(
        {
          message: text,
          conversationId: conversation.id,
          runtimeEnv: activeRuntimeEnv,
          claudeSessionId: conversation.claudeSessionId,
          source: "conversation",
          quotedMessage: quoted,
        },
        {
          onEvent: (event) => {
            if (event.type === "session") {
              setClaudeSessionId(conversation.id, event.sessionId);
              return;
            }
            if (event.type === "delta") {
              updateMessage(conversation.id, assistantId, (message) => ({
                ...message,
                content: `${message.content}${event.text}`,
              }));
              return;
            }
            if (event.type === "message") {
              updateMessage(conversation.id, assistantId, (message) => ({
                ...message,
                content: event.content,
                status: "done",
              }));
              return;
            }
            if (event.type === "permission_request") {
              setStreamError(event.reason);
              return;
            }
            if (event.type === "error") {
              setStreamError(event.message);
              updateMessage(conversation.id, assistantId, (message) => ({
                ...message,
                status: "error",
              }));
              setConversationStatus(conversation.id, "error");
              return;
            }
            if (event.type === "done") {
              updateMessage(conversation.id, assistantId, (message) => ({
                ...message,
                status: message.status === "streaming" ? "done" : message.status,
              }));
              setConversationStatus(conversation.id, "idle");
            }
          },
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (isAbortError(error)) {
        setConversationStatus(conversation.id, "idle");
        return;
      }
      setStreamError(error instanceof Error ? error.message : "Claude 对话失败");
      updateMessage(conversation.id, assistantId, (message) => ({
        ...message,
        status: "error",
      }));
      setConversationStatus(conversation.id, "error");
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
        activeAssistantMessageIdRef.current = null;
      }
    }
    setQuotedMessage(null);
  };

  const stopGeneration = () => {
    streamAbortRef.current?.abort();
    const assistantId = activeAssistantMessageIdRef.current;
    if (assistantId) {
      updateMessage(conversation.id, assistantId, (message) => ({
        ...message,
        status: "done",
        content: message.content.trim() ? `${message.content}\n\n（已中断）` : "已中断",
      }));
    }
    setConversationStatus(conversation.id, "idle");
    setStreamError(null);
    streamAbortRef.current = null;
    activeAssistantMessageIdRef.current = null;
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
              setActivePlanGoalId(conversation.goalId ?? null);
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
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
            {streamError ? (
              <div className="rounded-2xl border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-[12px] leading-5 text-[#B42318]">
                <div>{streamError}</div>
                <button
                  type="button"
                  onClick={() => openSettings("runtime")}
                  className="mt-2 font-medium underline"
                >
                  前往运行环境
                </button>
              </div>
            ) : null}
            {sortedMessages.length === 0 ? (
              <div className="mt-20 max-w-md self-center text-center text-[13px] text-[#8C9198]">
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
                    onOpenGoalPlan={(goalId) => {
                      setResultMessage(null);
                      setTaskInfoMessage(null);
                      setActivePlanGoalId(goalId);
                      setPlanFocus(null);
                      setPlanOpen(true);
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
            disabled={conversation.status === "streaming"}
            autoFocus={conversation.messages.length === 0}
            localMode
            onStop={conversation.status === "streaming" ? stopGeneration : undefined}
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
        goalId={activePlanGoalId ?? conversation.goalId}
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
            <div className="flex h-12 flex-none items-center gap-4 border-b border-[#E5E7EB] px-4">
              <GoalPlanBreadcrumb
                goalId={taskInfo.goal.id}
                goalTitle={taskInfo.goal.title}
                taskTitle={taskInfo.task.title.replace(/^任务\d+：/, "")}
                className="min-w-0 flex-1 justify-start text-left"
                disableLinks
                onGoalPlanClick={() => {
                  setTaskInfoMessage(null);
                  setActivePlanGoalId(taskInfo.goal.id);
                  setPlanFocus(
                    taskInfoMessage?.kind === "task_card"
                      ? taskInfoMessage.taskRef.subGoalId
                      : null,
                  );
                  setPlanOpen(true);
                }}
                onGoalClick={() => {
                  setTaskInfoMessage(null);
                  setActivePlanGoalId(taskInfo.goal.id);
                  setPlanFocus(null);
                  setPlanOpen(true);
                }}
              />
              <div className="ml-auto flex shrink-0 items-center gap-2">
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
