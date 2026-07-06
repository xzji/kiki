import { DEFAULT_EASTER_EGG_SETTINGS } from "@/lib/goalSystemConfig";
import { getDatabase } from "@/lib/server/db/client";
import { appendGoalEventOnce } from "@/lib/server/repositories/goalEventLogRepository";
import {
  backfillTaskNotificationStatesFromGoals,
  ensureTaskNotificationStateFromInstance,
  listPendingTaskNotificationStates,
  markTaskNotificationDeliveredState,
} from "@/lib/server/repositories/taskNotificationStateRepository";
import { getRuntimeJobByTaskInstanceId } from "@/lib/server/repositories/runtimeJobsRepository";
import {
  transitionTaskInstanceProjection,
  updateGoalRuntimeJobExecution,
} from "@/lib/server/services/goalRuntimeService";
import { composeGoalsWithRuntimeJobs } from "@/lib/server/runtime/instanceComposition";
import { applyConversationCommand } from "@/lib/server/services/conversationCommandService";
import { getConversation } from "@/lib/server/repositories/conversationsRepository";
import { readScheduleEventsSnapshot, upsertScheduleEventsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import { buildAwaitingDisplayModel } from "@/lib/taskInstance/awaitingDisplayModel";
import type { ConversationMessage, Goal, Task } from "@/types/kiki";
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

function isAwaitingUserInteraction(instance: Task["instances"][number]) {
  const blocker = instance.awaitingUser?.blocker;
  // 工具授权 blocker 也带 interactionRequirement/resumeToken，但它有专属的授权弹窗（仅存在于 task_card），
  // 不能走通用的「补充信息」交互消息，否则会丢失授权 UI。
  if (blocker?.toolPermission) return false;
  return Boolean(
    blocker?.resumeToken &&
      instance.awaitingUser?.interactionRequirement &&
      instance.status === "awaiting_user",
  );
}

function buildTaskConversationMessage(input: {
  id: string;
  content: string;
  createdAt: string;
  goal: Goal;
  subGoalId: string;
  task: Task;
  instance: Task["instances"][number];
}): ConversationMessage {
  const taskRef = {
    goalId: input.goal.id,
    subGoalId: input.subGoalId,
    taskId: input.task.id,
    instanceId: input.instance.id,
  };
  if (isAwaitingUserInteraction(input.instance) && input.instance.awaitingUser) {
    const displayModel = buildAwaitingDisplayModel(input.task, input.instance, "card");
    const requirement = input.instance.awaitingUser.interactionRequirement;
    return {
      id: input.id,
      kind: "task_interaction_request",
      role: "kiki",
      content: input.content,
      createdAt: input.createdAt,
      unread: true,
      status: "done",
      source: "system",
      taskRef,
      interactionSnapshot: {
        panelTitle: displayModel.panelTitle,
        headline: displayModel.headline || input.instance.awaitingUser.reason,
        statusLabel: displayModel.statusLabel,
        fields: displayModel.fields,
        hideFieldQuestions: Array.from(displayModel.hideFieldQuestions),
        reason: input.instance.awaitingUser.reason,
        resumeToken: input.instance.awaitingUser.blocker?.resumeToken ?? "",
        requirementType: requirement?.type ?? "provide_context",
        options: requirement?.options,
      },
    };
  }
  return {
    id: input.id,
    kind: "task_card",
    role: "kiki",
    content: input.content,
    createdAt: input.createdAt,
    unread: true,
    status: "done",
    source: "system",
    taskRef,
    taskSnapshot: {
      task: input.task,
      instance: input.instance,
    },
  };
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
  const composedGoals = composeGoalsWithRuntimeJobs(goals);
  backfillTaskNotificationStatesFromGoals(composedGoals);
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
        ? `${isAwaitingUserInteraction(instance) ? "msg-interaction" : "msg-task"}-${instance.id}-n${nextSequence}`
        : undefined;

    // append 消息 + 标记 delivered + 投递事件必须原子：任一步失败则整笔回滚、保持 pending，
    // 下一轮 worker 重试。markDelivered 在提交前不推进 notificationSequence，因此重试沿用同一
    // sequence → 同一 conversationMessageId/幂等 key，避免重试产生重复卡片。
    // applyConversationCommand 自带事务，嵌套时 better-sqlite3 自动降级为 savepoint。
    try {
      getDatabase().transaction(() => {
        if (conversationMessageId && notification.userMessage) {
          applyConversationCommand({
            command: {
              type: "append_message",
              conversationId: goal.conversationId!,
              message: buildTaskConversationMessage({
                id: conversationMessageId,
                content: notification.userMessage,
                createdAt: notification.createdAt,
                goal,
                subGoalId: subGoal.id,
                task,
                instance,
              }),
            },
            idempotencyKey: `conversation.message.append:${conversationMessageId}`,
            producedBy: "worker",
          });
        }

        markTaskNotificationDeliveredState({
          instanceId: instance.id,
          inboxItemId,
          conversationMessageId,
          notificationSequence: nextSequence,
        });

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
      })();
    } catch {
      // 投递失败时整笔回滚并保持 pending，下一轮 worker 重试，避免账本误标 delivered。
      continue;
    }
    delivered += 1;
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
          // 超时判定必须以「当前执行片段」为基准，而非实例创建时间：一个存在很久、
          // 反复暂停/续跑的实例，其 createdAt 早已超过超时阈值，若以此计龄会导致刚进入
          // in_progress 就被立即判超时并暂停，形成「续跑→秒超时→再续跑」的死循环。
          // execution.activeSince 仅在 in_progress 时有值，表示本次执行片段的开始时间。
          const createdAtMs = new Date(instance.createdAt).getTime();
          const runStartedAt =
            instance.execution?.activeSince ?? instance.execution?.startedAt ?? instance.createdAt;
          const runAgeMs = nowMs - new Date(runStartedAt).getTime();
          if (instance.status === "in_progress" && runAgeMs >= DEFAULT_EASTER_EGG_SETTINGS.taskDefaultTimeoutMs) {
            const timeoutReason = "任务执行超时，daemon 已自动暂停。";
            const job = getRuntimeJobByTaskInstanceId(instance.id);
            if (job) {
              updateGoalRuntimeJobExecution(job.id, {
                status: "cancelled",
                finishedAt: now,
                leaseOwner: undefined,
                leaseExpiresAt: undefined,
                lastError: timeoutReason,
              });
            }
            // job 置 cancelled 只更新 runtime_jobs 表并发 status_changed 事件，不落 goals 快照；
            // 若前端漏收该事件，读快照会永远停留在 in_progress。这里同步把实例状态写回 goals
            // 快照（cancelled + 非终止原因 → paused，与 instanceComposition 投影一致），
            // 使快照与 job 状态强一致，UI 不再滞后为「执行中」。
            transitionTaskInstanceProjection({
              goals,
              taskId: task.id,
              instanceId: instance.id,
              status: "paused",
              reason: timeoutReason,
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
                reason: timeoutReason,
                timeoutMs: DEFAULT_EASTER_EGG_SETTINGS.taskDefaultTimeoutMs,
              },
            });
          }
          if (instance.status === "awaiting_user" && nowMs - createdAtMs >= DEFAULT_EASTER_EGG_SETTINGS.taskHeartbeatTimeoutMs) {
            const ensured = ensureTaskNotificationStateFromInstance({
              goalId: goal.id,
              taskId: task.id,
              instance,
            });
            if (ensured.changed) heartbeats += 1;
          }
        }
      }
    }
  }
  return { paused, heartbeats };
}

export function runGoalDaemonSideEffects(goals: Goal[]) {
  const schedule = runGoalScheduleSynthesisWorker(goals);
  const composedGoals = composeGoalsWithRuntimeJobs(goals);
  const watchdog = runGoalWatchdogWorker(composedGoals);
  const notifications = runGoalNotificationDeliveryWorker(composedGoals);
  return {
    schedule,
    watchdog,
    notifications,
  };
}
