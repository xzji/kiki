import assert from "node:assert/strict";

import { buildAssistantTimelineNodes } from "@/lib/assistantMessageTimeline";
import type { ConversationMessage } from "@/types/kiki";
import type { CliProcessEvent } from "@/types/runtime";

function statusEvent(input: Pick<CliProcessEvent, "id" | "createdAt"> & Partial<CliProcessEvent>): CliProcessEvent {
  return {
    type: "status",
    ...input,
  };
}

function permissionEvent(input: {
  id: string;
  createdAt: string;
  requestId: string;
  toolName?: string;
}): CliProcessEvent {
  return statusEvent({
    id: input.id,
    createdAt: input.createdAt,
    title: "等待工具授权",
    input: {
      toolPermissionRequest: {
        type: "tool_permission_request",
        requestId: input.requestId,
        runtimeEnvId: "runtime-spec",
        toolName: input.toolName ?? "mcp__tavily__tavily_search",
        suggestedRule: "mcp__tavily__*",
      },
    },
  });
}

function message(input: {
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  events?: CliProcessEvent[];
}): Extract<ConversationMessage, { kind: "text" }> {
  return {
    id: "msg-spec",
    kind: "text",
    role: "kiki",
    content: "最终回复",
    createdAt: input.createdAt ?? "2026-06-25T10:00:00.000Z",
    status: "done",
    cliProcess: {
      runId: "run-spec",
      status: "completed",
      startedAt: input.startedAt ?? "2026-06-25T10:00:00.000Z",
      finishedAt: input.finishedAt,
      promptSections: [],
      events: input.events ?? [],
      output: "最终回复",
    },
  };
}

export function runAssistantMessageTimelineSpecs() {
  const nodes = buildAssistantTimelineNodes(
    message({
      finishedAt: "2026-06-25T10:00:03.000Z",
      events: [
        statusEvent({
          id: "status-running",
          createdAt: "2026-06-25T10:00:00.500Z",
          title: "CLI 运行中",
        }),
        permissionEvent({
          id: "permission-1",
          createdAt: "2026-06-25T10:00:01.000Z",
          requestId: "req-1",
        }),
      ],
    }),
  );

  assert.deepEqual(
    nodes.map((node) => node.kind),
    ["tool_permission_request", "message_content"],
    "授权卡片应按发生时间排在最终回复上方",
  );

  const tieNodes = buildAssistantTimelineNodes(
    message({
      finishedAt: "2026-06-25T10:00:01.000Z",
      events: [
        permissionEvent({
          id: "permission-tie",
          createdAt: "2026-06-25T10:00:01.000Z",
          requestId: "req-tie",
        }),
      ],
    }),
  );

  assert.deepEqual(
    tieNodes.map((node) => node.kind),
    ["tool_permission_request", "message_content"],
    "同一时间戳下授权事件仍应优先于回复正文",
  );

  const plainNodes = buildAssistantTimelineNodes(
    message({
      events: [
        statusEvent({
          id: "status-only",
          createdAt: "2026-06-25T10:00:01.000Z",
          title: "CLI 运行中",
        }),
      ],
    }),
  );

  assert.deepEqual(plainNodes.map((node) => node.kind), ["message_content"]);
}
