"use client";

import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { cancelGoalInstance } from "@/lib/api/goal-commands";
import { startTaskRun, TaskRunApiError, waitForTaskRunCompletion } from "@/lib/api/taskRuns";
import { createGeneratedInstance } from "@/lib/goalFactory";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { Goal, Task, TaskInstance } from "@/types/kiki";

type TaskExecutionAction = "start" | "pause" | "resume" | "rerun";

export function canStopTaskInstance(instance: TaskInstance) {
  return instance.status === "in_progress" || instance.status === "awaiting_user" || Boolean(instance.awaitingUser);
}

export async function runTaskExecutionAction(taskId: string, action: TaskExecutionAction, options?: { instanceId?: string }) {
  if (action === "pause") {
    const location = findTaskLocation(selectVisibleGoals(useGoalStore.getState()), taskId);
    if (!location) throw new Error("未找到对应任务。");
    const target = resolveTargetInstance(location.task, "pause", options?.instanceId);
    if (!target) throw new Error("未找到可停止的任务实例。");
    if (!canStopTaskInstance(target)) throw new Error("当前任务实例不在执行中。");
    await cancelGoalInstance({
      instanceId: target.id,
      reason: "用户暂停任务执行",
    });
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

  try {
    const run = await startTaskRun({
      goal: current.goal,
      subGoal: current.subGoal,
      task: current.task,
      instance: targetInstance,
      runtimeEnv,
    });
    if (run.goals) {
      useGoalStore.getState().applyGoalsProjection(run.goals, run.revision);
    }

    if (run.outcome === "awaiting_user") {
      ensureTaskInstanceProjection({
        task: current.task,
        taskInstanceId: run.taskInstanceId,
        targetInstance,
        status: "awaiting_user",
      });
      useGoalStore.getState().applyInstanceProgressProjection({
        taskId: current.task.id,
        instanceId: run.taskInstanceId,
        progress: run.progress,
        logs: [],
        trajectory: [],
        waitingReason: run.waitingReason,
      });
      return;
    }

    ensureTaskInstanceProjection({
      task: current.task,
      taskInstanceId: run.taskInstanceId,
      targetInstance,
      status: "in_progress",
    });

    if (run.outcome === "already_running" && !run.requestId) {
      await syncGoalsFromRuntimeSnapshot();
      return;
    }

    const requestId = run.requestId;
    if (!requestId) {
      throw new Error("任务执行启动失败：缺少 requestId");
    }
    void waitForTaskRunCompletion({
      requestId,
      taskInstanceId: run.taskInstanceId,
      onProgress: (payload) => {
        useGoalStore.getState().applyInstanceProgressProjection({
          taskId: current.task.id,
          instanceId: run.taskInstanceId,
          progress: payload.progress,
          logs: payload.logs,
          trajectory: payload.trajectory,
          waitingReason: payload.waitingReason,
        });
      },
    })
      .then((result) => {
        useGoalStore.getState().applyInstanceProgressProjection({
          taskId: current.task.id,
          instanceId: run.taskInstanceId,
          progress: result.progress,
          logs: result.logs,
          trajectory: result.trajectory,
          waitingReason: result.waitingReason,
        });
      })
      .catch((error) => {
        console.error("手动执行任务失败", error);
      });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "任务执行失败";
    if (error instanceof TaskRunApiError && error.status >= 400 && error.status < 500) {
      if (targetInstance) {
        await cancelGoalInstance({
          instanceId: targetInstance.id,
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

function getTaskInstance(taskId: string, instanceId: string) {
  return findTaskLocation(selectVisibleGoals(useGoalStore.getState()), taskId)?.task.instances.find((instance) => instance.id === instanceId);
}

function buildOptimisticTaskInstance(input: {
  task: Task;
  taskInstanceId: string;
  targetInstance?: TaskInstance;
  status: TaskInstance["status"];
}) {
  const createdAt = input.targetInstance?.createdAt ?? new Date().toISOString();
  const base = input.targetInstance ?? createGeneratedInstance(input.task, createdAt);
  const intro =
    input.targetInstance?.intro?.trim() || `用户手动发起执行“${input.task.title.replace(/^任务\d+：/, "")}”。`;
  const phase =
    input.status === "awaiting_user"
      ? "awaiting_user"
      : input.status === "in_progress"
        ? "running"
        : input.status === "completed"
          ? "completed"
          : input.status === "error"
            ? "failed"
            : input.status === "paused"
              ? "paused"
              : "queued";
  return {
    ...base,
    id: input.taskInstanceId,
    taskId: input.task.id,
    status: input.status,
    intro,
    createdAt,
    execution: {
      ...base.execution,
      phase,
      status: input.status,
      startedAt: input.status === "pending" ? base.execution?.startedAt : base.execution?.startedAt ?? createdAt,
      finishedAt: undefined,
      lastUpdatedAt: new Date().toISOString(),
    },
    awaitingUser: input.status === "awaiting_user" ? base.awaitingUser : undefined,
  } satisfies TaskInstance;
}

function ensureTaskInstanceProjection(input: {
  task: Task;
  taskInstanceId: string;
  targetInstance?: TaskInstance;
  status: TaskInstance["status"];
}) {
  const projected = getTaskInstance(input.task.id, input.taskInstanceId);
  if (projected && projected.status !== "pending") return;
  useGoalStore
    .getState()
    .upsertTaskInstanceProjection(input.task.id, buildOptimisticTaskInstance(input));
}

async function syncGoalsFromRuntimeSnapshot() {
  try {
    const snapshot = await fetchRuntimeStateSnapshot();
    useGoalStore.getState().applyGoalsProjection(snapshot.goals, snapshot.meta?.revisions?.goals);
  } catch (error) {
    console.warn("同步任务执行快照失败", error);
  }
}
