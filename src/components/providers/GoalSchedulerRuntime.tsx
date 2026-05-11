"use client";

import { useEffect } from "react";

import { startTaskRun, waitForTaskRunCompletion } from "@/lib/api/taskRuns";
import { useConversationStore } from "@/stores/conversationStore";
import { useEasterEggSettingsStore } from "@/stores/easterEggSettingsStore";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
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

function buildTaskLink(goalId: string, taskId: string, instanceId: string) {
  return `/goals/${goalId}/tasks/${taskId}?view=exec&instanceId=${instanceId}`;
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

function buildResultInboxItem(input: {
  goal: Goal;
  task: Task;
  instanceId: string;
  createdAt: string;
}): InboxItem | null {
  const instance = input.task.instances.find((entry) => entry.id === input.instanceId);
  const notification = instance?.notification;
  if (!notification?.shouldNotify) return null;
  return {
    id: `inbox-${input.instanceId}`,
    iconType: getTaskIconType(input.task),
    title: notification.title,
    snippet: notification.snippet,
    badge: notification.badge ?? null,
    unreadCount: 1,
    timeLabel: formatLocalTime(new Date(notification.createdAt || input.createdAt)),
    linkTo: buildTaskLink(input.goal.id, input.task.id, input.instanceId),
    goalId: input.goal.id,
    createdAt: notification.createdAt || input.createdAt,
  };
}

function shouldDeliverToInbox(channel: NonNullable<Task["instances"][number]["notification"]>["channel"]) {
  return channel === "inbox" || channel === "both";
}

function shouldDeliverToConversation(channel: NonNullable<Task["instances"][number]["notification"]>["channel"]) {
  return channel === "conversation" || channel === "both";
}

function canDeliverNotification(instance: Task["instances"][number]) {
  const notification = instance.notification;
  if (!notification?.shouldNotify || notification.deliveryState !== "pending") return false;
  return notification.channel !== "silent" && notification.notificationType !== "silent_archive";
}

function deliverPendingTaskNotifications(goals: Goal[]) {
  const inboxStore = useInboxStore.getState();
  const conversationStore = useConversationStore.getState();
  const goalStore = useGoalStore.getState();

  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          const notification = instance.notification;
          if (!notification || !canDeliverNotification(instance)) continue;

          const inboxItem = shouldDeliverToInbox(notification.channel)
            ? buildResultInboxItem({
                goal,
                task,
                instanceId: instance.id,
                createdAt: notification.createdAt,
              })
            : null;
          if (inboxItem) {
            inboxStore.upsertItem(inboxItem);
          }

          const messageId = notification.conversationMessageId || `msg-task-${instance.id}`;
          if (goal.conversationId && shouldDeliverToConversation(notification.channel)) {
            const conversation = conversationStore.conversations.find((entry) => entry.id === goal.conversationId);
            const nextMessage = {
              id: messageId,
              kind: "task_card" as const,
              role: "kiki" as const,
              content: notification.userMessage,
              createdAt: notification.createdAt,
              unread: true,
              status: "done" as const,
              source: "system" as const,
              taskRef: {
                goalId: goal.id,
                subGoalId: subGoal.id,
                taskId: task.id,
                instanceId: instance.id,
              },
            };
            if (conversation?.messages.some((message) => message.id === messageId)) {
              conversationStore.updateMessage(goal.conversationId, messageId, (message) =>
                message.kind === "task_card" ? { ...message, ...nextMessage } : message,
              );
            } else {
              conversationStore.appendMessage(goal.conversationId, nextMessage);
            }
          }

          goalStore.markTaskNotificationDelivered({
            taskId: task.id,
            instanceId: instance.id,
            inboxItemId: inboxItem?.id,
            conversationMessageId:
              goal.conversationId && shouldDeliverToConversation(notification.channel) ? messageId : undefined,
          });
        }
      }
    }
  }
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
  const runtimeEnv = useRuntimeEnvStore.getState().getActiveEnvironment();
  const activeGoals = goalStore.goals.filter(
    (goal) =>
      goal.workflow?.planDecision === "confirmed" &&
      (goal.workflow.phase === "executing" || goal.workflow.phase === "monitoring"),
  );
  if (activeGoals.length === 0) return;
  if (!runtimeEnv || runtimeEnv.type !== "local") return;

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

  const scheduleStore = useScheduleStore.getState();

  for (const item of tasksToLaunch) {
    const instance = goalStore.generateInstance(item.task.id, nowIso);
    if (!instance) continue;

    const latestTask = useGoalStore
      .getState()
      .goals.flatMap((goal) => goal.subGoals.flatMap((subGoal) => subGoal.tasks))
      .find((task) => task.id === item.task.id);
    const latestInstance = latestTask?.instances.find((entry) => entry.id === instance.id) ?? instance;
    const latestGoal = useGoalStore.getState().goals.find((goal) => goal.id === item.goal.id) ?? item.goal;
    const latestSubGoal = latestGoal.subGoals.find((subGoal) => subGoal.id === item.subGoalId);
    const effectiveTask = latestSubGoal?.tasks.find((task) => task.id === item.task.id) ?? latestTask ?? item.task;
    if (!latestSubGoal) continue;

    const scheduleEvent = buildScheduleEvent(item.goal, item.task, latestInstance.id, now);
    if (!scheduleStore.events.some((event) => event.id === scheduleEvent.id)) {
      scheduleStore.addEvent(scheduleEvent);
    }

    void (async () => {
      try {
        const run = await startTaskRun({
          goal: latestGoal,
          subGoal: latestSubGoal,
          task: effectiveTask,
          instance: latestInstance,
          runtimeEnv,
        });
        useGoalStore.getState().startTaskInstanceRun({
          taskId: effectiveTask.id,
          instanceId: latestInstance.id,
          requestId: run.requestId,
          runtimeEnvId: runtimeEnv.id,
          permissionMode: runtimeEnv.permissionMode,
          workingDirectory: effectiveTask.recommendedWorkingDirectory || runtimeEnv.workingDirectory,
        });
        const result = await waitForTaskRunCompletion({
          requestId: run.requestId,
          taskInstanceId: latestInstance.id,
          onProgress: (payload) => {
            useGoalStore.getState().syncTaskInstanceRun({
              taskId: effectiveTask.id,
              instanceId: latestInstance.id,
              progress: payload.progress,
              logs: payload.logs,
            });
          },
        });
        useGoalStore.getState().syncTaskInstanceRun({
          taskId: effectiveTask.id,
          instanceId: latestInstance.id,
          progress: result.progress,
          logs: result.logs,
        });
      } catch {
        useGoalStore.getState().markInstanceStatus(effectiveTask.id, latestInstance.id, "error");
      }
    })();
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
  const browserSchedulerEnabled = process.env.NEXT_PUBLIC_KIKI_ENABLE_BROWSER_SCHEDULER === "1";

  useEffect(() => {
    hydrateSettings();
  }, [hydrateSettings]);

  useEffect(() => {
    if (!browserSchedulerEnabled) return;
    if (!hydrated) return;
    runGoalSchedulerCycle();
  }, [browserSchedulerEnabled, goals, hydrated, settings.maxConcurrentTasks]);

  useEffect(() => {
    if (!hydrated) return;
    deliverPendingTaskNotifications(goals);
  }, [goals, hydrated]);

  useEffect(() => {
    if (!browserSchedulerEnabled) return;
    if (!hydrated) return;
    const timer = window.setInterval(() => {
      runGoalSchedulerCycle();
    }, settings.schedulerCycleIntervalMs);
    return () => window.clearInterval(timer);
  }, [browserSchedulerEnabled, hydrated, settings.schedulerCycleIntervalMs]);

  return null;
}
