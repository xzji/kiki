"use client";

import { useEffect } from "react";

import { useConversationStore } from "@/stores/conversationStore";
import { useEasterEggSettingsStore } from "@/stores/easterEggSettingsStore";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useScheduleStore } from "@/stores/scheduleStore";
import type { Goal, InboxItem, Task, TaskInstanceStatus } from "@/types/kiki";
import type { AgentEvent } from "@/types/schedule";

const PRIORITY_WEIGHT: Record<NonNullable<Task["priority"]>, number> = {
  critical: 400,
  high: 300,
  medium: 200,
  low: 100,
};

const OPEN_INSTANCE_STATUSES = new Set<TaskInstanceStatus>([
  "pending",
  "in_progress",
  "awaiting_user",
  "paused",
]);
const SLOT_OCCUPYING_STATUSES = new Set<TaskInstanceStatus>(["pending", "in_progress", "awaiting_user"]);
const PREPARED_RESULT_KINDS = new Set<Task["executionKind"]>([
  "reading_digest",
  "confirm_action",
  "draft_review",
]);

type ReadyTask = {
  goal: Goal;
  subGoalId: string;
  task: Task;
  priorityScore: number;
};

function formatLocalTime(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getTaskIconType(task: Task): InboxItem["iconType"] {
  switch (task.executionKind) {
    case "draft_review":
      return "mail";
    case "confirm_action":
      return "booking";
    case "reading_digest":
      return "news";
    default:
      return "task";
  }
}

function getTaskBadge(task: Task): InboxItem["badge"] {
  switch (task.executionKind) {
    case "confirm_action":
    case "draft_review":
      return "need_confirm";
    case "flashcard":
    case "listening_qa":
    case "freeform_chat":
      return "need_answer";
    default:
      return null;
  }
}

function taskDisplayTitle(goal: Goal, task: Task) {
  return `${task.title.replace(/^任务\d+：/, "")} - ${goal.title}`;
}

function buildTaskLink(goalId: string, taskId: string, instanceId: string) {
  return `/goals/${goalId}/tasks/${taskId}?view=exec&instanceId=${instanceId}`;
}

function buildInboxSnippet(task: Task) {
  switch (task.executionKind) {
    case "confirm_action":
      return "[需要确认] KiKi 已准备好建议方案，等待你确认是否执行。";
    case "draft_review":
      return "[需要确认] KiKi 已准备好草稿，等你审阅后发送。";
    case "reading_digest":
      return "KiKi 已整理好本轮阅读摘要，可以直接查看结果。";
    case "flashcard":
      return "KiKi 已生成本轮记忆卡片，开始后即可进入练习。";
    case "listening_qa":
      return "KiKi 已准备好本轮听力问答，开始后即可作答。";
    case "freeform_chat":
      return "KiKi 已准备好对话引导，等待你进入本轮执行。";
    default:
      return "KiKi 已启动一个新的目标任务。";
  }
}

function buildConversationContent(task: Task) {
  switch (task.executionKind) {
    case "confirm_action":
      return `我已推进任务「${task.title.replace(/^任务\d+：/, "")}」，现在需要你确认下一步。`;
    case "draft_review":
      return `我已生成任务「${task.title.replace(/^任务\d+：/, "")}」的草稿，等你审阅。`;
    case "reading_digest":
      return `我已整理好任务「${task.title.replace(/^任务\d+：/, "")}」的结果摘要。`;
    default:
      return `我已启动任务「${task.title.replace(/^任务\d+：/, "")}」，点击卡片查看并继续执行。`;
  }
}

function buildScheduleEvent(goal: Goal, task: Task, instanceId: string, startedAt: Date): AgentEvent {
  const endAt = new Date(startedAt.getTime() + 30 * 60 * 1000);
  return {
    id: `sched-${instanceId}`,
    title: task.title.replace(/^任务\d+：/, ""),
    description: `KiKi 已启动「${goal.title}」下的任务执行。`,
    startTime: startedAt.toISOString(),
    endTime: endAt.toISOString(),
    isAllDay: false,
    attendees: [],
    color:
      task.executionKind === "draft_review"
        ? "purple"
        : task.executionKind === "confirm_action"
          ? "orange"
          : task.executionKind === "reading_digest"
            ? "cyan"
            : "blue",
    createdByAgent: true,
    agentActions: [
      {
        label: "打开任务",
        type: "primary",
        payload: {
          goalId: goal.id,
          taskId: task.id,
          instanceId,
        },
      },
    ],
  };
}

function toTaskRuntimeStatus(task: Task) {
  const latestStatus = task.instances[0]?.status;
  if (latestStatus && OPEN_INSTANCE_STATUSES.has(latestStatus)) return latestStatus;
  if (task.progress >= 100) return "completed";
  return "pending";
}

function dependenciesMet(goal: Goal, task: Task) {
  if (!task.dependencies?.length) return true;
  const taskMap = new Map(goal.subGoals.flatMap((subGoal) => subGoal.tasks).map((item) => [item.id, item]));
  return task.dependencies.every((dependencyId) => {
    const dependency = taskMap.get(dependencyId);
    if (!dependency) return false;
    if (dependency.progress >= 100) return true;
    const latestStatus = dependency.instances[0]?.status;
    return latestStatus === "completed";
  });
}

function parseHourMinute(triggerRule: string) {
  const match = triggerRule.match(/(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function hasInstanceOnDay(task: Task, date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const label = `${month}-${day}`;
  return task.instances.some((instance) => instance.dateLabel === label);
}

function isTaskDue(task: Task, now: Date) {
  if (task.taskType === "one_shot") {
    return task.instances.length === 0;
  }

  if (hasInstanceOnDay(task, now)) {
    return false;
  }

  const time = parseHourMinute(task.triggerRule);
  if (!time) return true;

  const due = new Date(now);
  due.setHours(time.hour, time.minute, 0, 0);
  return now.getTime() >= due.getTime();
}

function computePriorityScore(task: Task) {
  const priority = task.priority ?? "medium";
  const priorityScore = PRIORITY_WEIGHT[priority];
  const taskTypeScore = task.taskType === "one_shot" ? 30 : task.taskType === "monitoring" ? 20 : 10;
  const executionScore = task.executionKind === "confirm_action" ? 20 : task.executionKind === "draft_review" ? 15 : 0;
  return priorityScore + taskTypeScore + executionScore;
}

function getReadyTasks(goals: Goal[]) {
  const ready: ReadyTask[] = [];
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        if (task.progress >= 100 && task.taskType === "one_shot") continue;
        if (!dependenciesMet(goal, task)) continue;
        const runtimeStatus = toTaskRuntimeStatus(task);
        if (runtimeStatus !== "pending" && runtimeStatus !== "completed") continue;
        if (!isTaskDue(task, new Date())) continue;
        ready.push({
          goal,
          subGoalId: subGoal.id,
          task,
          priorityScore: computePriorityScore(task),
        });
      }
    }
  }
  return ready.sort((left, right) => right.priorityScore - left.priorityScore);
}

function buildInboxItem(goal: Goal, task: Task, instanceId: string, createdAt: string): InboxItem {
  return {
    id: `inbox-${instanceId}`,
    iconType: getTaskIconType(task),
    title: taskDisplayTitle(goal, task),
    snippet: buildInboxSnippet(task),
    badge: getTaskBadge(task),
    unreadCount: 1,
    timeLabel: formatLocalTime(new Date(createdAt)),
    linkTo: buildTaskLink(goal.id, task.id, instanceId),
    goalId: goal.id,
    createdAt,
  };
}

function buildReminderItem(input: {
  kind: "timeout" | "heartbeat";
  goal: Goal;
  task: Task;
  instanceId: string;
  createdAt: string;
}): InboxItem {
  const timeout = input.kind === "timeout";
  return {
    id: `${timeout ? "inbox-timeout" : "inbox-heartbeat"}-${input.instanceId}`,
    iconType: "task",
    title: `${timeout ? "执行超时" : "等待你继续"} - ${input.task.title.replace(/^任务\d+：/, "")}`,
    snippet: timeout
      ? "该任务执行时间过长，KiKi 已自动暂停，等待你继续处理。"
      : "这个任务已经等待你一段时间了，KiKi 提醒你回来继续推进。",
    badge: timeout ? "need_confirm" : "need_answer",
    unreadCount: 1,
    timeLabel: formatLocalTime(new Date(input.createdAt)),
    linkTo: buildTaskLink(input.goal.id, input.task.id, input.instanceId),
    goalId: input.goal.id,
    createdAt: input.createdAt,
  };
}

function runExecutionWatchdogs(goals: Goal[]) {
  const settings = useEasterEggSettingsStore.getState().getSettings();
  const goalStore = useGoalStore.getState();
  const inboxStore = useInboxStore.getState();
  const nowMs = Date.now();

  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          const ageMs = nowMs - new Date(instance.createdAt).getTime();
          if (instance.status === "in_progress" && ageMs >= settings.taskDefaultTimeoutMs) {
            goalStore.markInstanceStatus(task.id, instance.id, "paused");
            const reminder = buildReminderItem({
              kind: "timeout",
              goal,
              task,
              instanceId: instance.id,
              createdAt: new Date().toISOString(),
            });
            if (!inboxStore.items.some((entry) => entry.id === reminder.id)) {
              inboxStore.addItem(reminder);
            }
          }
          if (instance.status === "awaiting_user" && ageMs >= settings.taskHeartbeatTimeoutMs) {
            const reminder = buildReminderItem({
              kind: "heartbeat",
              goal,
              task,
              instanceId: instance.id,
              createdAt: new Date().toISOString(),
            });
            if (!inboxStore.items.some((entry) => entry.id === reminder.id)) {
              inboxStore.addItem(reminder);
            }
          }
        }
      }
    }
  }
}

function runGoalSchedulerCycle() {
  const goalStore = useGoalStore.getState();
  const activeGoals = goalStore.goals.filter(
    (goal) =>
      goal.workflow?.planDecision === "confirmed" &&
      (goal.workflow.phase === "executing" || goal.workflow.phase === "monitoring"),
  );
  if (activeGoals.length === 0) return;

  runExecutionWatchdogs(activeGoals);

  const settings = useEasterEggSettingsStore.getState().getSettings();
  const runningCount = activeGoals
    .flatMap((goal) => goal.subGoals.flatMap((subGoal) => subGoal.tasks))
    .flatMap((task) => task.instances)
    .filter((instance) => SLOT_OCCUPYING_STATUSES.has(instance.status)).length;

  const readyTasks = getReadyTasks(activeGoals);
  const availableSlots = Math.max(0, settings.maxConcurrentTasks - runningCount);
  const tasksToLaunch = readyTasks.slice(0, availableSlots);
  const now = new Date();
  const nowIso = now.toISOString();

  if (tasksToLaunch.length === 0) {
    activeGoals.forEach((goal) => {
      if (goal.workflow?.phase === "executing") {
        goalStore.updateGoalWorkflow(goal.id, { phase: "monitoring" });
      }
    });
    return;
  }

  const inboxStore = useInboxStore.getState();
  const scheduleStore = useScheduleStore.getState();
  const conversationStore = useConversationStore.getState();

  for (const item of tasksToLaunch) {
    const instance = goalStore.generateInstance(item.task.id, nowIso);
    if (!instance) continue;

    const nextStatus: TaskInstanceStatus = PREPARED_RESULT_KINDS.has(item.task.executionKind)
      ? "awaiting_user"
      : "pending";
    goalStore.markInstanceStatus(item.task.id, instance.id, nextStatus);

    const latestTask = useGoalStore
      .getState()
      .goals.flatMap((goal) => goal.subGoals.flatMap((subGoal) => subGoal.tasks))
      .find((task) => task.id === item.task.id);
    const latestInstance = latestTask?.instances.find((entry) => entry.id === instance.id) ?? instance;

    const inboxItem = buildInboxItem(item.goal, item.task, latestInstance.id, latestInstance.createdAt);
    if (!inboxStore.items.some((entry) => entry.id === inboxItem.id)) {
      inboxStore.addItem(inboxItem);
    }

    const scheduleEvent = buildScheduleEvent(item.goal, item.task, latestInstance.id, now);
    if (!scheduleStore.events.some((event) => event.id === scheduleEvent.id)) {
      scheduleStore.addEvent(scheduleEvent);
    }

    if (item.goal.conversationId) {
      const conversation = conversationStore.conversations.find((entry) => entry.id === item.goal.conversationId);
      const messageId = `msg-task-${latestInstance.id}`;
      if (conversation && !conversation.messages.some((message) => message.id === messageId)) {
        conversationStore.appendMessage(item.goal.conversationId, {
          id: messageId,
          kind: "task_card",
          role: "kiki",
          content: buildConversationContent(item.task),
          createdAt: latestInstance.createdAt,
          unread: true,
          status: "done",
          source: "system",
          taskRef: {
            goalId: item.goal.id,
            subGoalId: item.subGoalId,
            taskId: item.task.id,
            instanceId: latestInstance.id,
          },
        });
      }
    }
  }

  activeGoals.forEach((goal) => {
    if (goal.workflow?.phase === "executing") {
      goalStore.updateGoalWorkflow(goal.id, { phase: "monitoring" });
    }
  });
}

export function GoalSchedulerRuntime() {
  const goals = useGoalStore((state) => state.goals);
  const hydrated = useEasterEggSettingsStore((state) => state.hydrated);
  const settings = useEasterEggSettingsStore((state) => state.settings);
  const hydrateSettings = useEasterEggSettingsStore((state) => state.hydrate);

  useEffect(() => {
    hydrateSettings();
  }, [hydrateSettings]);

  useEffect(() => {
    if (!hydrated) return;
    runGoalSchedulerCycle();
  }, [goals, hydrated, settings.maxConcurrentTasks]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setInterval(() => {
      runGoalSchedulerCycle();
    }, settings.schedulerCycleIntervalMs);
    return () => window.clearInterval(timer);
  }, [hydrated, settings.schedulerCycleIntervalMs]);

  return null;
}
