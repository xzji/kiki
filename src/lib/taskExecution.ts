"use client";

import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { transitionGoalInstance } from "@/lib/api/goal-commands";
import { createTaskRequestId, startTaskRun, TaskRunApiError, waitForTaskRunCompletion } from "@/lib/api/taskRuns";
import { createOpaqueId } from "@/lib/opaqueIds";
import { useEasterEggSettingsStore } from "@/stores/easterEggSettingsStore";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { RuntimeEnvironment } from "@/types/runtime";
import type { Goal, Task, TaskInstance } from "@/types/kiki";

type TaskExecutionAction = "start" | "pause" | "resume" | "rerun";
type TaskExecutionActionOptions = {
  instanceId?: string;
  onNotice?: (message: string) => void;
};

const CONCURRENCY_LIMIT_QUEUED_NOTICE = "当前最大同时执行的任务数已达上限，排队中";

export function canStopTaskInstance(instance: TaskInstance) {
  return instance.status === "in_progress" || instance.status === "awaiting_user" || Boolean(instance.awaitingUser);
}

export async function runTaskExecutionAction(taskId: string, action: TaskExecutionAction, options?: TaskExecutionActionOptions) {
  if (action === "pause") {
    const location = findTaskLocation(selectVisibleGoals(useGoalStore.getState()), taskId);
    if (!location) throw new Error("未找到对应任务。");
    const target = resolveTargetInstance(location.task, "pause", options?.instanceId);
    if (!target) throw new Error("未找到可停止的任务实例。");
    if (!canStopTaskInstance(target)) throw new Error("当前任务实例不在执行中。");
    await transitionGoalInstance({
      instanceId: target.id,
      status: "paused",
      reason: "用户暂停任务执行",
    });
    await syncGoalsFromRuntimeSnapshot();
    return;
  }

  const runtimeEnv = useRuntimeEnvStore.getState().getActiveEnvironment();
  if (!runtimeEnv || runtimeEnv.type !== "local") {
    throw new Error("当前没有连接本地 Runtime，请先到设置 -> 运行环境完成连接。");
  }
  if (runtimeEnv.health?.status !== "online") {
    throw new Error("当前本地 Runtime 离线，请先重新检测连接状态。");
  }

  const location = findTaskLocation(selectVisibleGoals(useGoalStore.getState()), taskId);
  if (!location) {
    throw new Error("未找到对应任务。");
  }

  const current = location;
  const targetInstance = resolveTargetInstance(current.task, action, options?.instanceId) ?? undefined;
  if (action === "resume" && !targetInstance) {
    throw new Error("未找到可继续执行的任务实例。");
  }

  const visibleGoals = selectVisibleGoals(useGoalStore.getState());
  const maxConcurrentTasks = useEasterEggSettingsStore.getState().getSettings().maxConcurrentTasks;
  const concurrencyLimitReached = countRunningTaskInstances(visibleGoals) >= maxConcurrentTasks;
  if (concurrencyLimitReached) {
    notifyTaskExecutionNotice(options?.onNotice, CONCURRENCY_LIMIT_QUEUED_NOTICE);
  }

  const requestId = createTaskRequestId();
  const optimisticRun = createOptimisticTaskRun({
    task: current.task,
    action,
    requestId,
    runtimeEnv,
    targetInstance,
    optimisticState: concurrencyLimitReached ? "queued" : "running",
  });
  const goalStore = useGoalStore.getState();
  goalStore.addOptimisticTaskRun(optimisticRun.overlay);

  try {
    const run = await startTaskRun({
      goal: current.goal,
      subGoal: current.subGoal,
      task: current.task,
      instance: optimisticRun.serverInstance,
      runtimeEnv,
      requestId,
      action,
    });
    if (run.goals) {
      useGoalStore.getState().applyGoalsProjection(run.goals, run.revision);
    }

    if (run.outcome === "awaiting_user") {
      useGoalStore.getState().removeOptimisticTaskRun(optimisticRun.overlay.id);
      return;
    }

    if (run.outcome === "already_completed") {
      useGoalStore.getState().removeOptimisticTaskRun(optimisticRun.overlay.id);
      await syncGoalsFromRuntimeSnapshot();
      return;
    }

    if (run.outcome === "already_running" || run.taskInstanceId !== optimisticRun.serverInstance.id) {
      useGoalStore.getState().removeOptimisticTaskRun(optimisticRun.overlay.id);
      await syncGoalsFromRuntimeSnapshot();
      if (!run.requestId) return;
    }

    const confirmedRequestId = run.requestId;
    if (!confirmedRequestId) {
      throw new Error("任务执行启动失败：缺少 requestId");
    }
    scheduleOptimisticRunReconcile(optimisticRun.overlay.id);
    void waitForTaskRunCompletion({
      requestId: confirmedRequestId,
      taskInstanceId: run.taskInstanceId,
      onProgress: (payload) => {
        void payload;
        void syncGoalsFromRuntimeSnapshot();
      },
    })
      .then(() => {
        void syncGoalsFromRuntimeSnapshot();
      })
      .catch((error) => {
        console.error("手动执行任务失败", error);
      });
  } catch (error) {
    useGoalStore.getState().removeOptimisticTaskRun(optimisticRun.overlay.id);
    const errorMessage = error instanceof Error ? error.message : "任务执行失败";
    if (error instanceof TaskRunApiError && error.status >= 400 && error.status < 500) {
      if (targetInstance) {
        await transitionGoalInstance({
          instanceId: targetInstance.id,
          status: "paused",
          reason: errorMessage,
        });
      }
    }
    throw error;
  }
}

function findTaskLocation(goals: Goal[], taskId: string) {
  for (const goal of goals) {
    for (const subGoal of goal.subGoals) {
      for (const task of subGoal.tasks) {
        if (task.id === taskId) {
          return { goal, subGoal, task };
        }
      }
    }
  }
  return null;
}

function resolveTargetInstance(task: Task, action: TaskExecutionAction, instanceId?: string): TaskInstance | null {
  if (instanceId) {
    return task.instances.find((instance) => instance.id === instanceId) ?? null;
  }
  if (action === "start") return null;
  if (action === "rerun") return null;
  const sorted = [...task.instances].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  if (action === "resume") return sorted.find((instance) => instance.status === "paused") ?? null;
  return null;
}

function countRunningTaskInstances(goals: Goal[]) {
  return goals.reduce(
    (goalCount, goal) =>
      goalCount +
      goal.subGoals.reduce(
        (subGoalCount, subGoal) =>
          subGoalCount +
          subGoal.tasks.reduce(
            (taskCount, task) =>
              taskCount +
              task.instances.filter(
                (instance) => instance.status === "in_progress" || instance.execution?.status === "in_progress",
              ).length,
            0,
          ),
        0,
      ),
    0,
  );
}

function notifyTaskExecutionNotice(onNotice: TaskExecutionActionOptions["onNotice"], message: string) {
  if (onNotice) {
    onNotice(message);
    return;
  }
  if (typeof window !== "undefined") {
    window.alert(message);
  }
}

function createOptimisticTaskRun(input: {
  task: Task;
  action: Exclude<TaskExecutionAction, "pause">;
  requestId: string;
  runtimeEnv: RuntimeEnvironment;
  targetInstance?: TaskInstance;
  optimisticState: "queued" | "running";
}) {
  const createdAt = new Date().toISOString();
  const baseInstance =
    input.action === "resume" && input.targetInstance
      ? input.targetInstance
      : createPendingManualInstance(input.task, createdAt, input.requestId, input.runtimeEnv.id);
  const optimisticInstance =
    input.optimisticState === "queued"
      ? toOptimisticQueuedInstance(baseInstance, input.task, createdAt, input.requestId, input.runtimeEnv.id)
      : toOptimisticRunningInstance(
          baseInstance,
          input.task,
          createdAt,
          input.requestId,
          input.runtimeEnv.id,
        );
  return {
    serverInstance: baseInstance,
    overlay: {
      id: `optimistic-run-${baseInstance.id}`,
      taskId: input.task.id,
      instance: optimisticInstance,
      requestId: input.requestId,
      createdAt,
    },
  };
}

function toOptimisticQueuedInstance(
  instance: TaskInstance,
  task: Task,
  queuedAt: string,
  requestId: string,
  runtimeEnvId?: string,
): TaskInstance {
  return {
    ...instance,
    status: "pending",
    intro: `用户手动发起执行“${task.title.replace(/^任务\d+：/, "")}”。`,
    runner: {
      ...instance.runner,
      requestId,
      runtimeEnvId,
      attemptCount: instance.runner?.attemptCount ?? 0,
      lastAttemptAt: queuedAt,
    },
    execution: {
      ...instance.execution,
      phase: "queued",
      status: "pending",
      startedAt: undefined,
      finishedAt: undefined,
      lastUpdatedAt: queuedAt,
    },
    awaitingUser: undefined,
    blocker: undefined,
    timeline: buildManualRunTimeline(task.id, queuedAt, "pending"),
  };
}

function createPendingManualInstance(
  task: Task,
  createdAt: string,
  requestId: string,
  runtimeEnvId?: string,
): TaskInstance {
  const date = new Date(createdAt);
  const dateLabel = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const title = task.title.replace(/^任务\d+：/, "");
  return {
    id: createOpaqueId("inst"),
    taskId: task.id,
    dateLabel,
    status: "pending",
    intro: `用户手动发起执行“${title}”。`,
    payload: { kind: "generic_result", summary: "" },
    createdAt,
    runner: {
      requestId,
      runtimeEnvId,
      attemptCount: 0,
      lastAttemptAt: createdAt,
    },
    execution: {
      phase: "queued",
      status: "pending",
      lastUpdatedAt: createdAt,
    },
    timeline: buildManualRunTimeline(task.id, createdAt, "pending"),
  };
}

function toOptimisticRunningInstance(
  instance: TaskInstance,
  task: Task,
  startedAt: string,
  requestId: string,
  runtimeEnvId?: string,
): TaskInstance {
  return {
    ...instance,
    status: "in_progress",
    intro: `用户手动发起执行“${task.title.replace(/^任务\d+：/, "")}”。`,
    runner: {
      ...instance.runner,
      requestId,
      runtimeEnvId,
      attemptCount: instance.runner?.attemptCount ?? 0,
      lastAttemptAt: startedAt,
    },
    execution: {
      ...instance.execution,
      phase: "running",
      status: "in_progress",
      startedAt: instance.execution?.startedAt ?? startedAt,
      finishedAt: undefined,
      lastUpdatedAt: startedAt,
    },
    awaitingUser: undefined,
    blocker: undefined,
    timeline: buildManualRunTimeline(task.id, startedAt, "running"),
  };
}

function buildManualRunTimeline(taskId: string, startedAt: string, status: "pending" | "running") {
  return [
    {
      id: `${taskId}-manual-started-${startedAt}`,
      title: "已发起执行",
      type: "phase" as const,
      status: "completed" as const,
      detail: "已收到执行请求，正在交给 Agent 处理。",
      startedAt,
      finishedAt: startedAt,
    },
    {
      id: `${taskId}-manual-running-${startedAt}`,
      title: "Agent 正在执行",
      type: "phase" as const,
      status,
      detail: status === "running" ? "任务已进入执行中状态。" : "任务已进入队列，等待 Agent 接手。",
      startedAt,
    },
  ];
}

function scheduleOptimisticRunReconcile(overlayId: string) {
  window.setTimeout(() => {
    const stillPending = useGoalStore.getState().optimisticTaskRuns.some((item) => item.id === overlayId);
    if (!stillPending) return;
    void syncGoalsFromRuntimeSnapshot();
  }, 4000);
}

async function syncGoalsFromRuntimeSnapshot() {
  try {
    const snapshot = await fetchRuntimeStateSnapshot();
    useGoalStore.getState().applyGoalsProjection(snapshot.goals, snapshot.meta?.revisions?.goals);
  } catch (error) {
    console.warn("同步任务执行快照失败", error);
  }
}
