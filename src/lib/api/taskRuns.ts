import { sleep } from "@/lib/utils";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";
import type { ExecutionTrajectoryStep } from "@/types/executionTrajectory";
import type { QuotedConversationMessageContext, RuntimeEnvironment } from "@/types/runtime";

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

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TaskRunApiError(
      response.status,
      `服务端返回异常（HTTP ${response.status}）：${text.slice(0, 200)}`,
    );
  }
}

async function getTaskRunProgress(input: { requestId?: string; taskInstanceId?: string; signal?: AbortSignal }) {
  if (input.taskInstanceId) {
    const search = new URLSearchParams();
    if (input.requestId) search.set("requestId", input.requestId);
    const response = await fetch(`/api/goals/instances/${encodeURIComponent(input.taskInstanceId)}/runtime?${search.toString()}`, {
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
  return { progress: null, logs: [] as GoalServerLogEntry[], trajectory: [] as ExecutionTrajectoryStep[], waitingReason: undefined };
}

export async function startTaskRun(input: {
  goal: Goal;
  subGoal: SubGoal;
  task: Task;
  instance?: TaskInstance;
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
  const data = await parseJsonResponse<{
    outcome?: "queued" | "awaiting_user" | "already_running" | "blocked_config";
    requestId?: string;
    taskInstanceId?: string;
    workspacePath?: string;
    reason?: string;
    blockers?: Array<{ message?: string; reason?: string }>;
    progress?: GoalServerProgress | null;
    waitingReason?: string;
    goals?: Goal[];
    revision?: number;
  }>(response);
  if (!response.ok || data.outcome === "blocked_config") {
    const blockerMessage = data.blockers?.[0]?.message || data.blockers?.[0]?.reason;
    throw new TaskRunApiError(response.status, blockerMessage || data.reason || "任务执行启动失败");
  }
  const taskInstanceId = data.taskInstanceId ?? input.instance?.id;
  if (!taskInstanceId) {
    throw new TaskRunApiError(response.status, data.reason || "任务执行启动失败：缺少 taskInstanceId");
  }
  if (data.outcome === "awaiting_user") {
    return {
      outcome: "awaiting_user" as const,
      requestId: data.requestId,
      taskInstanceId,
      goals: data.goals,
      revision: data.revision,
      workspacePath: data.workspacePath,
      progress: data.progress ?? null,
      waitingReason: data.waitingReason,
    };
  }
  if (data.outcome === "already_running") {
    return {
      outcome: "already_running" as const,
      requestId: data.requestId,
      taskInstanceId,
      goals: data.goals,
      revision: data.revision,
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
    taskInstanceId,
    goals: data.goals,
    revision: data.revision,
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

export async function cancelTaskRun(input: {
  requestId?: string;
  taskInstanceId: string;
}) {
  const response = await fetch(`/api/goals/instances/${encodeURIComponent(input.taskInstanceId)}/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `cancel:${input.taskInstanceId}:${input.requestId ?? "manual"}`,
    },
    body: JSON.stringify({
      reason: "用户手动停止任务执行",
    }),
  });
  const data = (await response.json()) as { reason?: string };
  if (!response.ok) {
    throw new Error(data.reason || "任务停止失败");
  }
  return getTaskRunProgress(input);
}

export async function resumeTaskRun(input: {
  taskInstanceId: string;
  resumeToken: string;
  approved: boolean;
  feedback?: string;
  action?: string;
  fields?: Record<string, string>;
}) {
  const response = await fetch(`/api/goals/instances/${encodeURIComponent(input.taskInstanceId)}/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `respond:${input.taskInstanceId}:${input.resumeToken}`,
    },
    body: JSON.stringify({
      responseId: input.resumeToken,
      responseSummary: input.feedback,
      approved: input.approved,
      fields: input.fields,
    }),
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
  quotedMessage?: QuotedConversationMessageContext;
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

export async function judgeConversationGovernance(input: {
  message: string;
  conversationId: string;
  runtimeEnv: RuntimeEnvironment;
  source: "assistant-sidebar" | "conversation";
  workspaceMode?: "conversation" | "task";
  taskRef?: {
    goalId: string;
    subGoalId: string;
    taskId: string;
    instanceId: string;
  };
  contextSnapshot?: {
    conversation: import("@/types/kiki").Conversation;
    goal?: import("@/types/kiki").Goal | null;
  };
  quotedMessage?: QuotedConversationMessageContext | null;
}) {
  const response = await fetch("/api/governance/judge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await response.json()) as {
    ok?: boolean;
    reason?: string;
    shouldHandle?: boolean;
    proposal?: {
      intent: string;
      supported: boolean;
      confirmLevel: "required" | "light";
      summary: string;
      diffs?: Array<{ field: string; before: string; after: string }>;
      payload?: {
        intent: string;
        taskRef?: {
          goalId: string;
          subGoalId: string;
          taskId: string;
          instanceId?: string;
        } | null;
        patch?: unknown;
        revisionHint?: string;
      };
    } | null;
  };
  if (!response.ok || !data.ok) {
    throw new Error(data.reason || "治理意图判断失败");
  }
  return data;
}

export async function applyConversationGovernance(input: {
  conversationId: string;
  intent: string;
  taskRef: {
    goalId: string;
    subGoalId: string;
    taskId: string;
    instanceId?: string;
  };
  patch?: unknown;
  revisionHint?: string;
  userMessage: string;
  runtimeEnv?: RuntimeEnvironment;
  quotedMessage?: QuotedConversationMessageContext | null;
  idempotencyKey: string;
}) {
  const response = await fetch("/api/governance/apply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify(input),
  });
  const data = (await response.json()) as {
    ok?: boolean;
    reason?: string;
    unsupported?: boolean;
    assistantMessage?: string;
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
  if (!response.ok || !data.ok) {
    throw new Error(data.reason || "治理命令执行失败");
  }
  return data;
}
