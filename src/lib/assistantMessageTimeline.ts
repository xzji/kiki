import type { ConversationMessage } from "@/types/kiki";
import type { ClaudeStreamEvent, CliProcessEvent } from "@/types/runtime";

export type ToolPermissionRequestEvent = Extract<ClaudeStreamEvent, { type: "tool_permission_request" }>;

export type ToolPermissionTimelineItem = {
  request: ToolPermissionRequestEvent;
  createdAt: string;
  order: number;
};

export type AssistantTimelineNode =
  | { kind: "tool_permission_request"; key: string; item: ToolPermissionTimelineItem }
  | { kind: "message_content"; key: string; createdAt: string; order: number };

function getToolPermissionRequestFromEvent(input: unknown): ToolPermissionRequestEvent | null {
  if (!input || typeof input !== "object") return null;
  const candidate = (input as { toolPermissionRequest?: unknown }).toolPermissionRequest;
  if (!candidate || typeof candidate !== "object") return null;
  const request = candidate as Partial<ToolPermissionRequestEvent>;
  if (
    request.type !== "tool_permission_request" ||
    typeof request.requestId !== "string" ||
    typeof request.runtimeEnvId !== "string" ||
    typeof request.toolName !== "string" ||
    typeof request.suggestedRule !== "string"
  ) {
    return null;
  }
  return request as ToolPermissionRequestEvent;
}

function eventTimeValue(value: string | undefined) {
  const time = value ? +new Date(value) : 0;
  return Number.isFinite(time) ? time : 0;
}

function getToolPermissionTimelineItem(event: CliProcessEvent, order: number): ToolPermissionTimelineItem | null {
  const request = getToolPermissionRequestFromEvent(event.input);
  if (!request) return null;
  return {
    request,
    createdAt: event.createdAt,
    order,
  };
}

function getMessageContentTimelineAt(message: ConversationMessage) {
  if (message.kind !== "text" && message.kind !== "goal_plan_card") return message.createdAt;
  const process = message.cliProcess;
  if (!process) return message.createdAt;
  if (process.finishedAt) return process.finishedAt;
  return process.events.reduce((latest, event) => {
    return eventTimeValue(event.createdAt) > eventTimeValue(latest) ? event.createdAt : latest;
  }, process.startedAt || message.createdAt);
}

export function buildAssistantTimelineNodes(message: ConversationMessage): AssistantTimelineNode[] {
  if (message.kind !== "text" && message.kind !== "goal_plan_card") return [];
  const permissionNodes =
    message.cliProcess?.events
      .map((event, order) => getToolPermissionTimelineItem(event, order))
      .filter((item): item is ToolPermissionTimelineItem => Boolean(item))
      .map((item) => ({
        kind: "tool_permission_request" as const,
        key: `tool-permission-${item.request.requestId}-${item.order}`,
        item,
      })) ?? [];
  const nodes: AssistantTimelineNode[] = [
    ...permissionNodes,
    {
      kind: "message_content",
      key: "message-content",
      createdAt: getMessageContentTimelineAt(message),
      order: Number.MAX_SAFE_INTEGER,
    },
  ];
  return nodes.sort((a, b) => {
    const aTime = eventTimeValue(a.kind === "tool_permission_request" ? a.item.createdAt : a.createdAt);
    const bTime = eventTimeValue(b.kind === "tool_permission_request" ? b.item.createdAt : b.createdAt);
    if (aTime !== bTime) return aTime - bTime;
    const aOrder = a.kind === "tool_permission_request" ? a.item.order : a.order;
    const bOrder = b.kind === "tool_permission_request" ? b.item.order : b.order;
    return aOrder - bOrder;
  });
}
