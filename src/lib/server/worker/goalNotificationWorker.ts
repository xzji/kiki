import { DEFAULT_EASTER_EGG_SETTINGS } from "@/lib/goalSystemConfig";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import {
  backfillTaskNotificationStatesFromGoals,
  listPendingTaskNotificationStates,
  markTaskNotificationDeliveredState,
} from "@/lib/server/repositories/taskNotificationStateRepository";
import { getRuntimeJobByTaskInstanceId } from "@/lib/server/repositories/runtimeJobsRepository";
import { updateGoalRuntimeJobExecution } from "@/lib/server/services/goalRuntimeService";
import { composeGoalsWithRuntimeJobs } from "@/lib/server/runtime/instanceComposition";
import { applyConversationCommand } from "@/lib/server/services/conversationCommandService";
import { getConversation } from "@/lib/server/repositories/conversationsRepository";
import { readGoalsSnapshot, readScheduleEventsSnapshot, upsertScheduleEventsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import type { Goal, Task } from "@/types/kiki";
import type { AgentEvent } from "@/types/schedule";

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
    color: "blue",
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

function shouldDeliverToInbox(channel: NonNullable<Task["instances"][number]["notification"]>["channel"]) {
  return channel === "inbox" || channel === "both";
}

function shouldDeliverToConversation(channel: NonNullable<Task["instances"][number]["notification"]>["channel"]) {
  return channel === "conversation" || channel === "both";
}

function resolveDeliveryChannel(notification: NonNullable<Task["instances"][number]["notification"]>) {
  // 兼容已由旧策略生成但尚未派发的 pending 通知：普通 result_ready 不再只进 inbox。
  if (
    notification.notificationType === "result_ready" &&
    notification.priority === "normal" &&
    notification.channel === "inbox"
  ) {
    return "conversation";
  }
  return notification.channel;
}

function canDeliverNotification(instance: Task["instances"][number]) {
  const notification = instance.notification;
  if (!notification?.shouldNotify || notification.deliveryState !== "pending") return false;
  return notification.channel !== "silent" && notification.notificationType !== "silent_archive";
}

function upsertScheduleEvent(events: AgentEvent[], event: AgentEvent) {
  return events.some((entry) => entry.id === event.id) ? events : [...events, event];
}

function findTaskContext(goals: Goal[], input: { goalId?: string; taskId?: string; instanceId: string }) {
  for (const goal of goals) {
    if (input.goalId && goal.id !== input.goalId) continue;
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        if (input.taskId && task.id !== input.taskId) continue;
        const instance = task.instances.find((entry) => entry.id === input.instanceId);
        if (instance) return { goal, subGoal, task, instance };
      }
    }
  }
  return null;
}

export function runGoalScheduleSynthesisWorker(goals: Goal[]) {
  let events = readScheduleEventsSnapshot([]);
  let synthesized = 0;
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          if (!instance.runner?.requestId) continue;
          const event = buildScheduleEvent(goal, task, instance.id, new Date(instance.createdAt));
          if (events.some((entry) => entry.id === event.id)) continue;
          events = upsertScheduleEvent(events, event);
          synthesized += 1;
          appendGoalEventOnce({
            goalId: goal.id,
            taskId: task.id,
            instanceId: instance.id,
            kind: "schedule.event_synthesized",
            producedBy: "daemon",
            idempotencyKey: `schedule.event_synthesized:${instance.id}`,
            payload: {
              scheduleEventId: event.id,
            },
          });
        }
      }
    }
  }
  if (synthesized > 0) {
    upsertScheduleEventsSnapshot(events);
  }
  return { synthesized };
}

export function runGoalNotificationDeliveryWorker(goals: Goal[]) {
  backfillTaskNotificationStatesFromGoals(goals);
  const composedGoals = composeGoalsWithRuntimeJobs(goals);
  let delivered = 0;
  for (const record of listPendingTaskNotificationStates()) {
    const context = findTaskContext(composedGoals, {
      goalId: record.goalId,
      taskId: record.taskId,
      instanceId: record.instanceId,
    });
    if (!context) continue;
    const { goal, subGoal, task } = context;
    const instance = {
      ...context.instance,
      notification: record.notification,
    };
    const notification = record.notification;
    if (!canDeliverNotification(instance)) continue;
    const deliveryChannel = resolveDeliveryChannel(notification);
    const previousSequence = notification.notificationSequence ?? 0;
    const nextSequence = previousSequence + 1;
    // 每次进入 pending 的派发都生成新的 conversationMessageId（携带递增序号），
    // 让会话流以 append-only 方式记录每一次任务通知，避免历史卡片被新内容替换。
    const inboxItemId = shouldDeliverToInbox(deliveryChannel) ? `inbox-${instance.id}` : undefined;
    const conversationExists = goal.conversationId ? !!getConversation(goal.conversationId) : false;
    const conversationMessageId =
      goal.conversationId && conversationExists && shouldDeliverToConversation(deliveryChannel)
        ? `msg-task-${instance.id}-n${nextSequence}`
        : undefined;

    if (conversationMessageId && notification.userMessage) {
      try {
        applyConversationCommand({
          command: {
            type: "append_message",
            conversationId: goal.conversationId!,
            message: {
              id: conversationMessageId,
              kind: "task_card",
              role: "kiki",
              content: notification.userMessage,
              createdAt: notification.createdAt,
              unread: true,
              status: "done",
              source: "system",
              taskRef: {
                goalId: goal.id,
                subGoalId: subGoal.id,
                taskId: task.id,
                instanceId: instance.id,
              },
              taskSnapshot: {
                task,
                instance,
              },
            },
          },
          idempotencyKey: `conversation.message.append:${conversationMessageId}`,
          producedBy: "worker",
        });
      } catch {
        // 会话投影失败时保持 pending，下一轮 worker 重试，避免账本误标 delivered。
        continue;
      }
    }

    markTaskNotificationDeliveredState({
      instanceId: instance.id,
      inboxItemId,
      conversationMessageId,
      notificationSequence: nextSequence,
    });
    delivered += 1;
    for (const target of [
      inboxItemId ? "inbox" : null,
      conversationMessageId ? "conversation" : null,
    ] as const) {
      if (!target) continue;
      appendGoalEventOnce({
        goalId: goal.id,
        taskId: task.id,
        instanceId: instance.id,
        kind: "notification.delivered",
        producedBy: "daemon",
        idempotencyKey: `notification.delivered:${target}:${instance.id}:n${nextSequence}`,
        payload: {
          target,
          notificationId: target === "inbox" ? inboxItemId : conversationMessageId,
        },
      });
    }
  }
  return { delivered };
}

export function runGoalWatchdogWorker(goals: Goal[]) {
  let paused = 0;
  let heartbeats = 0;
  const nowMs = Date.now();
  const now = new Date().toISOString();
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          const ageMs = nowMs - new Date(instance.createdAt).getTime();
          if (instance.status === "in_progress" && ageMs >= DEFAULT_EASTER_EGG_SETTINGS.taskDefaultTimeoutMs) {
            const job = getRuntimeJobByTaskInstanceId(instance.id);
            if (job) {
              updateGoalRuntimeJobExecution(job.id, {
                status: "cancelled",
                finishedAt: now,
                leaseOwner: undefined,
                leaseExpiresAt: undefined,
                lastError: "任务执行超时，daemon 已自动暂停。",
              });
            }
            paused += 1;
            appendGoalEventOnce({
              goalId: goal.id,
              taskId: task.id,
              instanceId: instance.id,
              kind: "instance.timeout_paused",
              producedBy: "daemon",
              idempotencyKey: `instance.timeout_paused:${instance.id}`,
              createdAt: now,
              payload: {
                reason: "任务执行超时，daemon 已自动暂停。",
                timeoutMs: DEFAULT_EASTER_EGG_SETTINGS.taskDefaultTimeoutMs,
              },
            });
          }
          if (instance.status === "awaiting_user" && ageMs >= DEFAULT_EASTER_EGG_SETTINGS.taskHeartbeatTimeoutMs) {
            heartbeats += 1;
            appendGoalEventOnce({
              goalId: goal.id,
              taskId: task.id,
              instanceId: instance.id,
              kind: "notification.delivered",
              producedBy: "daemon",
              idempotencyKey: `notification.delivered:heartbeat:${instance.id}`,
              createdAt: now,
              payload: {
                target: "inbox",
                notificationId: `inbox-heartbeat-${instance.id}`,
              },
            });
          }
        }
      }
    }
  }
  return { paused, heartbeats };
}

export function runGoalDaemonSideEffects(goals: Goal[]) {
  const schedule = runGoalScheduleSynthesisWorker(goals);
  const watchdog = runGoalWatchdogWorker(readGoalsSnapshot(goals));
  const notifications = runGoalNotificationDeliveryWorker(readGoalsSnapshot(goals));
  return {
    schedule,
    watchdog,
    notifications,
  };
}
