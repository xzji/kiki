"use client";

import { createIdempotencyKey, createOpaqueId } from "@/lib/opaqueIds";
import type { GoalEventRecord } from "@/types/goalEventLog";
import type { TaskInstanceStatus } from "@/types/kiki";

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
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("instance.status_changed.cancel", input.instanceId);
  return postCommand<{ ok: true; event: GoalEventRecord }>({
    url: `/api/goals/instances/${input.instanceId}/cancel`,
    body: {
      reason: input.reason,
    },
    idempotencyKey,
  });
}
