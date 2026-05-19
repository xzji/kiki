import { sleep } from "@/lib/utils";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { RuntimeEnvironment } from "@/types/runtime";

function createTaskRequestId() {
  return `goal-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class TaskRunApiError extends Error {
  constructor(
    public status: number,
    public reason: string,
  ) {
    super(reason);
    this.name = "TaskRunApiError";
  }
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
    return { progress: null, logs: [] as GoalServerLogEntry[], trajectory: [] as ExecutionTrajectoryStep[], waitingReason: undefined as string | undefined };
  }
  return (await response.json()) as {
    progress: GoalServerProgress | null;
    logs: GoalServerLogEntry[];
    trajectory: ExecutionTrajectoryStep[];
    waitingReason?: string;
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
  const data = (await response.json()) as {
    outcome?: "queued" | "awaiting_user" | "already_running" | "blocked_config";
    requestId?: string;
    taskInstanceId?: string;
    workspacePath?: string;
    reason?: string;
    blockers?: Array<{ message?: string; reason?: string }>;
    progress?: GoalServerProgress | null;
    waitingReason?: string;
  };
  if (!response.ok || data.outcome === "blocked_config") {
    const blockerMessage = data.blockers?.[0]?.message || data.blockers?.[0]?.reason;
    throw new TaskRunApiError(response.status, blockerMessage || data.reason || "任务执行启动失败");
  }
  if (data.outcome === "awaiting_user") {
    return {
      outcome: "awaiting_user" as const,
      requestId: data.requestId,
      taskInstanceId: data.taskInstanceId ?? input.instance.id,
      workspacePath: data.workspacePath,
      progress: data.progress ?? null,
      waitingReason: data.waitingReason,
    };
  }
  if (data.outcome === "already_running") {
    return {
      outcome: "already_running" as const,
      requestId: data.requestId,
      taskInstanceId: data.taskInstanceId ?? input.instance.id,
      workspacePath: data.workspacePath,
      progress: data.progress ?? null,
      waitingReason: data.waitingReason,
    };
  }
  if (!data.requestId) {
    throw new TaskRunApiError(response.status, data.reason || "任务执行启动失败");
  }
  return {
    outcome: "queued" as const,
    requestId: data.requestId,
    taskInstanceId: data.taskInstanceId ?? input.instance.id,
    workspacePath: data.workspacePath,
    progress: data.progress ?? null,
    waitingReason: data.waitingReason,
  };
}

export async function waitForTaskRunCompletion(input: {
  requestId: string;
  taskInstanceId: string;
  signal?: AbortSignal;
  onProgress?: (payload: { progress: GoalServerProgress | null; logs: GoalServerLogEntry[]; trajectory: ExecutionTrajectoryStep[]; waitingReason?: string }) => void;
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
  return { progress: null, logs: [] as GoalServerLogEntry[], trajectory: [] as ExecutionTrajectoryStep[], waitingReason: undefined as string | undefined };
}

export async function fetchTaskRunProgress(input: {
  requestId?: string;
  taskInstanceId: string;
  signal?: AbortSignal;
}) {
  return getTaskRunProgress(input);
}

/** @deprecated 前端任务命令应使用 /api/goals/instances/:id/cancel。 */
export async function cancelTaskRun(input: {
  requestId?: string;
  taskInstanceId: string;
}) {
  const response = await fetch("/api/goals/tasks/cancel", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const data = (await response.json()) as {
    reason?: string;
    progress?: GoalServerProgress | null;
    logs?: GoalServerLogEntry[];
    trajectory?: ExecutionTrajectoryStep[];
    waitingReason?: string;
  };
  if (!response.ok) {
    throw new Error(data.reason || "任务停止失败");
  }
  return {
    progress: data.progress ?? null,
    logs: data.logs ?? [],
    trajectory: data.trajectory ?? [],
    waitingReason: data.waitingReason,
  };
}

/** @deprecated 前端任务命令应使用 /api/goals/instances/:id/respond。 */
export async function resumeTaskRun(input: {
  taskInstanceId: string;
  resumeToken: string;
  approved: boolean;
  feedback?: string;
  action?: string;
  fields?: Record<string, string>;
}) {
  const response = await fetch("/api/goals/tasks/resume", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const data = (await response.json()) as {
    reason?: string;
    progress?: GoalServerProgress | null;
    logs?: GoalServerLogEntry[];
    trajectory?: ExecutionTrajectoryStep[];
    waitingReason?: string;
  };
  if (!response.ok) {
    throw new Error(data.reason || "任务恢复失败");
  }
  return {
    progress: data.progress ?? null,
    logs: data.logs ?? [],
    trajectory: data.trajectory ?? [],
    waitingReason: data.waitingReason,
  };
}

export async function submitTaskResultFeedback(input: {
  conversationId: string;
  message: string;
  sourceMessageId?: string;
  feedbackId?: string;
  taskRef: {
    goalId: string;
    subGoalId: string;
    taskId: string;
    instanceId: string;
  };
  runtimeEnv?: RuntimeEnvironment;
}) {
  const response = await fetch("/api/goals/tasks/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const data = (await response.json()) as {
    reason?: string;
    decision?: "acknowledge" | "clarify" | "rerun";
    assistantMessage?: string;
    progress?: GoalServerProgress | null;
    logs?: GoalServerLogEntry[];
    trajectory?: ExecutionTrajectoryStep[];
    taskInstanceId?: string;
    taskCardMessage?: {
      content?: string;
      taskRef: {
        goalId: string;
        subGoalId: string;
        taskId: string;
        instanceId: string;
      };
      taskSnapshot?: {
        task: Task;
        instance: TaskInstance;
      };
    };
  };
  if (!response.ok) {
    throw new Error(data.reason || "任务反馈处理失败");
  }
  return {
    decision: data.decision ?? "clarify",
    assistantMessage: data.assistantMessage ?? "我已收到你对任务结果的反馈。",
    progress: data.progress ?? null,
    logs: data.logs ?? [],
    trajectory: data.trajectory ?? [],
    taskInstanceId: data.taskInstanceId,
    taskCardMessage: data.taskCardMessage,
  };
}
