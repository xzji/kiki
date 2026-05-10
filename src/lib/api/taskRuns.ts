import { sleep } from "@/lib/utils";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type { RuntimeEnvironment } from "@/types/runtime";

function createTaskRequestId() {
  return `goal-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function getTaskRunProgress(input: { requestId?: string; taskInstanceId?: string; signal?: AbortSignal }) {
  const search = new URLSearchParams();
  if (input.requestId) search.set("requestId", input.requestId);
  if (input.taskInstanceId) search.set("taskInstanceId", input.taskInstanceId);
  const response = await fetch(`/api/goals/tasks/progress?${search.toString()}`, {
    method: "GET",
    signal: input.signal,
    cache: "no-store",
  });
  if (!response.ok) {
    return { progress: null, logs: [] as GoalServerLogEntry[] };
  }
  return (await response.json()) as {
    progress: GoalServerProgress | null;
    logs: GoalServerLogEntry[];
  };
}

export async function startTaskRun(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance: TaskInstance;
  runtimeEnv: RuntimeEnvironment;
  signal?: AbortSignal;
}) {
  const requestId = createTaskRequestId();
  const response = await fetch("/api/goals/tasks/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goal-request-id": requestId,
    },
    body: JSON.stringify({
      goal: input.goal,
      subGoal: input.subGoal,
      task: input.task,
      instance: input.instance,
      runtimeEnv: input.runtimeEnv,
    }),
    signal: input.signal,
  });
  const data = (await response.json()) as { requestId?: string; reason?: string };
  if (!response.ok || !data.requestId) {
    throw new Error(data.reason || "任务执行启动失败");
  }
  return {
    requestId: data.requestId,
  };
}

export async function waitForTaskRunCompletion(input: {
  requestId: string;
  taskInstanceId: string;
  signal?: AbortSignal;
  onProgress?: (payload: { progress: GoalServerProgress | null; logs: GoalServerLogEntry[] }) => void;
}) {
  while (!input.signal?.aborted) {
    const state = await getTaskRunProgress({
      requestId: input.requestId,
      taskInstanceId: input.taskInstanceId,
      signal: input.signal,
    });
    input.onProgress?.(state);
    if (state.progress && state.progress.status !== "running") {
      return state;
    }
    await sleep(1000);
  }
  return { progress: null, logs: [] as GoalServerLogEntry[] };
}

export async function fetchTaskRunProgress(input: {
  requestId?: string;
  taskInstanceId: string;
  signal?: AbortSignal;
}) {
  return getTaskRunProgress(input);
}
