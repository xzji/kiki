"use client";

import { createIdempotencyKey, createOpaqueId } from "@/lib/opaqueIds";
import type { GoalEventRecord } from "@/types/goalEventLog";
import type { ExecutionKind, Goal, Task, TaskExpectedResult, TaskInstanceStatus } from "@/types/kiki";

export class GoalCommandError extends Error {
  constructor(
    public status: number,
    public reason: string,
  ) {
    super(reason);
    this.name = "GoalCommandError";
  }
}

type CommandResponse = {
  ok?: boolean;
  reason?: string;
  event?: GoalEventRecord;
  resumed?: boolean;
  goals?: Goal[];
  revision?: number;
};

type TaskCommandInput = {
  title: string;
  description?: string;
  expectedOutcome: string;
  expectedResult?: TaskExpectedResult;
  taskType: Task["taskType"];
  triggerRule: string;
  deadline?: string;
  executionKind: ExecutionKind;
};

type GoalStructureCommandResponse = {
  ok: true;
  event: GoalEventRecord;
  goals: Goal[];
  revision: number;
};

async function readCommandResponse(response: Response): Promise<CommandResponse> {
  try {
    return (await response.json()) as CommandResponse;
  } catch {
    return {};
  }
}

async function postCommand<T extends CommandResponse>(input: {
  url: string;
  body: unknown;
  idempotencyKey: string;
}): Promise<T> {
  if (!input.idempotencyKey) {
    throw new GoalCommandError(400, "缺少 Idempotency-Key");
  }
  const response = await fetch(input.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify(input.body),
  });
  const data = await readCommandResponse(response);
  if (!response.ok) {
    throw new GoalCommandError(response.status, data.reason || "任务命令执行失败");
  }
  return data as T;
}

export async function transitionGoalInstance(input: {
  instanceId: string;
  status: TaskInstanceStatus;
  reason?: string;
  idempotencyKey?: string;
}) {
  const idempotencyKey =
    input.idempotencyKey ?? createIdempotencyKey("instance.status_changed", input.instanceId, input.status);
  return postCommand<{ ok: true; event: GoalEventRecord }>({
    url: `/api/goals/instances/${input.instanceId}/transition`,
    body: {
      status: input.status,
      reason: input.reason,
    },
    idempotencyKey,
  });
}

export async function respondGoalInstance(input: {
  instanceId: string;
  responseId?: string;
  responseSummary?: string;
  approved?: boolean;
  fields?: Record<string, string>;
  idempotencyKey?: string;
}) {
  const responseId = input.responseId ?? createOpaqueId("idem");
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("instance.user_response", input.instanceId, responseId);
  return postCommand<{ ok: true; resumed: boolean; event: GoalEventRecord }>({
    url: `/api/goals/instances/${input.instanceId}/respond`,
    body: {
      responseId,
      responseSummary: input.responseSummary,
      approved: input.approved,
      fields: input.fields,
    },
    idempotencyKey,
  });
}

export async function cancelGoalInstance(input: {
  instanceId: string;
  reason?: string;
  mode?: "pause" | "terminate";
  idempotencyKey?: string;
}) {
  const idempotencyKey =
    input.idempotencyKey ??
    createIdempotencyKey("instance.status_changed.cancel", input.instanceId, input.mode ?? "terminate");
  return postCommand<{ ok: true; event: GoalEventRecord }>({
    url: `/api/goals/instances/${input.instanceId}/cancel`,
    body: {
      reason: input.reason,
      mode: input.mode,
    },
    idempotencyKey,
  });
}

export async function confirmGoalPlanCommand(input: {
  goalId: string;
  baseRevision?: number;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("goal.confirm_plan", input.goalId);
  return postCommand<GoalStructureCommandResponse>({
    url: "/api/goals/commands",
    body: {
      command: {
        type: "confirm_goal_plan",
        goalId: input.goalId,
      },
      baseRevision: input.baseRevision,
    },
    idempotencyKey,
  });
}

export async function createGoalCommand(input: { goal: Goal; baseRevision?: number; idempotencyKey?: string }) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("goal.create", input.goal.id);
  return postCommand<GoalStructureCommandResponse>({
    url: "/api/goals/commands",
    body: {
      command: {
        type: "create_goal",
        goal: input.goal,
      },
      baseRevision: input.baseRevision,
    },
    idempotencyKey,
  });
}

export async function requestGoalPlanRevisionCommand(input: {
  goalId: string;
  feedback: string;
  baseRevision?: number;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("goal.request_plan_revision", input.goalId, input.feedback);
  return postCommand<GoalStructureCommandResponse>({
    url: "/api/goals/commands",
    body: {
      command: {
        type: "request_goal_plan_revision",
        goalId: input.goalId,
        feedback: input.feedback,
      },
      baseRevision: input.baseRevision,
    },
    idempotencyKey,
  });
}

export async function createSubGoalCommand(input: {
  goalId: string;
  title: string;
  baseRevision?: number;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("goal.create_sub_goal", input.goalId, input.title);
  return postCommand<GoalStructureCommandResponse>({
    url: "/api/goals/commands",
    body: {
      command: {
        type: "create_sub_goal",
        goalId: input.goalId,
        title: input.title,
      },
      baseRevision: input.baseRevision,
    },
    idempotencyKey,
  });
}

export async function createGoalTaskCommand(input: {
  goalId: string;
  subGoalId: string;
  task: TaskCommandInput;
  baseRevision?: number;
  idempotencyKey?: string;
}) {
  const idempotencyKey =
    input.idempotencyKey ?? createIdempotencyKey("goal.create_task", input.goalId, input.subGoalId, input.task.title);
  return postCommand<GoalStructureCommandResponse>({
    url: "/api/goals/commands",
    body: {
      command: {
        type: "create_task",
        goalId: input.goalId,
        subGoalId: input.subGoalId,
        task: input.task,
      },
      baseRevision: input.baseRevision,
    },
    idempotencyKey,
  });
}

export async function updateGoalTaskCommand(input: {
  goalId: string;
  taskId: string;
  task: TaskCommandInput;
  baseRevision?: number;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("goal.update_task", input.goalId, input.taskId);
  return postCommand<GoalStructureCommandResponse>({
    url: "/api/goals/commands",
    body: {
      command: {
        type: "update_task",
        goalId: input.goalId,
        taskId: input.taskId,
        task: input.task,
      },
      baseRevision: input.baseRevision,
    },
    idempotencyKey,
  });
}

export async function deleteGoalTaskCommand(input: {
  goalId: string;
  taskId: string;
  baseRevision?: number;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("goal.delete_task", input.goalId, input.taskId);
  return postCommand<GoalStructureCommandResponse>({
    url: "/api/goals/commands",
    body: {
      command: {
        type: "delete_task",
        goalId: input.goalId,
        taskId: input.taskId,
      },
      baseRevision: input.baseRevision,
    },
    idempotencyKey,
  });
}

export async function deleteGoalsByConversationCommand(input: {
  conversationId: string;
  baseRevision?: number;
  idempotencyKey?: string;
}) {
  const idempotencyKey =
    input.idempotencyKey ?? createIdempotencyKey("goal.delete_by_conversation", input.conversationId);
  return postCommand<GoalStructureCommandResponse>({
    url: "/api/goals/commands",
    body: {
      command: {
        type: "delete_goals_by_conversation",
        conversationId: input.conversationId,
      },
      baseRevision: input.baseRevision,
    },
    idempotencyKey,
  });
}
