"use client";

import { ChevronsRight, LayoutList, Maximize2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AssistantComposer } from "@/components/layout/AssistantComposer";
import { ConversationMessageItem } from "@/components/conversation/ConversationMessageItem";
import { GoalPlanDrawer } from "@/components/conversation/GoalPlanDrawer";
import { TopicPlanBreadcrumb } from "@/components/topic/TopicPlanContent";
import { TaskDetailBody } from "@/components/topic/TaskDetailBody";
import { TaskResultDrawer } from "@/components/task/TaskResultDrawer";
import { streamClaudeChat } from "@/lib/api/claude";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { generateTopicSagaPlan } from "@/lib/api/topics";
import { submitTaskResultFeedback, waitForTaskRunCompletion } from "@/lib/api/taskRuns";
import { buildTaskQuoteContent } from "@/lib/taskFeedback";
import {
  commitGoalDraftToStores,
  continueGoalWorkflowAfterInfo,
  hasRecoverableGoalPlanCheckpoint,
  resumeGoalWorkflowFromCheckpoint,
  resumeGoalWorkflowFromRecovery,
  startGoalInfoCollection,
} from "@/lib/goalWorkflow";
import { appendGoalProgressMessage } from "@/lib/goalProgressLog";
import { openSettings } from "@/lib/settings";
import { parseSlashCommand } from "@/lib/slashCommands";
import { taskDetailPath } from "@/lib/routes";
import { useConversationStore } from "@/stores/conversationStore";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { ConversationMessage, Goal } from "@/types/kiki";
import type { QuotedConversationMessageContext } from "@/types/runtime";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function classifyConversationError(message: string | null) {
  if (!message) return null;
  if (/运行环境|Claude CLI|离线|连接|permission|权限/i.test(message)) {
    return {
      kind: "runtime" as const,
      title: message,
      actionLabel: "前往运行环境",
    };
  }
  if (/JSON|解析|review|格式|schema|结构|字段/i.test(message)) {
    return {
      kind: "recoverable" as const,
      title: message,
      actionLabel: "可在当前会话中发送“继续/重试/修复”来恢复",
    };
  }
  if (/fetch|network|Failed to fetch|断网|网络/i.test(message)) {
    return {
      kind: "recoverable" as const,
      title: message,
      actionLabel: "网络中断，可在当前会话中发送“继续/重试”恢复",
    };
  }
  return {
    kind: "recoverable" as const,
    title: message,
    actionLabel: "可在当前会话中继续处理",
  };
}

function shouldResumePlanningFromMessage(message: string) {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return /继续|接着|恢复|重试|再试|修复|补齐|完成|重新生成|重新解析|继续做|接着做|继续完成|resume|continue|retry|fix|repair|regenerate/.test(
    text,
  );
}

function buildAutoConversationTitle(message: string) {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 24) || "新会话";
}

function buildRecentConversationContext(messages: ConversationMessage[]) {
  const recent = messages.slice(-8);
  if (!recent.length) return undefined;
  return recent
    .map((message) => `${message.role === "user" ? "用户" : "KiKi"}：${message.content}`)
    .join("\n");
}

function goalPlanMessageContent() {
  return `目标规划草案已生成。点击下方卡片或右上角「目标规划」查看详情并确认启动。`;
}

function planningFailureMessage(error: unknown) {
  const message = getErrorMessage(error, "目标规划生成失败");
  if (/JSON|解析|review|格式|schema|结构|字段/i.test(message)) {
    return `${message}\n\n已保留本次目标、补充信息和执行上下文。你可以回复“继续修复”“重试生成”或补充新的要求，KiKi 会从上次失败点继续处理。`;
  }
  if (/fetch|network|Failed to fetch|断网|网络/i.test(message)) {
    return `${message}\n\n网络或请求中断，已保留当前上下文。网络恢复后，你可以回复“继续”或“重试”来接着完成。`;
  }
  return `${message}\n\n已保留当前上下文。你可以回复“继续”“重试”或补充新的要求，KiKi 会判断是否从上次失败点恢复。`;
}

function appendPlanningFailureMessage(current: string, error: unknown) {
  const failure = planningFailureMessage(error).trim();
  const existing = current.trim();
  if (!existing) return failure;
  if (existing.includes(failure)) return current;
  return `${current.trimEnd()}\n\n${failure}`;
}

function isScrollNearBottom(container: HTMLElement, threshold = 48) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

function isElementFullyVisibleInContainer(element: HTMLElement, container: HTMLElement) {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom;
}

function appendTerminalNotice(content: string, notice: string, emptyContent: string) {
  const trimmed = content.trim();
  if (!trimmed) return emptyContent;
  if (trimmed.includes(notice) || trimmed.includes(emptyContent)) return content;
  return `${content}\n\n${notice}`;
}

function resolveTaskCardInfo(message: ConversationMessage | null, goals: Goal[]) {
  if (!message || message.kind !== "task_card") return null;
  const goal = goals.find((item) => item.id === message.taskRef.goalId) ?? null;
  const subGoal = goal?.subGoals.find((item) => item.id === message.taskRef.subGoalId) ?? null;
  const storeTask = subGoal?.tasks.find((item) => item.id === message.taskRef.taskId) ?? null;
  const task = storeTask ?? message.taskSnapshot?.task ?? null;
  const instance =
    storeTask?.instances.find((item) => item.id === message.taskRef.instanceId) ??
    message.taskSnapshot?.instance ??
    null;
  if (!goal || !task || !instance) return null;
  return { goal, subGoal, task, instance, message };
}

function buildQuotedMessageContext(message: ConversationMessage, goals: Goal[]): QuotedConversationMessageContext {
  if (message.kind === "task_card") {
    const taskInfo = resolveTaskCardInfo(message, goals);
    return {
      roleLabel: "KiKi",
      content: taskInfo ? buildTaskQuoteContent(taskInfo.task, taskInfo.instance) : message.content,
      messageId: message.id,
      messageKind: message.kind,
      taskRef: message.taskRef,
    };
  }
  return {
    roleLabel: message.role === "user" ? "你" : "KiKi",
    content: message.content,
    messageId: message.id,
    messageKind: message.kind,
  };
}

/**
 * 会话视图：
 * - 顶部栏：会话标题 + 右上角「目标规划」按钮（仅绑定目标时显示）
 * - 中间：消息流（KiKi + 用户 + 任务卡片）
 * - 底部：输入框
 */
export function ConversationView({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const conversations = useConversationStore((state) => state.conversations);
  const appendMessage = useConversationStore((state) => state.appendMessage);
  const updateMessage = useConversationStore((state) => state.updateMessage);
  const markConversationRead = useConversationStore((state) => state.markConversationRead);
  const deleteMessage = useConversationStore((state) => state.deleteMessage);
  const setConversationRuntimeEnv = useConversationStore((state) => state.setConversationRuntimeEnv);
  const setClaudeSessionId = useConversationStore((state) => state.setClaudeSessionId);
  const setConversationStatus = useConversationStore((state) => state.setConversationStatus);
  const setGoalInfoCollection = useConversationStore((state) => state.setGoalInfoCollection);
  const renameConversation = useConversationStore((state) => state.renameConversation);
  const goals = useGoalStore(selectVisibleGoals);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const activeRuntimeEnv = useRuntimeEnvStore((state) => state.getActiveEnvironment());
  const conversation = conversations.find((c) => c.id === conversationId);
  const contextGoal = useMemo(
    () => (conversation?.goalId ? goals.find((item) => item.id === conversation.goalId) ?? null : null),
    [conversation?.goalId, goals],
  );
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
  const [hasLocalActiveStream, setHasLocalActiveStream] = useState(false);
  const resultMessageIdFromQuery = searchParams.get("resultMessageId");
  const refreshGoalsFromSnapshot = async () => {
    const snapshot = await fetchRuntimeStateSnapshot();
    applyGoalsProjection(snapshot.goals, snapshot.meta?.revisions?.goals);
  };

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

  useEffect(() => {
    if (!conversation || !resultMessageIdFromQuery) return;
    const message = conversation.messages.find((item) => item.id === resultMessageIdFromQuery);
    if (message?.kind !== "task_card") return;
    setResultMessage(message);
    router.replace(`/conversations/${conversation.id}`, { scroll: false });
  }, [conversation, resultMessageIdFromQuery, router]);

  useEffect(() => {
    if (!conversation || conversation.status !== "streaming") return;
    const activeAssistantId = activeAssistantMessageIdRef.current;
    const hasActiveController =
      Boolean(streamAbortRef.current) &&
      Boolean(
        activeAssistantId &&
          conversation.messages.some(
            (message) => message.id === activeAssistantId && message.status === "streaming",
          ),
      );
    if (hasActiveController) return;

    const streamingMessages = conversation.messages.filter((message) => message.status === "streaming");
    streamingMessages.forEach((message) => {
      updateMessage(conversation.id, message.id, (current) => ({
        ...current,
        status: "done",
      }));
    });
    setConversationStatus(conversation.id, "idle");
    setStreamError(null);
    streamAbortRef.current = null;
    activeAssistantMessageIdRef.current = null;
    setHasLocalActiveStream(false);
  }, [conversation, setConversationStatus, updateMessage]);

  const firstUnreadId = entryUnreadIds[0] ?? null;
  const unreadCount = entryUnreadIds.length;

  const markUnreadSeen = () => {
    setShowUnreadJump(false);
    setEntryUnreadIds([]);
  };

  const refreshUnreadJumpVisibility = () => {
    if (entryUnreadIds.length === 0) {
      setShowUnreadJump(false);
      return;
    }

    const container = scrollRef.current;
    if (!container || isScrollNearBottom(container)) {
      markUnreadSeen();
      return;
    }

    const unreadMessageElements = entryUnreadIds
      .map((id) => document.getElementById(`conversation-message-${id}`))
      .filter((element): element is HTMLElement => Boolean(element));
    if (
      unreadMessageElements.length === entryUnreadIds.length &&
      unreadMessageElements.every((element) => isElementFullyVisibleInContainer(element, container))
    ) {
      markUnreadSeen();
      return;
    }

    const marker = firstUnreadMarkerRef.current;
    if (marker && isElementFullyVisibleInContainer(marker, container)) {
      markUnreadSeen();
      return;
    }

    setShowUnreadJump(true);
  };

  useEffect(() => {
    if (!firstUnreadId) {
      setShowUnreadJump(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      refreshUnreadJumpVisibility();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entryUnreadIds, firstUnreadId, sortedMessages.length]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || unreadCount === 0) return;

    let frame: number | null = null;
    const handleScroll = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        refreshUnreadJumpVisibility();
        frame = null;
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [entryUnreadIds, unreadCount]);

  if (!conversation) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-white">
        <header className="flex h-11 flex-none items-center border-b border-[#E5E7EB] px-2">
          <div className="text-[15px] font-semibold text-[#1F2328]">会话不存在</div>
        </header>
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="max-w-sm text-center">
            <div className="text-[15px] font-medium text-[#1F2328]">会话不存在或已被删除</div>
            <div className="mt-2 text-[13px] leading-5 text-[#6B7280]">
              当前链接指向的会话不在本地状态中，可能已经被清理或尚未成功保存。
            </div>
            <Link
              href="/conversations"
              className="mt-4 inline-flex rounded-lg border border-[#D0D7DE] px-3 py-2 text-[13px] text-[#1F2328] hover:border-[#111]"
            >
              返回会话列表
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const taskInfo = resolveTaskCardInfo(taskInfoMessage, goals);
  const resultInfo = resolveTaskCardInfo(resultMessage, goals);
  const streamErrorUi = classifyConversationError(streamError);
  const appendActiveGoalProgress = (
    controller: AbortController,
    assistantId: string,
    progress: { message: string },
  ) => {
    if (
      controller.signal.aborted ||
      streamAbortRef.current !== controller ||
      activeAssistantMessageIdRef.current !== assistantId
    ) {
      return;
    }
    updateMessage(conversation.id, assistantId, (message) => {
      if (message.status !== "streaming" || controller.signal.aborted) return message;
      return {
        ...message,
        content: appendGoalProgressMessage(message.content, progress.message),
      };
    });
  };

  const onTaskOptionalFeedback = async (sourceMessage: ConversationMessage, text: string) => {
    if (sourceMessage.kind !== "task_card") return;
    const now = new Date().toISOString();
    const userId = `msg-user-feedback-${Date.now()}`;
    appendMessage(conversation.id, {
      id: userId,
      kind: "text",
      role: "user",
      content: text,
      createdAt: now,
      source: "user",
      status: "done",
    });
    setConversationStatus(conversation.id, "streaming");
    setStreamError(null);

    try {
      const feedback = await submitTaskResultFeedback({
        conversationId: conversation.id,
        message: text,
        sourceMessageId: userId,
        feedbackId: `feedback-${userId}`,
        taskRef: sourceMessage.taskRef,
        runtimeEnv: activeRuntimeEnv ?? undefined,
      });
      if (feedback.assistantMessage) {
        appendMessage(conversation.id, {
          id: `msg-kiki-feedback-${Date.now()}`,
          kind: "text",
          role: "kiki",
          content: feedback.assistantMessage,
          createdAt: new Date().toISOString(),
          status: "done",
          source: "kiki",
        });
      }
      if (feedback.progress && feedback.taskInstanceId) {
        void refreshGoalsFromSnapshot();
      }
      if (feedback.decision === "rerun" && feedback.taskCardMessage?.taskRef) {
        // 使用 `local-` 命名空间隔离本地乐观 push 的 task_card，避免与
        // 服务端 worker 派发的 `msg-task-${instanceId}-nN` 冲突而被前端误认作同一条消息。
        const taskCardId = `local-task-feedback-${feedback.taskCardMessage.taskRef.instanceId}`;
        if (!conversation.messages.some((message) => message.id === taskCardId)) {
          appendMessage(conversation.id, {
            id: taskCardId,
            kind: "task_card",
            role: "kiki",
            content: feedback.taskCardMessage.content || "已根据你的反馈重新执行任务。",
            createdAt: new Date().toISOString(),
            unread: true,
            status: "done",
            source: "system",
            taskRef: feedback.taskCardMessage.taskRef,
            taskSnapshot: feedback.taskCardMessage.taskSnapshot,
          });
        }
        if (feedback.progress?.requestId && feedback.taskInstanceId) {
          void waitForTaskRunCompletion({
            requestId: feedback.progress.requestId,
            taskInstanceId: feedback.taskInstanceId,
            onProgress: (payload) => {
              void payload;
              void refreshGoalsFromSnapshot();
            },
          }).then(() => {
            void refreshGoalsFromSnapshot();
          }).catch((error) => {
            setStreamError(error instanceof Error ? error.message : "反馈修订任务跟进失败");
          });
        }
      }
      setConversationStatus(conversation.id, "idle");
    } catch (error) {
      const message = getErrorMessage(error, "任务反馈处理失败");
      setStreamError(message);
      appendMessage(conversation.id, {
        id: `msg-kiki-feedback-error-${Date.now()}`,
        kind: "text",
        role: "kiki",
        content: message,
        createdAt: new Date().toISOString(),
        status: "error",
        source: "kiki",
      });
      setConversationStatus(conversation.id, "error");
    }
  };

  const onSend = async (
    text: string,
    quoted?: QuotedConversationMessageContext | null,
  ) => {
    const parsedCommand = parseSlashCommand(text);
    const canResumePlanning = parsedCommand.kind === "plain" && shouldResumePlanningFromMessage(text);
    const hasLocalPlanningFailure = conversation.planningRunState?.status === "failed";
    const hasCheckpointPlanningFailure =
      canResumePlanning && !hasLocalPlanningFailure
        ? await hasRecoverableGoalPlanCheckpoint(conversation.id)
        : false;
    if (
      canResumePlanning &&
      (hasLocalPlanningFailure || hasCheckpointPlanningFailure)
    ) {
      const now = new Date().toISOString();
      const userId = `msg-user-${Date.now()}`;
      const assistantId = `msg-kiki-${Date.now() + 1}`;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      activeAssistantMessageIdRef.current = assistantId;
      setHasLocalActiveStream(true);
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
        content: hasLocalPlanningFailure
          ? "正在从上次失败点恢复目标规划..."
          : "正在从已保存断点继续目标规划...",
        createdAt: now,
        status: "streaming",
        source: "kiki",
      });
      setConversationStatus(conversation.id, "streaming");
      setStreamError(null);

      try {
        const progressHandler = (progress: { message: string }) => {
          appendActiveGoalProgress(controller, assistantId, progress);
        };
        const result = hasLocalPlanningFailure
          ? await resumeGoalWorkflowFromRecovery({
              conversationId: conversation.id,
              userMessage: text,
              signal: controller.signal,
              onProgress: progressHandler,
            })
          : await resumeGoalWorkflowFromCheckpoint({
              conversationId: conversation.id,
              signal: controller.signal,
              onProgress: progressHandler,
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
          content: goalPlanMessageContent(),
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
          if (streamAbortRef.current === controller) {
            streamAbortRef.current = null;
            activeAssistantMessageIdRef.current = null;
            setHasLocalActiveStream(false);
          }
          return;
        }
        updateMessage(conversation.id, assistantId, (message) => ({
          ...message,
          content: appendPlanningFailureMessage(message.content, error),
          status: "error",
        }));
        setConversationStatus(conversation.id, "error");
        setStreamError(getErrorMessage(error, "目标规划生成失败"));
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
          activeAssistantMessageIdRef.current = null;
          setHasLocalActiveStream(false);
        }
      }
      setQuotedMessage(null);
      return;
    }

    if (
      conversation.goalInfoCollection &&
      conversation.goalInfoCollection.status === "awaiting_user" &&
      parsedCommand.kind === "plain"
    ) {
      const now = new Date().toISOString();
      const userId = `msg-user-${Date.now()}`;
      const assistantId = `msg-kiki-${Date.now() + 1}`;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      activeAssistantMessageIdRef.current = assistantId;
      setHasLocalActiveStream(true);
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
            appendActiveGoalProgress(controller, assistantId, progress);
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
          content: goalPlanMessageContent(),
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
          content: appendPlanningFailureMessage(message.content, error),
          status: "error",
        }));
        setConversationStatus(conversation.id, "error");
        setStreamError(getErrorMessage(error, "目标规划生成失败"));
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
          activeAssistantMessageIdRef.current = null;
          setHasLocalActiveStream(false);
        }
      }
      setQuotedMessage(null);
      return;
    }

    if (parsedCommand.kind === "unknown") {
      setStreamError(`暂不支持 ${parsedCommand.commandText} 命令。你可以使用 /goal 或 /saga 发起规划。`);
      return;
    }

    if (parsedCommand.kind === "command" && parsedCommand.command === "saga") {
      const now = new Date().toISOString();
      const userId = `msg-user-${Date.now()}`;
      const assistantId = `msg-kiki-${Date.now() + 1}`;
      const sagaRequestId = `topic-saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      activeAssistantMessageIdRef.current = assistantId;
      setHasLocalActiveStream(true);
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
        content: "正在启动 5 角色拆解 Saga（Interviewer / Planner / Critic / Refiner / Presenter）...",
        createdAt: now,
        status: "streaming",
        source: "kiki",
        sagaRequestId,
      });
      setConversationStatus(conversation.id, "streaming");
      setStreamError(null);

      try {
        const runtimeEnv = activeRuntimeEnv;
        if (!runtimeEnv || runtimeEnv.type !== "local") {
          throw new Error("当前没有可用的本地 Claude 环境，请先到设置 -> 运行环境完成连接。");
        }
        const result = await generateTopicSagaPlan({
          topicText: parsedCommand.payload,
          runtimeEnv,
          conversationId: conversation.id,
          conversationContext: buildRecentConversationContext(conversation.messages),
          requestId: sagaRequestId,
          signal: controller.signal,
        });
        if (result.kind === "awaiting_user") {
          const questionText = result.questions
            .map((question, index) => `${index + 1}. ${question}`)
            .join("\n");
          updateMessage(conversation.id, assistantId, (message) => ({
            ...message,
            content: questionText
              ? `5 角色 Saga 仍需要补充信息：\n\n${questionText}\n\n当前 /saga 先走单轮模式，你可以把补充信息合并到下一条新的 /saga ... 指令里重新发起。`
              : "5 角色 Saga 需要更多信息才能继续，请补充后重新使用 /saga 发起。",
            status: "done",
          }));
          setConversationStatus(conversation.id, "idle");
          return;
        }
        const committed = await commitGoalDraftToStores({
          conversationId: conversation.id,
          draft: result.draft,
        });
        updateMessage(conversation.id, assistantId, (message) => ({
          id: message.id,
          kind: "goal_plan_card",
          role: "kiki",
          content: goalPlanMessageContent(),
          createdAt: message.createdAt,
          unread: message.unread,
          status: "done",
          source: "kiki",
          goalRef: {
            goalId: committed.goalId,
            title: committed.goalTitle,
            summary: committed.summary,
            subGoalCount: committed.subGoalCount,
            taskCount: committed.taskCount,
          },
        }));
        setConversationStatus(conversation.id, "idle");
        setActivePlanGoalId(committed.goalId);
      } catch (error) {
        if (isAbortError(error)) {
          setConversationStatus(conversation.id, "idle");
          return;
        }
        updateMessage(conversation.id, assistantId, (message) => ({
          ...message,
          content: appendPlanningFailureMessage(message.content, error),
          status: "error",
        }));
        setConversationStatus(conversation.id, "error");
        setStreamError(getErrorMessage(error, "5 角色 Saga 规划失败"));
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
          activeAssistantMessageIdRef.current = null;
          setHasLocalActiveStream(false);
        }
      }
      setQuotedMessage(null);
      return;
    }

    if (parsedCommand.kind === "command" && parsedCommand.command === "goal") {
      const now = new Date().toISOString();
      const userId = `msg-user-${Date.now()}`;
      const assistantId = `msg-kiki-${Date.now() + 1}`;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      activeAssistantMessageIdRef.current = assistantId;
      setHasLocalActiveStream(true);
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
            appendActiveGoalProgress(controller, assistantId, progress);
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
          content: appendPlanningFailureMessage(message.content, error),
          status: "error",
        }));
        setConversationStatus(conversation.id, "error");
        setStreamError(getErrorMessage(error, "目标规划生成失败"));
      }
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
        activeAssistantMessageIdRef.current = null;
        setHasLocalActiveStream(false);
      }
      setQuotedMessage(null);
      return;
    }

    const quotedTaskInfo =
      quoted?.taskRef && quoted.messageKind === "task_card"
        ? resolveTaskCardInfo(quotedMessage, goals)
        : null;
    if (quotedTaskInfo) {
      const now = new Date().toISOString();
      const userId = `msg-user-${Date.now()}`;
      const assistantId = `msg-kiki-${Date.now() + 1}`;
      const userMessage: ConversationMessage = {
        id: userId,
        kind: "text",
        role: "user",
        content: text,
        createdAt: now,
        source: "user",
        status: "done",
      };
      appendMessage(conversation.id, userMessage);
      appendMessage(conversation.id, {
        id: assistantId,
        kind: "text",
        role: "kiki",
        content:
          quotedTaskInfo.instance.status === "completed" || quotedTaskInfo.instance.result?.taskResult
            ? "正在理解你对任务结果的反馈..."
            : "这条任务还没有完成，我先检查当前状态...",
        createdAt: now,
        status: "streaming",
        source: "kiki",
      });
      setConversationStatus(conversation.id, "streaming");
      setStreamError(null);
      try {
        if (quotedTaskInfo.instance.status === "awaiting_user" || quotedTaskInfo.instance.awaitingUser) {
          updateMessage(conversation.id, assistantId, (message) => ({
            ...message,
            content: "这个任务正在等待你补充或确认信息。请先在任务卡片里完成当前等待项，再引用最终结果反馈。",
            status: "done",
          }));
          setConversationStatus(conversation.id, "idle");
          setQuotedMessage(null);
          return;
        }
        if (quotedTaskInfo.instance.status === "in_progress") {
          updateMessage(conversation.id, assistantId, (message) => ({
            ...message,
            content: "这个任务还在执行中。我已看到你的反馈，但建议等当前结果完成后再引用结果让我判断是否需要重做。",
            status: "done",
          }));
          setConversationStatus(conversation.id, "idle");
          setQuotedMessage(null);
          return;
        }
        if (quotedTaskInfo.instance.status === "error" || quotedTaskInfo.instance.status === "paused") {
          updateMessage(conversation.id, assistantId, (message) => ({
            ...message,
            content: "这个任务当前没有可反馈的完成结果。你可以先重试或恢复任务，等产出完成后再引用结果反馈。",
            status: "done",
          }));
          setConversationStatus(conversation.id, "idle");
          setQuotedMessage(null);
          return;
        }
        const feedbackTaskRef = quotedTaskInfo.message.taskRef;
        const feedback = await submitTaskResultFeedback({
          conversationId: conversation.id,
          message: text,
          sourceMessageId: userId,
          feedbackId: `feedback-${userId}`,
          taskRef: feedbackTaskRef,
          runtimeEnv: activeRuntimeEnv ?? undefined,
        });
        updateMessage(conversation.id, assistantId, (message) => ({
          ...message,
          content: feedback.assistantMessage,
          status: "done",
        }));
        if (feedback.progress && feedback.taskInstanceId) {
          void refreshGoalsFromSnapshot();
        }
        if (feedback.decision === "rerun" && feedback.taskCardMessage?.taskRef) {
          // 同上：本地乐观 push 的 task_card 使用独立 id 命名空间。
          const taskCardId = `local-task-feedback-${feedback.taskCardMessage.taskRef.instanceId}`;
          if (!conversation.messages.some((message) => message.id === taskCardId)) {
            appendMessage(conversation.id, {
              id: taskCardId,
              kind: "task_card",
              role: "kiki",
              content: feedback.taskCardMessage.content || "已根据你的反馈重新执行任务。",
              createdAt: new Date().toISOString(),
              unread: true,
              status: "done",
              source: "system",
              taskRef: feedback.taskCardMessage.taskRef,
              taskSnapshot: feedback.taskCardMessage.taskSnapshot,
            });
          }
          if (feedback.progress?.requestId && feedback.taskInstanceId) {
            void waitForTaskRunCompletion({
              requestId: feedback.progress.requestId,
              taskInstanceId: feedback.taskInstanceId,
              onProgress: (payload) => {
                void payload;
                void refreshGoalsFromSnapshot();
              },
            }).then(() => {
              void refreshGoalsFromSnapshot();
            }).catch((error) => {
              setStreamError(error instanceof Error ? error.message : "反馈修订任务跟进失败");
            });
          }
        }
        setConversationStatus(conversation.id, "idle");
      } catch (error) {
        const message = getErrorMessage(error, "任务反馈处理失败");
        setStreamError(message);
        updateMessage(conversation.id, assistantId, (current) => ({
          ...current,
          content: message,
          status: "error",
        }));
        setConversationStatus(conversation.id, "error");
      } finally {
        setQuotedMessage(null);
      }
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
    const userMessage: ConversationMessage = {
      id: userId,
      kind: "text",
      role: "user",
      content: text,
      createdAt: now,
      source: "user",
      status: "done",
    };
    streamAbortRef.current = controller;
    activeAssistantMessageIdRef.current = assistantId;
    setHasLocalActiveStream(true);
    if (!conversation.goalId && conversation.title === "新会话" && conversation.messages.length === 0) {
      renameConversation(conversation.id, buildAutoConversationTitle(text));
    }
    appendMessage(conversation.id, userMessage);
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
          contextSnapshot: {
            conversation: {
              ...conversation,
              messages: [...conversation.messages, userMessage],
            },
            goal: contextGoal,
          },
          quotedMessage: quoted,
        },
        {
          onEvent: (event) => {
            if (event.type === "session") {
              setClaudeSessionId(conversation.id, event.sessionId);
              return;
            }
            if (event.type === "session_invalid") {
              setClaudeSessionId(conversation.id, undefined);
              const hint = "上一轮 Claude 会话已失效，已自动重置。请重新发送消息。";
              setStreamError(hint);
              updateMessage(conversation.id, assistantId, (message) => ({
                ...message,
                content: message.content || `（${hint}）`,
                status: "error",
              }));
              setConversationStatus(conversation.id, "error");
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
                content: message.content || `（任务失败：${event.message}）`,
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
        setHasLocalActiveStream(false);
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
        content: appendTerminalNotice(message.content, "（已中断）", "已中断"),
      }));
    }
    setConversationStatus(conversation.id, "idle");
    setStreamError(null);
    streamAbortRef.current = null;
    activeAssistantMessageIdRef.current = null;
    setHasLocalActiveStream(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* 顶部栏 */}
      <header className="flex h-12 flex-none items-center justify-between border-b border-[#E5E7EB] px-4 sm:px-6 lg:px-8">
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
          className="h-full overflow-y-auto overscroll-contain"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-5 pt-3 sm:px-6 lg:px-8">
            {streamErrorUi?.kind === "runtime" ? (
              <div className="rounded-2xl border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-[12px] leading-5 text-[#B42318]">
                <div>{streamErrorUi.title}</div>
                <button
                  type="button"
                  onClick={() => openSettings("runtime")}
                  className="mt-2 font-medium underline"
                >
                  {streamErrorUi.actionLabel}
                </button>
              </div>
            ) : null}
            {sortedMessages.length === 0 ? (
              <div className="mt-20 max-w-md self-center text-center text-[13px] text-[#8C9198]">
                和 KiKi 聊聊你的目标或想法，输入 <span className="font-mono text-[#1F2328]">/goal</span>{" "}
                可以进入目标规划模式。
              </div>
            ) : (
              <>
                {sortedMessages.map((msg) => (
                  <div key={msg.id} id={`conversation-message-${msg.id}`}>
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
                      onTaskOptionalFeedback={onTaskOptionalFeedback}
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
              </>
            )}
          </div>
        </div>

        {showUnreadJump && unreadCount > 0 ? (
          <div className="pointer-events-none absolute bottom-4 left-0 right-0 px-4 sm:px-6 lg:px-8">
            <div className="mx-auto flex w-full max-w-3xl justify-end">
              <button
                type="button"
                onClick={() => {
                  firstUnreadMarkerRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                  markUnreadSeen();
                }}
                className="pointer-events-auto rounded-full border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] text-[#1F2328] shadow-sm hover:border-[#111]"
              >
                {unreadCount}条新消息
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* 底部输入 */}
      <div className="flex-none bg-white px-4 pb-3 pt-3 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <AssistantComposer
            onSubmit={onSend}
            disabled={hasLocalActiveStream}
            autoFocus={conversation.messages.length === 0}
            localMode
            onStop={hasLocalActiveStream ? stopGeneration : undefined}
            quotedMessage={
              quotedMessage
                ? buildQuotedMessageContext(quotedMessage, goals)
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
              <TopicPlanBreadcrumb
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
                  href={taskDetailPath(taskInfo.goal.id, taskInfo.task.id)}
                  aria-label="全屏查看任务信息"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
                >
                  <Maximize2 className="h-4 w-4" />
                </Link>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5">
              <div className="mx-auto w-full max-w-3xl">
                <TaskDetailBody goal={taskInfo.goal} task={taskInfo.task} onDeleted={() => setTaskInfoMessage(null)} />
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
