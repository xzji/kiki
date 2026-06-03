import { DEFAULT_EASTER_EGG_SETTINGS } from "@/lib/goalSystemConfig";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import {
  markTaskNotificationDeliveredProjection,
  transitionTaskInstanceProjection,
} from "@/lib/server/services/goalRuntimeService";
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

function canDeliverNotification(instance: Task["instances"][number]) {
  const notification = instance.notification;
  if (!notification?.shouldNotify || notification.deliveryState !== "pending") return false;
  return notification.channel !== "silent" && notification.notificationType !== "silent_archive";
}

function upsertScheduleEvent(events: AgentEvent[], event: AgentEvent) {
  return events.some((entry) => entry.id === event.id) ? events : [...events, event];
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
  let nextGoals = goals;
  let delivered = 0;
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        for (const instance of task.instances) {
          const notification = instance.notification;
          if (!notification || !canDeliverNotification(instance)) continue;
          const previousSequence = notification.notificationSequence ?? 0;
          const nextSequence = previousSequence + 1;
          // 每次进入 pending 的派发都生成新的 conversationMessageId（携带递增序号），
          // 让会话流以 append-only 方式记录每一次任务通知，避免历史卡片被新内容替换。
          const inboxItemId = shouldDeliverToInbox(notification.channel) ? `inbox-${instance.id}` : undefined;
          const conversationExists = goal.conversationId ? !!getConversation(goal.conversationId) : false;
          const conversationMessageId =
            goal.conversationId && conversationExists && shouldDeliverToConversation(notification.channel)
              ? `msg-task-${instance.id}-n${nextSequence}`
              : undefined;
          nextGoals = markTaskNotificationDeliveredProjection({
            goals: nextGoals,
            taskId: task.id,
            instanceId: instance.id,
            inboxItemId,
            conversationMessageId,
            notificationSequence: nextSequence,
          });
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
              // 会话投影失败不应阻断 goal 侧通知派发；事件流仍保留 notification.delivered。
            }
          }
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
      }
    }
  }
  return { delivered };
}

export function runGoalWatchdogWorker(goals: Goal[]) {
  let nextGoals = goals;
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
            nextGoals = transitionTaskInstanceProjection({
              goals: nextGoals,
              taskId: task.id,
              instanceId: instance.id,
              status: "paused",
              reason: "任务执行超时，daemon 已自动暂停。",
            });
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
