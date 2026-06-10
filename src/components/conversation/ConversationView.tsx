"use client";

import { AlertTriangle, ChevronsRight, Ellipsis, LayoutList, LoaderCircle, Maximize2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AssistantComposer } from "@/components/layout/AssistantComposer";
import { ConversationMessageItem } from "@/components/conversation/ConversationMessageItem";
import { GoalPlanDrawer } from "@/components/conversation/GoalPlanDrawer";
import { TopicPlanBreadcrumb } from "@/components/topic/TopicPlanContent";
import { TaskDetailBody } from "@/components/topic/TaskDetailBody";
import { TaskResultDrawer } from "@/components/task/TaskResultDrawer";
import { MemoryEditor } from "@/components/memory/MemoryEditor";
import { streamClaudeChat } from "@/lib/api/claude";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { activateEnvironmentCommand } from "@/lib/api/runtime-environment-commands";
import { generateTopicSagaPlan } from "@/lib/api/topics";
import {
  applyConversationGovernance,
  judgeConversationGovernance,
  submitTaskResultFeedback,
  waitForTaskRunCompletion,
} from "@/lib/api/taskRuns";
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
import { SUPPORTED_RUNTIME_KINDS } from "@/types/runtime";
import type {
  CliProcessEvent,
  ConversationCliProcess,
  QuotedConversationMessageContext,
} from "@/types/runtime";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function createCliProcess(runId: string, startedAt: string): ConversationCliProcess {
  return {
    runId,
    status: "running",
    startedAt,
    promptSections: [],
    events: [],
    output: "",
  };
}

function createCliProcessEvent(
  runId: string,
  type: CliProcessEvent["type"],
  input: Omit<CliProcessEvent, "id" | "type" | "createdAt"> = {},
): CliProcessEvent {
  return {
    id: `${runId}-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    createdAt: new Date().toISOString(),
    ...input,
  };
}

function withCliProcess(
  message: ConversationMessage,
  updater: (process: ConversationCliProcess) => ConversationCliProcess,
) {
  if (message.kind !== "text" || !message.cliProcess) return message;
  return {
    ...message,
    cliProcess: updater(message.cliProcess),
  };
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

function createTurnTimestamps() {
  const base = Date.now();
  return {
    userCreatedAt: new Date(base).toISOString(),
    assistantCreatedAt: new Date(base + 1).toISOString(),
  };
}

function compareConversationMessagesForDisplay(a: ConversationMessage, b: ConversationMessage) {
  const byTime = +new Date(a.createdAt) - +new Date(b.createdAt);
  if (byTime !== 0) return byTime;
  if (a.role === b.role) return 0;
  return a.role === "user" ? -1 : 1;
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
    messageKind: message.kind === "goal_plan_card" ? "goal_plan_card" : "text",
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
  const conversationsHydrated = useConversationStore((state) => state.conversationsHydrated);
  const appendMessage = useConversationStore((state) => state.appendMessage);
  const updateMessage = useConversationStore((state) => state.updateMessage);
  const markConversationRead = useConversationStore((state) => state.markConversationRead);
  const deleteMessage = useConversationStore((state) => state.deleteMessage);
  const setConversationRuntimeEnv = useConversationStore((state) => state.setConversationRuntimeEnv);
  const setConversationStatus = useConversationStore((state) => state.setConversationStatus);
  const setGoalInfoCollection = useConversationStore((state) => state.setGoalInfoCollection);
  const renameConversation = useConversationStore((state) => state.renameConversation);
  const goals = useGoalStore(selectVisibleGoals);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const runtimeEnvironments = useRuntimeEnvStore((state) => state.environments);
  const activeRuntimeEnvId = useRuntimeEnvStore((state) => state.activeRuntimeEnvId);
  const setActiveRuntimeEnv = useRuntimeEnvStore((state) => state.setActiveEnvironment);
  const activeRuntimeEnv = useRuntimeEnvStore((state) => state.getActiveEnvironment());
  const conversation = conversations.find((c) => c.id === conversationId);
  const contextGoal = useMemo(
    () => (conversation?.goalId ? goals.find((item) => item.id === conversation.goalId) ?? null : null),
    [conversation?.goalId, goals],
  );
  const switchRuntimeEnvironment = async (runtimeEnvId: string) => {
    const target = runtimeEnvironments.find((runtime) => runtime.id === runtimeEnvId);
    if (!target || target.type !== "local") return;
    if (target.health?.status !== "online") {
      setStreamError("只能切换到已连接的 Runtime。请先在设置里重新检测连接状态。");
      return;
    }
    const previousRuntimeEnvId = activeRuntimeEnvId;
    setActiveRuntimeEnv(runtimeEnvId);
    try {
      await activateEnvironmentCommand({ id: runtimeEnvId });
      setStreamError(null);
    } catch (error) {
      if (previousRuntimeEnvId) {
        setActiveRuntimeEnv(previousRuntimeEnvId);
      }
      setStreamError(getErrorMessage(error, "切换 Runtime 失败，请稍后重试。"));
    }
  };
  const [planOpen, setPlanOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
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
  const applyingGovernanceRef = useRef<Set<string>>(new Set());
  const [entryUnreadIds, setEntryUnreadIds] = useState<string[]>([]);
  const [showUnreadJump, setShowUnreadJump] = useState(false);
  const [hasLocalActiveStream, setHasLocalActiveStream] = useState(false);
  const resultMessageIdFromQuery = searchParams?.get("resultMessageId") ?? null;
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
    return [...conversation.messages].sort(compareConversationMessagesForDisplay);
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

  const markUnreadSeen = useCallback(() => {
    setShowUnreadJump(false);
    setEntryUnreadIds([]);
  }, []);

  const refreshUnreadJumpVisibility = useCallback(() => {
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
  }, [entryUnreadIds, markUnreadSeen]);

  useEffect(() => {
    if (!firstUnreadId) {
      setShowUnreadJump(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      refreshUnreadJumpVisibility();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [firstUnreadId, refreshUnreadJumpVisibility, sortedMessages.length]);

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
  }, [refreshUnreadJumpVisibility, unreadCount]);

  if (!conversation && !conversationsHydrated) {
    return <ConversationInitializing />;
  }

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
  const backgroundIssue = conversation.backgroundIssue;
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

  const appendGovernanceConfirmation = (input: {
    assistantId: string;
    summary: string;
    proposal: NonNullable<Awaited<ReturnType<typeof judgeConversationGovernance>>["proposal"]>;
    userMessage: string;
    quotedMessage: QuotedConversationMessageContext | null;
  }) => {
    updateMessage(conversation.id, input.assistantId, () => ({
      id: input.assistantId,
      kind: "governance_confirmation",
      role: "kiki",
      content: input.summary,
      createdAt: new Date().toISOString(),
      unread: true,
      status: "done",
      source: "kiki",
      governance: {
        status: "pending",
        summary: input.summary,
        diffs: input.proposal.diffs,
        payload: input.proposal.payload ?? {
          intent: input.proposal.intent,
        },
        userMessage: input.userMessage,
        quotedMessage: input.quotedMessage
          ? {
              roleLabel: input.quotedMessage.roleLabel,
              content: input.quotedMessage.content,
              messageId: input.quotedMessage.messageId,
              messageKind: input.quotedMessage.messageKind,
              taskRef: input.quotedMessage.taskRef,
            }
          : undefined,
      },
    }));
  };

  const appendGovernanceTaskCard = (applied: Awaited<ReturnType<typeof applyConversationGovernance>>) => {
    if (!applied.taskCardMessage?.taskRef) return;
    const taskCardId = `local-task-governance-${applied.taskCardMessage.taskRef.instanceId}`;
    if (conversation.messages.some((message) => message.id === taskCardId)) return;
    appendMessage(conversation.id, {
      id: taskCardId,
      kind: "task_card",
      role: "kiki",
      content: applied.taskCardMessage.content || "已根据你的要求执行任务。",
      createdAt: new Date().toISOString(),
      unread: true,
      status: "done",
      source: "system",
      taskRef: applied.taskCardMessage.taskRef,
      taskSnapshot: applied.taskCardMessage.taskSnapshot,
    });
  };

  const onGovernanceConfirm = async (sourceMessage: ConversationMessage) => {
    if (sourceMessage.kind !== "governance_confirmation") return;
    if (sourceMessage.governance.status !== "pending" && sourceMessage.governance.status !== "error") return;
    if (applyingGovernanceRef.current.has(sourceMessage.id)) return;
    const payload = sourceMessage.governance.payload;
    if (!payload.intent || !payload.taskRef) {
      updateMessage(conversation.id, sourceMessage.id, (message) =>
        message.kind === "governance_confirmation"
          ? {
              ...message,
              governance: {
                ...message.governance,
                status: "error",
                error: "缺少可执行的治理命令或任务引用。",
              },
            }
          : message,
      );
      return;
    }
    updateMessage(conversation.id, sourceMessage.id, (message) =>
      message.kind === "governance_confirmation"
        ? {
            ...message,
            governance: {
              ...message.governance,
              status: "confirmed",
              error: undefined,
            },
          }
        : message,
    );
    try {
      applyingGovernanceRef.current.add(sourceMessage.id);
      const applied = await applyConversationGovernance({
        conversationId: conversation.id,
        intent: payload.intent,
        taskRef: payload.taskRef,
        patch: payload.patch,
        revisionHint: payload.revisionHint,
        userMessage: sourceMessage.governance.userMessage,
        runtimeEnv: activeRuntimeEnv ?? undefined,
        quotedMessage: sourceMessage.governance.quotedMessage,
        idempotencyKey: `governance:${sourceMessage.id}:${payload.intent}`,
      });
      updateMessage(conversation.id, sourceMessage.id, (message) =>
        message.kind === "governance_confirmation"
          ? {
              ...message,
              governance: {
                ...message.governance,
                status: "applied",
              },
            }
          : message,
      );
      appendMessage(conversation.id, {
        id: `msg-kiki-governance-${Date.now()}`,
        kind: "text",
        role: "kiki",
        content: applied.assistantMessage || "已执行任务治理操作。",
        createdAt: new Date().toISOString(),
        status: "done",
        source: "kiki",
      });
      void refreshGoalsFromSnapshot();
      appendGovernanceTaskCard(applied);
    } catch (error) {
      updateMessage(conversation.id, sourceMessage.id, (message) =>
        message.kind === "governance_confirmation"
          ? {
              ...message,
              governance: {
                ...message.governance,
                status: "error",
                error: getErrorMessage(error, "治理命令执行失败"),
              },
            }
          : message,
      );
    } finally {
      applyingGovernanceRef.current.delete(sourceMessage.id);
    }
  };

  const onGovernanceCancel = (sourceMessage: ConversationMessage) => {
    if (sourceMessage.kind !== "governance_confirmation") return;
    if (sourceMessage.governance.status !== "pending" && sourceMessage.governance.status !== "error") return;
    updateMessage(conversation.id, sourceMessage.id, (message) =>
      message.kind === "governance_confirmation"
        ? {
            ...message,
            governance: {
              ...message.governance,
              status: "cancelled",
            },
          }
        : message,
    );
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
      const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
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
        createdAt: userCreatedAt,
        source: "user",
        status: "done",
        quotedMessage: quoted ?? undefined,
      });
      appendMessage(conversation.id, {
        id: assistantId,
        kind: "text",
        role: "kiki",
        content: hasLocalPlanningFailure
          ? "正在从上次失败点恢复目标规划..."
          : "正在从已保存断点继续目标规划...",
        createdAt: assistantCreatedAt,
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
      const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
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
        createdAt: userCreatedAt,
        source: "user",
        status: "done",
        quotedMessage: quoted ?? undefined,
      });
      appendMessage(conversation.id, {
        id: assistantId,
        kind: "text",
        role: "kiki",
        content: "已收到背景信息，正在拆解子目标...",
        createdAt: assistantCreatedAt,
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
      const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
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
        createdAt: userCreatedAt,
        source: "user",
        status: "done",
        quotedMessage: quoted ?? undefined,
      });
      appendMessage(conversation.id, {
        id: assistantId,
        kind: "text",
        role: "kiki",
        content: "正在启动 5 角色拆解 Saga（Interviewer / Planner / Critic / Refiner / Presenter）...",
        createdAt: assistantCreatedAt,
        status: "streaming",
        source: "kiki",
        sagaRequestId,
      });
      setConversationStatus(conversation.id, "streaming");
      setStreamError(null);

      try {
        const runtimeEnv = activeRuntimeEnv;
        if (!runtimeEnv || runtimeEnv.type !== "local") {
          throw new Error("当前没有可用的本地 Runtime，请先到设置 -> 运行环境完成连接。");
        }
        if (!SUPPORTED_RUNTIME_KINDS.includes(runtimeEnv.runtimeKind || "claude")) {
          throw new Error("当前目标规划暂不支持这个 Runtime。请在运行环境中切换到 Claude CLI 或 Pi CLI。");
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
          sagaRequestId,
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
      const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
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
        createdAt: userCreatedAt,
        source: "user",
        status: "done",
        quotedMessage: quoted ?? undefined,
      });
      appendMessage(conversation.id, {
        id: assistantId,
        kind: "text",
        role: "kiki",
        content: "正在理解目标和关键约束...",
        createdAt: assistantCreatedAt,
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
      const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
      const userId = `msg-user-${Date.now()}`;
      const assistantId = `msg-kiki-${Date.now() + 1}`;
      const userMessage: ConversationMessage = {
        id: userId,
        kind: "text",
        role: "user",
        content: text,
        createdAt: userCreatedAt,
        source: "user",
        status: "done",
        quotedMessage: quoted ?? undefined,
      };
      appendMessage(conversation.id, userMessage);
      appendMessage(conversation.id, {
        id: assistantId,
        kind: "text",
        role: "kiki",
        content: "",
        createdAt: assistantCreatedAt,
        status: "streaming",
        source: "kiki",
      });
      setConversationStatus(conversation.id, "streaming");
      setStreamError(null);
      try {
        const feedbackTaskRef = quotedTaskInfo.message.taskRef;
        const governance =
          activeRuntimeEnv && activeRuntimeEnv.type === "local" && activeRuntimeEnv.health?.status === "online"
            ? await judgeConversationGovernance({
                message: text,
                conversationId: conversation.id,
                runtimeEnv: activeRuntimeEnv,
                source: "conversation",
                workspaceMode: "conversation",
                taskRef: feedbackTaskRef,
                contextSnapshot: {
                  conversation: {
                    ...conversation,
                    messages: [...conversation.messages, userMessage],
                  },
                  goal: contextGoal,
                },
                quotedMessage: quoted ?? undefined,
              })
            : null;
        if (governance?.shouldHandle && governance.proposal) {
          if (
            governance.proposal.intent === "rerun_current" &&
            quotedTaskInfo.instance.status !== "completed" &&
            !quotedTaskInfo.instance.result?.taskResult
          ) {
            updateMessage(conversation.id, assistantId, (message) => ({
              ...message,
              content: "这条任务还没有完成，建议等它完成后再引用结果让我判断是否需要重做。",
              status: "done",
            }));
            setConversationStatus(conversation.id, "idle");
            setQuotedMessage(null);
            return;
          }
          if (!governance.proposal.supported) {
            updateMessage(conversation.id, assistantId, (message) => ({
              ...message,
              content: governance.proposal?.summary || "我已识别这个操作，但当前版本暂未支持执行。",
              status: "done",
            }));
            setConversationStatus(conversation.id, "idle");
            setQuotedMessage(null);
            return;
          }
          if (governance.proposal.confirmLevel === "required") {
            appendGovernanceConfirmation({
              assistantId,
              summary: governance.proposal.summary,
              proposal: governance.proposal,
              userMessage: text,
              quotedMessage: quoted ?? null,
            });
            setConversationStatus(conversation.id, "idle");
            setQuotedMessage(null);
            return;
          }
          const payload = governance.proposal.payload;
          if (!payload?.intent || !payload.taskRef) {
            updateMessage(conversation.id, assistantId, (message) => ({
              ...message,
              content: "我识别到了任务操作意图，但缺少可执行的任务引用。",
              status: "done",
            }));
            setConversationStatus(conversation.id, "idle");
            setQuotedMessage(null);
            return;
          }
          const applied = await applyConversationGovernance({
            conversationId: conversation.id,
            intent: payload.intent,
            taskRef: payload.taskRef,
            patch: payload.patch,
            revisionHint: payload.revisionHint,
            userMessage: text,
            runtimeEnv: activeRuntimeEnv ?? undefined,
            quotedMessage: quoted ?? undefined,
            idempotencyKey: `governance:${userId}:${payload.intent}`,
          });
          updateMessage(conversation.id, assistantId, (message) => ({
            ...message,
            content: applied.assistantMessage || governance.proposal?.summary || "已执行任务治理操作。",
            status: "done",
          }));
          void refreshGoalsFromSnapshot();
          if (applied.taskCardMessage?.taskRef) {
            const taskCardId = `local-task-governance-${applied.taskCardMessage.taskRef.instanceId}`;
            if (!conversation.messages.some((message) => message.id === taskCardId)) {
              appendMessage(conversation.id, {
                id: taskCardId,
                kind: "task_card",
                role: "kiki",
                content: applied.taskCardMessage.content || "已根据你的要求重新执行任务。",
                createdAt: new Date().toISOString(),
                unread: true,
                status: "done",
                source: "system",
                taskRef: applied.taskCardMessage.taskRef,
                taskSnapshot: applied.taskCardMessage.taskSnapshot,
              });
            }
          }
          setConversationStatus(conversation.id, "idle");
          setQuotedMessage(null);
          return;
        }
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
        const feedback = await submitTaskResultFeedback({
          conversationId: conversation.id,
          message: text,
          sourceMessageId: userId,
          feedbackId: `feedback-${userId}`,
          taskRef: feedbackTaskRef,
          runtimeEnv: activeRuntimeEnv ?? undefined,
          quotedMessage: quoted ?? undefined,
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
      setStreamError("当前没有连接本地 Runtime，请先到设置 -> 运行环境完成连接。");
      return;
    }

    if (!SUPPORTED_RUNTIME_KINDS.includes(activeRuntimeEnv.runtimeKind || "claude")) {
      setStreamError("当前会话对话链路暂不支持这个 Runtime。请在运行环境中切换到 Claude CLI 或 Pi CLI。");
      return;
    }

    if (activeRuntimeEnv.health?.status !== "online") {
      setStreamError("当前本地 Runtime 离线，请先重新检测连接状态。");
      return;
    }

    const { userCreatedAt, assistantCreatedAt } = createTurnTimestamps();
    const userId = `msg-user-${Date.now()}`;
    const assistantId = `msg-kiki-${Date.now() + 1}`;
    const controller = new AbortController();
    const userMessage: ConversationMessage = {
      id: userId,
      kind: "text",
      role: "user",
      content: text,
      createdAt: userCreatedAt,
      source: "user",
      status: "done",
      quotedMessage: quoted ?? undefined,
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
      createdAt: assistantCreatedAt,
      status: "streaming",
      source: "kiki",
    });
    // resume session 由服务端按 runtimeKind 从持久化状态（runtimeSessions）解析，前端不再计算或下发，
    // 切换 runtime 时也无需手动清空——各 CLI 的 session 独立分键，互不串号。
    setConversationRuntimeEnv(conversation.id, activeRuntimeEnv.id);
    setConversationStatus(conversation.id, "streaming");
    setStreamError(null);

    try {
      const governance = await judgeConversationGovernance({
        message: text,
        conversationId: conversation.id,
        runtimeEnv: activeRuntimeEnv,
        source: "conversation",
        workspaceMode: "conversation",
        contextSnapshot: {
          conversation: {
            ...conversation,
            messages: [...conversation.messages, userMessage],
          },
          goal: contextGoal,
        },
        quotedMessage: quoted,
      });
      if (governance.shouldHandle && governance.proposal) {
        if (!governance.proposal.supported) {
          updateMessage(conversation.id, assistantId, (message) => ({
            ...message,
            content: governance.proposal?.summary || "我已识别这个操作，但当前版本暂未支持执行。",
            status: "done",
          }));
          setConversationStatus(conversation.id, "idle");
          streamAbortRef.current = null;
          activeAssistantMessageIdRef.current = null;
          setHasLocalActiveStream(false);
          setQuotedMessage(null);
          return;
        }
        if (governance.proposal.confirmLevel === "required") {
          appendGovernanceConfirmation({
            assistantId,
            summary: governance.proposal.summary,
            proposal: governance.proposal,
            userMessage: text,
            quotedMessage: quoted ?? null,
          });
          setConversationStatus(conversation.id, "idle");
          streamAbortRef.current = null;
          activeAssistantMessageIdRef.current = null;
          setHasLocalActiveStream(false);
          setQuotedMessage(null);
          return;
        }
        const payload = governance.proposal.payload;
        if (!payload?.intent || !payload.taskRef) {
          updateMessage(conversation.id, assistantId, (message) => ({
            ...message,
            content: "我识别到了任务操作意图，但还不能确定目标任务。请引用任务卡片，或明确任务名称。",
            status: "done",
          }));
          setConversationStatus(conversation.id, "idle");
          streamAbortRef.current = null;
          activeAssistantMessageIdRef.current = null;
          setHasLocalActiveStream(false);
          setQuotedMessage(null);
          return;
        }
        const applied = await applyConversationGovernance({
          conversationId: conversation.id,
          intent: payload.intent,
          taskRef: payload.taskRef,
          patch: payload.patch,
          revisionHint: payload.revisionHint,
          userMessage: text,
          runtimeEnv: activeRuntimeEnv,
          quotedMessage: quoted,
          idempotencyKey: `governance:${userId}:${payload.intent}`,
        });
        updateMessage(conversation.id, assistantId, (message) => ({
          ...message,
          content: applied.assistantMessage || governance.proposal?.summary || "已执行任务治理操作。",
          status: "done",
        }));
        void refreshGoalsFromSnapshot();
        if (applied.taskCardMessage?.taskRef) {
          const taskCardId = `local-task-governance-${applied.taskCardMessage.taskRef.instanceId}`;
          appendMessage(conversation.id, {
            id: taskCardId,
            kind: "task_card",
            role: "kiki",
            content: applied.taskCardMessage.content || "已根据你的要求重新执行任务。",
            createdAt: new Date().toISOString(),
            unread: true,
            status: "done",
            source: "system",
            taskRef: applied.taskCardMessage.taskRef,
            taskSnapshot: applied.taskCardMessage.taskSnapshot,
          });
        }
        setConversationStatus(conversation.id, "idle");
        streamAbortRef.current = null;
        activeAssistantMessageIdRef.current = null;
        setHasLocalActiveStream(false);
        setQuotedMessage(null);
        return;
      }
      updateMessage(conversation.id, assistantId, (message) => ({
        ...message,
        content: "",
        status: "streaming",
        ...(message.kind === "text" ? { cliProcess: createCliProcess(assistantId, assistantCreatedAt) } : {}),
      }));
      const updateAssistantCliProcess = (
        updater: (process: ConversationCliProcess) => ConversationCliProcess,
      ) => {
        updateMessage(conversation.id, assistantId, (message) => withCliProcess(message, updater));
      };
      const appendProcessEvent = (
        type: CliProcessEvent["type"],
        input: Omit<CliProcessEvent, "id" | "type" | "createdAt"> = {},
      ) => {
        const processEvent = createCliProcessEvent(assistantId, type, input);
        updateAssistantCliProcess((process) => ({
          ...process,
          events: [...process.events, processEvent],
        }));
      };
      const appendProcessTextEvent = (
        type: Extract<CliProcessEvent["type"], "thinking" | "assistant_trace">,
        title: string,
        text: string,
      ) => {
        const eventId = `${assistantId}-${type}`;
        updateAssistantCliProcess((process) => {
          const existing = process.events.find((event) => event.id === eventId);
          if (!existing) {
            return {
              ...process,
              events: [
                ...process.events,
                {
                  id: eventId,
                  type,
                  createdAt: new Date().toISOString(),
                  title,
                  content: text,
                },
              ],
            };
          }
          return {
            ...process,
            events: process.events.map((event) =>
              event.id === eventId
                ? {
                    ...event,
                    content: `${event.content ?? ""}${text}`,
                  }
                : event,
            ),
          };
        });
      };
      await streamClaudeChat(
        {
          message: text,
          conversationId: conversation.id,
          runtimeEnv: activeRuntimeEnv,
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
              // session id 由服务端按 runtimeKind 单点持久化并经事件流回灌前端，前端不再写入。
              return;
            }
            if (event.type === "session_invalid") {
              // session 失效后由服务端清除归属；前端只负责展示提示。
              const runtimeLabel = activeRuntimeEnv.name || activeRuntimeEnv.runtimeKind || "CLI";
              const hint = `上一轮 ${runtimeLabel} 会话已失效，已自动重置。请重新发送消息。`;
              setStreamError(hint);
              appendProcessEvent("error", { title: "Session 失效", content: hint });
              updateMessage(conversation.id, assistantId, (message) => ({
                ...message,
                content: message.content || `（${hint}）`,
                status: "error",
                ...(message.kind === "text" && message.cliProcess
                  ? {
                      cliProcess: {
                        ...message.cliProcess,
                        status: "error",
                        finishedAt: new Date().toISOString(),
                        error: hint,
                      },
                    }
                  : {}),
              }));
              setConversationStatus(conversation.id, "error");
              return;
            }
            if (event.type === "status") {
              appendProcessEvent("status", {
                title: event.status === "checking" ? "检查运行环境" : event.status === "running" ? "CLI 运行中" : "CLI 已完成",
                content: event.status,
              });
              return;
            }
            if (event.type === "prompt") {
              const processEvent = createCliProcessEvent(assistantId, "prompt", {
                title: "Prompt 已发送",
                content: event.sections.map((section) => `## ${section.title}\n${section.content}`).join("\n\n"),
              });
              updateAssistantCliProcess((process) => ({
                ...process,
                promptSections: event.sections,
                events: [...process.events, processEvent],
              }));
              return;
            }
            if (event.type === "thinking") {
              appendProcessTextEvent("thinking", "Thinking", event.text);
              return;
            }
            if (event.type === "assistant_trace") {
              appendProcessTextEvent("assistant_trace", "Assistant Trace", event.text);
              return;
            }
            if (event.type === "tool_call") {
              appendProcessEvent("tool_call", {
                title: event.toolName,
                toolName: event.toolName,
                summary: event.summary,
                input: event.input,
              });
              return;
            }
            if (event.type === "delta") {
              updateMessage(conversation.id, assistantId, (message) => ({
                ...message,
                content: `${message.content}${event.text}`,
                ...(message.kind === "text" && message.cliProcess
                  ? {
                      cliProcess: {
                        ...message.cliProcess,
                        output: `${message.cliProcess.output}${event.text}`,
                      },
                    }
                  : {}),
              }));
              return;
            }
            if (event.type === "message") {
              updateMessage(conversation.id, assistantId, (message) => ({
                ...message,
                content: event.content,
                status: "done",
                ...(message.kind === "text" && message.cliProcess
                  ? {
                      cliProcess: {
                        ...message.cliProcess,
                        output: event.content,
                      },
                    }
                  : {}),
              }));
              return;
            }
            if (event.type === "file_artifact") {
              appendProcessEvent("file_artifact", {
                title: "生成附件",
                content: event.ref.label,
              });
              updateMessage(conversation.id, assistantId, (message) =>
                message.kind === "text"
                  ? {
                      ...message,
                      artifactRefs: [...(message.artifactRefs ?? []), event.ref],
                    }
                  : message,
              );
              return;
            }
            if (event.type === "permission_request") {
              setStreamError(event.reason);
              appendProcessEvent("status", { title: "权限受限", content: event.reason });
              return;
            }
            if (event.type === "error") {
              setStreamError(event.message);
              appendProcessEvent("error", { title: "任务失败", content: event.message });
              updateMessage(conversation.id, assistantId, (message) => ({
                ...message,
                content: message.content || `（任务失败：${event.message}）`,
                status: "error",
                ...(message.kind === "text" && message.cliProcess
                  ? {
                      cliProcess: {
                        ...message.cliProcess,
                        status: "error",
                        finishedAt: new Date().toISOString(),
                        error: event.message,
                      },
                    }
                  : {}),
              }));
              setConversationStatus(conversation.id, "error");
              return;
            }
            if (event.type === "done") {
              updateMessage(conversation.id, assistantId, (message) => ({
                ...message,
                status: message.status === "streaming" ? "done" : message.status,
                ...(message.kind === "text" && message.cliProcess
                  ? {
                      cliProcess: {
                        ...message.cliProcess,
                        status: message.cliProcess.status === "running" ? "completed" : message.cliProcess.status,
                        finishedAt: message.cliProcess.finishedAt ?? new Date().toISOString(),
                      },
                    }
                  : {}),
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
        <div className="flex items-center gap-2">
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
          <div className="relative">
            <button
              type="button"
              aria-label="更多"
              onClick={() => setMoreMenuOpen((open) => !open)}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[#D0D7DE] bg-white text-[#6B7280] hover:border-[#111] hover:text-[#111]"
            >
              <Ellipsis className="h-4 w-4" />
            </button>
            {moreMenuOpen ? (
              <div className="absolute right-0 top-9 z-20 w-40 rounded-xl border border-[#E5E7EB] bg-white p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setMemoryOpen(true);
                    setMoreMenuOpen(false);
                  }}
                  className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] text-[#1F2328] hover:bg-[#F5F6F8]"
                >
                  会话记忆
                </button>
              </div>
            ) : null}
          </div>
        </div>
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
            {backgroundIssue ? (
              <div className="rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 text-[12px] leading-5 text-[#92400E]">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
                  <div>
                    <div className="font-medium">
                      {backgroundIssue.kind === "persistence" ? "会话保存暂未完成" : "会话 workspace 初始化暂未完成"}
                    </div>
                    <div className="mt-1">
                      {backgroundIssue.message} 你可以继续在当前会话输入，后台状态会继续收敛，后续操作也会按需重试。
                    </div>
                  </div>
                </div>
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
                      onGovernanceConfirm={onGovernanceConfirm}
                      onGovernanceCancel={onGovernanceCancel}
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
            runtimeEnvironments={runtimeEnvironments}
            activeRuntimeEnvironmentId={activeRuntimeEnvId}
            onRuntimeChange={switchRuntimeEnvironment}
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

      {memoryOpen ? (
        <>
          <button
            type="button"
            aria-label="关闭会话记忆"
            onClick={() => setMemoryOpen(false)}
            className="fixed inset-0 z-30 bg-black/10"
          />
          <aside className="fixed inset-y-0 right-0 z-40 flex w-[520px] max-w-[92vw] flex-col border-l border-[#E5E7EB] bg-white">
            <div className="flex h-12 flex-none items-center justify-between border-b border-[#E5E7EB] px-4">
              <div className="text-[14px] font-medium text-[#111]">会话记忆</div>
              <button
                type="button"
                aria-label="关闭会话记忆"
                onClick={() => setMemoryOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
              >
                <ChevronsRight className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 px-5 py-5">
              <MemoryEditor
                endpoint={`/api/conversations/${conversation.id}/memory`}
                title="当前会话记忆"
                description="这里管理 M1 会话摘要记忆。删除当前会话时，这份记忆会随 workspace 一起删除。"
                limitLabel="6KB"
              />
            </div>
          </aside>
        </>
      ) : null}

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

function ConversationInitializing() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex h-12 flex-none items-center border-b border-[#E5E7EB] px-4 sm:px-6 lg:px-8">
        <div className="h-4 w-32 animate-pulse rounded-full bg-[#E5E7EB]" />
      </header>
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="flex items-center gap-2 rounded-2xl border border-[#E5E7EB] bg-[#F8F9FB] px-4 py-3 text-[13px] text-[#6B7280]">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          <span>正在进入会话...</span>
        </div>
      </div>
    </div>
  );
}
