"use client";

import { cancelGoalInstance, GoalCommandError } from "@/lib/api/goal-commands";
import { startTaskRun, TaskRunApiError, waitForTaskRunCompletion } from "@/lib/api/taskRuns";
import { useGoalStore } from "@/stores/goalStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { Goal, Task, TaskInstance } from "@/types/kiki";

type TaskExecutionAction = "start" | "pause" | "resume" | "rerun";

export function canStopTaskInstance(instance: TaskInstance) {
  return instance.status === "in_progress" || instance.status === "awaiting_user" || Boolean(instance.awaitingUser);
}

export async function runTaskExecutionAction(taskId: string, action: TaskExecutionAction, options?: { instanceId?: string }) {
  if (action === "pause") {
    const location = findTaskLocation(useGoalStore.getState().goals, taskId);
    if (!location) throw new Error("未找到对应任务。");
    const target = resolveTargetInstance(location.task, "pause", options?.instanceId);
    if (!target) throw new Error("未找到可停止的任务实例。");
    if (!canStopTaskInstance(target)) throw new Error("当前任务实例不在执行中。");
    await cancelGoalInstance({
      instanceId: target.id,
      reason: "用户暂停任务执行",
    });
    useGoalStore.getState().stopTaskInstanceRun(taskId, target.id);
    return;
  }

  const runtimeEnv = useRuntimeEnvStore.getState().getActiveEnvironment();
  if (!runtimeEnv || runtimeEnv.type !== "local") {
    throw new Error("当前没有连接本地 Runtime，请先到设置 -> 运行环境完成连接。");
  }
  if (runtimeEnv.health?.status !== "online") {
    throw new Error("当前本地 Runtime 离线，请先重新检测连接状态。");
  }

  const location = findTaskLocation(useGoalStore.getState().goals, taskId);
  if (!location) {
    throw new Error("未找到对应任务。");
  }

  let current = location;
  let targetInstance = resolveTargetInstance(current.task, action, options?.instanceId);

  if (!targetInstance) {
    const created =
      action === "rerun"
        ? useGoalStore.getState().generateRerunInstance(taskId, new Date().toISOString())
        : useGoalStore.getState().generateInstance(taskId, new Date().toISOString());
    if (!created) {
      throw new Error("任务实例创建失败，请稍后重试。");
    }
    const refreshed = findTaskLocation(useGoalStore.getState().goals, taskId);
    if (!refreshed) {
      throw new Error("任务实例创建后未能重新定位任务。");
    }
    current = refreshed;
    targetInstance = current.task.instances.find((instance) => instance.id === created.id) ?? created;
  }

  try {
    const run = await startTaskRun({
      goal: current.goal,
      subGoal: current.subGoal,
      task: current.task,
      instance: targetInstance,
      runtimeEnv,
    });

    if (run.outcome === "awaiting_user") {
      useGoalStore.getState().syncTaskInstanceRun({
        taskId: current.task.id,
        instanceId: run.taskInstanceId,
        progress: run.progress,
        logs: [],
        trajectory: [],
        waitingReason: run.waitingReason,
      });
      return;
    }

    if (run.requestId) {
      useGoalStore.getState().startTaskInstanceRun({
        taskId: current.task.id,
        instanceId: run.taskInstanceId,
        requestId: run.requestId,
        runtimeEnvId: runtimeEnv.id,
        permissionMode: runtimeEnv.permissionMode,
        workingDirectory: run.workspacePath,
      });
    }

    if (run.outcome === "already_running") {
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
        useGoalStore.getState().syncTaskInstanceRun({
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
        useGoalStore.getState().syncTaskInstanceRun({
          taskId: current.task.id,
          instanceId: run.taskInstanceId,
          progress: result.progress,
          logs: result.logs,
          trajectory: result.trajectory,
          waitingReason: result.waitingReason,
        });
      })
      .catch((error) => {
        useGoalStore.getState().failTaskInstanceRun({
          taskId: current.task.id,
          instanceId: run.taskInstanceId,
          requestId,
          errorMessage: error instanceof Error ? error.message : "任务执行失败",
        });
        console.error("手动执行任务失败", error);
      });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "任务执行失败";
    if (error instanceof TaskRunApiError && error.status >= 400 && error.status < 500) {
      try {
        await cancelGoalInstance({
          instanceId: targetInstance.id,
          reason: errorMessage,
        });
        useGoalStore.getState().stopTaskInstanceRun(current.task.id, targetInstance.id);
      } catch (commandError) {
        if (!(commandError instanceof GoalCommandError && commandError.status === 409)) {
          useGoalStore.getState().failTaskInstanceRun({
            taskId: current.task.id,
            instanceId: targetInstance.id,
            errorMessage,
          });
        }
      }
    } else {
      useGoalStore.getState().failTaskInstanceRun({
        taskId: current.task.id,
        instanceId: targetInstance.id,
        errorMessage,
      });
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
