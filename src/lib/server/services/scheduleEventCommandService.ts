import {
  readScheduleEventsSnapshot,
  upsertScheduleEventsSnapshot,
} from "@/lib/server/runtime/stateSnapshot";
import type { AgentEvent } from "@/types/schedule";

type CreateScheduleEventCommand = {
  type: "create_schedule_event";
  event: AgentEvent;
};

type UpdateScheduleEventCommand = {
  type: "update_schedule_event";
  event: AgentEvent;
};

type DeleteScheduleEventCommand = {
  type: "delete_schedule_event";
  id: string;
};

export type ScheduleEventCommand =
  | CreateScheduleEventCommand
  | UpdateScheduleEventCommand
  | DeleteScheduleEventCommand;

export type ScheduleEventCommandResult = {
  event?: AgentEvent;
  events: AgentEvent[];
  revision: number;
  updatedAt: string;
};

export class ScheduleEventCommandError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ScheduleEventCommandError";
  }
}

function writeEvents(events: AgentEvent[], event?: AgentEvent, expectedRevision?: number): ScheduleEventCommandResult {
  const result = upsertScheduleEventsSnapshot(events, expectedRevision);
  if (!result.ok) {
    throw new ScheduleEventCommandError(409, "schedule snapshot 已更新，请刷新后重试", {
      conflict: true,
      currentRevision: result.revision,
      expectedRevision,
      updatedAt: result.updatedAt,
    });
  }
  return {
    event,
    events,
    revision: result.revision,
    updatedAt: result.updatedAt,
  };
}

function readCurrentEvents() {
  return readScheduleEventsSnapshot([]);
}

export function applyScheduleEventCommand(
  command: ScheduleEventCommand,
  options: { expectedRevision?: number } = {},
): ScheduleEventCommandResult {
  const current = readCurrentEvents();

  if (command.type === "create_schedule_event") {
    if (current.some((event) => event.id === command.event.id)) {
      throw new ScheduleEventCommandError(409, "事件已存在，请通过更新流程修改");
    }
    const next = [...current, command.event];
    return writeEvents(next, command.event, options.expectedRevision);
  }

  if (command.type === "update_schedule_event") {
    if (!current.some((event) => event.id === command.event.id)) {
      throw new ScheduleEventCommandError(404, "未找到对应日程事件");
    }
    const next = current.map((event) => (event.id === command.event.id ? command.event : event));
    return writeEvents(next, command.event, options.expectedRevision);
  }

  if (!current.some((event) => event.id === command.id)) {
    throw new ScheduleEventCommandError(404, "未找到对应日程事件");
  }
  return writeEvents(current.filter((event) => event.id !== command.id), undefined, options.expectedRevision);
}
