import assert from "node:assert/strict";

import { buildTimelineNodes } from "@/components/conversation/InlineCliProcessTimeline";
import type { CliProcessEvent } from "@/types/runtime";

function event(input: Partial<CliProcessEvent> & Pick<CliProcessEvent, "id" | "type" | "createdAt">, order: number) {
  return { ...input, order };
}

export function runInlineCliProcessTimelineSpecs() {
  const nodes = buildTimelineNodes([
    event({ id: "think-1", type: "thinking", createdAt: "2026-06-16T10:00:00.000Z", content: "plan" }, 0),
    event({
      id: "task-1",
      type: "tool_call",
      createdAt: "2026-06-16T10:00:01.000Z",
      toolName: "Task",
      input: { description: "Tesla 现状与前景研究", subagent_type: "explorer" },
      subagentCallId: "call-1",
    }, 1),
    event({
      id: "task-2",
      type: "tool_call",
      createdAt: "2026-06-16T10:00:01.000Z",
      toolName: "Task",
      input: { description: "SpaceX 现状与前景研究", subagent_type: "explorer" },
      subagentCallId: "call-2",
    }, 2),
    event({
      id: "sub-1",
      type: "subagent_event",
      createdAt: "2026-06-16T10:00:02.000Z",
      title: "子代理调用工具：WebSearch",
      agentId: "agent-tesla",
      eventKind: "tool_call",
      subagentCallId: "call-1",
    }, 3),
    event({
      id: "sub-2",
      type: "subagent_event",
      createdAt: "2026-06-16T10:00:02.000Z",
      title: "子代理调用工具：WebSearch",
      agentId: "agent-spacex",
      eventKind: "tool_call",
      subagentCallId: "call-2",
    }, 4),
    event({ id: "tool-1", type: "tool_call", createdAt: "2026-06-16T10:00:03.000Z", toolName: "Read" }, 5),
  ]);

  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].kind, "event");
  assert.equal(nodes[1].kind, "subagent_group");
  assert.equal(nodes[2].kind, "event");

  const group = nodes[1];
  assert.equal(group.kind, "subagent_group");
  if (group.kind !== "subagent_group") return;
  assert.equal(group.children.length, 2);
  assert.deepEqual(group.children.map((child) => child.title), ["Tesla 现状与前景研究", "SpaceX 现状与前景研究"]);
  assert.deepEqual(group.children.map((child) => child.events.map((item) => item.agentId)), [["agent-tesla"], ["agent-spacex"]]);

  const separatedNodes = buildTimelineNodes([
    event({
      id: "task-a",
      type: "tool_call",
      createdAt: "2026-06-16T11:00:00.000Z",
      toolName: "Task",
      input: { description: "第一批子代理" },
      subagentCallId: "call-a",
    }, 0),
    event({ id: "read-between", type: "tool_call", createdAt: "2026-06-16T11:00:01.000Z", toolName: "Read" }, 1),
    event({
      id: "task-b",
      type: "tool_call",
      createdAt: "2026-06-16T11:00:02.000Z",
      toolName: "Task",
      input: { description: "第二批子代理" },
      subagentCallId: "call-b",
    }, 2),
  ]);

  assert.deepEqual(separatedNodes.map((node) => node.kind), ["subagent_group", "event", "subagent_group"]);
  assert.equal(separatedNodes[0].kind === "subagent_group" ? separatedNodes[0].children[0]?.title : "", "第一批子代理");
  assert.equal(separatedNodes[2].kind === "subagent_group" ? separatedNodes[2].children[0]?.title : "", "第二批子代理");
}

runInlineCliProcessTimelineSpecs();
