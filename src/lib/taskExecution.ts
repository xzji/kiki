"use client";

import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { cancelGoalInstance } from "@/lib/api/goal-commands";
import { startTaskRun, TaskRunApiError, waitForTaskRunCompletion } from "@/lib/api/taskRuns";
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
    await syncGoalsFromRuntimeSnapshot();

    if (run.outcome === "awaiting_user") {
      return;
    }

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

async function syncGoalsFromRuntimeSnapshot() {
  try {
    const snapshot = await fetchRuntimeStateSnapshot();
    useGoalStore.getState().applyGoalsProjection(snapshot.goals, snapshot.meta?.revisions?.goals);
  } catch (error) {
    console.warn("同步任务执行快照失败", error);
  }
}
