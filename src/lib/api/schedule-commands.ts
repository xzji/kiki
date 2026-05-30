"use client";

import { createIdempotencyKey } from "@/lib/opaqueIds";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { publishRuntimeStateChange } from "@/lib/runtimeStateChannel";
import { useScheduleStore } from "@/stores/scheduleStore";
import type { AgentEvent } from "@/types/schedule";

type ScheduleCommandResponse = {
  ok?: boolean;
  reason?: string;
  conflict?: boolean;
  currentRevision?: number;
  event?: AgentEvent;
  events?: AgentEvent[];
  revision?: number;
  updatedAt?: string;
};

export class ScheduleCommandError extends Error {
  constructor(
    public status: number,
    public reason: string,
    public conflict = false,
    public currentRevision?: number,
  ) {
    super(reason);
    this.name = "ScheduleCommandError";
  }
}

async function readCommandResponse(response: Response): Promise<ScheduleCommandResponse> {
  try {
    return (await response.json()) as ScheduleCommandResponse;
  } catch {
    return {};
  }
}

async function requestScheduleCommand(input: {
  url: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey: string;
}) {
  if (!input.idempotencyKey) {
    throw new ScheduleCommandError(400, "缺少 Idempotency-Key");
  }
  const expectedRevision = useScheduleStore.getState().projectionRevision;
  const body =
    input.body === undefined
      ? { expectedRevision }
      : { ...(input.body as Record<string, unknown>), expectedRevision };
  const response = await fetch(input.url, {
    method: input.method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
      "If-Match": String(expectedRevision),
    },
    body: JSON.stringify(body),
  });
  const data = await readCommandResponse(response);
  if (!response.ok) {
    if (data.conflict) {
      const snapshot = await fetchRuntimeStateSnapshot();
      useScheduleStore
        .getState()
        .replaceEvents(snapshot.scheduleEvents, snapshot.meta?.revisions?.scheduleEvents);
    }
    throw new ScheduleCommandError(
      response.status,
      data.reason || "日程命令执行失败",
      Boolean(data.conflict),
      data.currentRevision,
    );
  }
  if (typeof data.revision === "number" && data.updatedAt) {
    publishRuntimeStateChange({
      kind: "scheduleEvents",
      revision: data.revision,
      updatedAt: data.updatedAt,
    });
  }
  return data as ScheduleCommandResponse & { ok: true; events: AgentEvent[] };
}

export async function createScheduleEventCommand(input: { event: AgentEvent; idempotencyKey?: string }) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("schedule_event.create", input.event.id);
  return requestScheduleCommand({
    url: "/api/schedule/events",
    method: "POST",
    body: { event: input.event },
    idempotencyKey,
  });
}

export async function updateScheduleEventCommand(input: { event: AgentEvent; idempotencyKey?: string }) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("schedule_event.update", input.event.id);
  return requestScheduleCommand({
    url: `/api/schedule/events/${input.event.id}`,
    method: "PATCH",
    body: { event: input.event },
    idempotencyKey,
  });
}

export async function deleteScheduleEventCommand(input: { id: string; idempotencyKey?: string }) {
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey("schedule_event.delete", input.id);
  return requestScheduleCommand({
    url: `/api/schedule/events/${input.id}`,
    method: "DELETE",
    idempotencyKey,
  });
}
