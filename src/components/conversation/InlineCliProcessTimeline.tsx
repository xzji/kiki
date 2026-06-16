"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { CliProcessEvent, ConversationCliProcess } from "@/types/runtime";

type TimelineEvent = CliProcessEvent & {
  order: number;
};

type SubagentPanelModel = {
  key: string;
  groupKey: string;
  title: string;
  agentType?: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  anchor?: TimelineEvent;
  events: TimelineEvent[];
};

type TimelineNode =
  | { kind: "event"; event: TimelineEvent }
  | { kind: "subagent_group"; key: string; anchor: TimelineEvent; children: SubagentPanelModel[] };

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readFirstString(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) return "";
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return "";
}

function truncate(value: string, max = 120) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}...`;
}

function eventTimeValue(event: CliProcessEvent) {
  const value = +new Date(event.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function normalizeEvents(events: CliProcessEvent[]): TimelineEvent[] {
  return events
    .filter((event) => event.type !== "prompt" && event.type !== "status" && event.type !== "assistant_trace")
    .map((event, order) => ({ ...event, order }))
    .sort((a, b) => eventTimeValue(a) - eventTimeValue(b) || a.order - b.order);
}

function isSubagentToolCall(event: CliProcessEvent) {
  if (event.type !== "tool_call") return false;
  const toolName = event.toolName?.toLowerCase() ?? "";
  return toolName === "task" || toolName === "agent";
}

function isSubagentEvent(event: CliProcessEvent) {
  return event.type === "subagent_event";
}

function subagentGroupKey(event: CliProcessEvent) {
  if (event.subagentCallId) return event.subagentCallId;
  if (isSubagentToolCall(event)) return event.id;
  if (event.agentId) return event.agentId;
  return event.id;
}

function subagentInfo(event: CliProcessEvent) {
  const input = asRecord(event.input);
  const description = readFirstString(input, ["description", "task", "title", "name"]);
  const prompt = readFirstString(input, ["prompt", "query", "message"]);
  const agentType = readFirstString(input, ["subagent_type", "agentType", "agent_type"]);
  return {
    description: event.subagentDescription || description || truncate(prompt, 80) || event.summary || "子代理",
    prompt: event.subagentPrompt || prompt,
    agentType: event.subagentType || agentType,
  };
}

function eventTitle(event: CliProcessEvent) {
  if (isSubagentEvent(event)) return event.title || "子代理过程";
  if (isSubagentToolCall(event)) {
    return `调用子代理：${subagentInfo(event).description}`;
  }
  if (event.type === "thinking") return "思考";
  if (event.type === "tool_call") return `调用工具：${event.toolName || event.title || "Tool"}`;
  if (event.type === "status") return event.title || "状态更新";
  if (event.type === "error") return event.title || "任务失败";
  if (event.type === "file_artifact") return event.title || "生成附件";
  if (event.type === "prompt") return event.title || "Prompt 已发送";
  if (event.type === "output") return event.title || "输出";
  return event.title || event.type;
}

function eventSummary(event: CliProcessEvent) {
  if (isSubagentEvent(event)) return event.summary || "";
  if (isSubagentToolCall(event)) {
    const info = subagentInfo(event);
    return [info.agentType ? `类型：${info.agentType}` : "", event.summary || ""].filter(Boolean).join(" · ");
  }
  return event.summary || event.content || "";
}

function eventBadge(event: CliProcessEvent) {
  return event.type === "error" ? "失败" : null;
}

function shouldShowDetails(event: CliProcessEvent) {
  return Boolean(event.content || event.input !== undefined || isSubagentToolCall(event));
}

function statusText(status: SubagentPanelModel["status"]) {
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "运行中";
}

function eventHasError(event: CliProcessEvent) {
  return event.type === "error" || /error|fail|failed|失败/i.test(event.title || "");
}

function resolveSubagentStatus(events: TimelineEvent[]) {
  if (events.some(eventHasError)) return "failed";
  if (events.some((event) => event.eventKind === "completed")) return "completed";
  return "running";
}

function panelTitle(input: { key: string; anchor?: TimelineEvent; events: TimelineEvent[] }) {
  const fromAnchor = input.anchor ? subagentInfo(input.anchor).description : "";
  const fromEvent = input.events.map((event) => event.subagentDescription || "").find(Boolean);
  const agentId = input.events.map((event) => event.agentId || "").find(Boolean);
  return fromAnchor || fromEvent || (agentId ? `子代理 ${agentId.slice(0, 8)}` : "子代理");
}

function panelAgentType(input: { anchor?: TimelineEvent; events: TimelineEvent[] }) {
  const fromAnchor = input.anchor ? subagentInfo(input.anchor).agentType : "";
  return fromAnchor || input.events.map((event) => event.subagentType || "").find(Boolean) || "";
}

export function buildTimelineNodes(events: TimelineEvent[]): TimelineNode[] {
  const panels = new Map<string, SubagentPanelModel>();
  const normalEvents: TimelineEvent[] = [];
  let currentSubagentGroupKey = "";

  for (const event of events) {
    if (isSubagentToolCall(event)) {
      const key = subagentGroupKey(event);
      const existing = panels.get(key);
      const panelEvents = existing?.events ?? [];
      const groupKey = existing?.groupKey || currentSubagentGroupKey || `subagents-${event.id}`;
      currentSubagentGroupKey = groupKey;
      panels.set(key, {
        key,
        groupKey,
        anchor: event,
        events: panelEvents,
        title: panelTitle({ key, anchor: event, events: panelEvents }),
        agentType: panelAgentType({ anchor: event, events: panelEvents }),
        status: resolveSubagentStatus(panelEvents),
        startedAt: event.createdAt,
      });
      continue;
    }

    if (isSubagentEvent(event)) {
      const key = subagentGroupKey(event);
      const existing = panels.get(key);
      const panelEvents = [...(existing?.events ?? []), event].sort((a, b) => eventTimeValue(a) - eventTimeValue(b) || a.order - b.order);
      panels.set(key, {
        key,
        groupKey: existing?.groupKey || `orphan-subagent-${key}`,
        anchor: existing?.anchor,
        events: panelEvents,
        title: panelTitle({ key, anchor: existing?.anchor, events: panelEvents }),
        agentType: panelAgentType({ anchor: existing?.anchor, events: panelEvents }),
        status: resolveSubagentStatus(panelEvents),
        startedAt: existing?.anchor?.createdAt || panelEvents[0]?.createdAt || event.createdAt,
      });
      continue;
    }

    currentSubagentGroupKey = "";
    normalEvents.push(event);
  }

  const subagentPanels = Array.from(panels.values()).sort(
    (a, b) => eventTimeValue({ createdAt: a.startedAt } as CliProcessEvent) - eventTimeValue({ createdAt: b.startedAt } as CliProcessEvent),
  );
  if (!subagentPanels.length) {
    return normalEvents.map((event) => ({ kind: "event", event }));
  }

  const groupedPanels = new Map<string, SubagentPanelModel[]>();
  for (const panel of subagentPanels) {
    groupedPanels.set(panel.groupKey, [...(groupedPanels.get(panel.groupKey) ?? []), panel]);
  }
  const nodes: TimelineNode[] = [
    ...normalEvents.map((event) => ({ kind: "event" as const, event })),
    ...Array.from(groupedPanels.entries()).map(([key, children]) => {
      const sortedChildren = [...children].sort(
        (a, b) => eventTimeValue({ createdAt: a.startedAt } as CliProcessEvent) - eventTimeValue({ createdAt: b.startedAt } as CliProcessEvent),
      );
      const firstAnchor = sortedChildren[0]?.anchor || sortedChildren[0]?.events[0];
      return {
        kind: "subagent_group" as const,
        key,
        anchor: firstAnchor || events[0],
        children: sortedChildren,
      };
    }),
  ];

  return nodes.sort((a, b) => {
    const aEvent = a.kind === "event" ? a.event : a.anchor;
    const bEvent = b.kind === "event" ? b.event : b.anchor;
    return eventTimeValue(aEvent) - eventTimeValue(bEvent) || aEvent.order - bEvent.order;
  });
}

function EventDetails({ event }: { event: CliProcessEvent }) {
  const isSubagent = isSubagentToolCall(event);
  const isSubProcess = isSubagentEvent(event);
  const info = isSubagent ? subagentInfo(event) : null;
  return (
    <div className="ml-3.5 space-y-2 pb-2 pr-2">
      {isSubProcess && event.agentId ? (
        <div className="text-[11px] text-[#8C9198]">agentId: {event.agentId}</div>
      ) : null}
      {isSubagent && info ? (
        <div className="space-y-1.5 text-[12px] leading-5 text-[#374151]">
          {info.agentType ? (
            <div>
              <span className="text-[#8C9198]">子代理类型：</span>
              {info.agentType}
            </div>
          ) : null}
          <div>
            <span className="text-[#8C9198]">描述：</span>
            {info.description}
          </div>
          {info.prompt ? (
            <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#F6F8FA] px-2.5 py-2 font-mono text-[11px] leading-5 text-[#374151]">
              {info.prompt}
            </pre>
          ) : null}
        </div>
      ) : null}
      {event.content ? (
        <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#F6F8FA] px-2.5 py-2 font-mono text-[11px] leading-5 text-[#374151]">
          {event.content}
        </pre>
      ) : null}
      {event.input !== undefined ? (
        <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#F6F8FA] px-2.5 py-2 font-mono text-[11px] leading-5 text-[#374151]">
          {JSON.stringify(event.input, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function TimelineEventCard({ event }: { event: TimelineEvent }) {
  const hasDetails = shouldShowDetails(event);
  const summary = eventSummary(event);
  const isThinking = event.type === "thinking" || (event.type === "subagent_event" && event.eventKind === "thinking");
  const badge = eventBadge(event);
  return (
    <details className={cn("group/timeline pl-3", !isThinking && "border-l border-[#E5E7EB]")}>
      <summary
        className={cn(
          "flex cursor-pointer list-none items-start gap-2 marker:hidden select-none [&::-webkit-details-marker]:hidden",
          isThinking ? "py-1 text-[#6B7280]" : "py-1.5",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate text-[12px]", isThinking ? "font-medium text-[#6B7280]" : "font-semibold text-[#1F2328]")}>
              {eventTitle(event)}
            </span>
            {badge ? (
              <span className="shrink-0 rounded bg-[#FFEBE9] px-1.5 py-0.5 text-[10px] font-medium text-[#B42318]">
                {badge}
              </span>
            ) : null}
            <span className="shrink-0 text-[10px] text-[#8C9198]">{formatTime(event.createdAt)}</span>
          </span>
          {summary && !isThinking && !hasDetails ? <span className="mt-1 block truncate text-[12px] text-[#4B5563]">{summary}</span> : null}
        </span>
        {hasDetails ? (
          <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-[#8C9198] transition group-open/timeline:rotate-90" />
        ) : null}
      </summary>
      {hasDetails ? <EventDetails event={event} /> : null}
    </details>
  );
}

function SubagentEventRow({ event }: { event: TimelineEvent }) {
  return <TimelineEventCard event={event} />;
}

function SubagentLogPanel({ panel }: { panel: SubagentPanelModel }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoFollow, setAutoFollow] = useState(true);

  useEffect(() => {
    if (!autoFollow || !scrollRef.current || panel.status !== "running") return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [autoFollow, panel.events.length, panel.status]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    setAutoFollow(node.scrollHeight - node.scrollTop - node.clientHeight <= 24);
  };

  return (
    <div className="pl-3">
      <div className="flex min-w-0 items-center gap-2 py-1">
        <span className="min-w-0 truncate text-[12px] font-semibold text-[#1F2328]">{panel.title}</span>
        {panel.agentType ? <span className="shrink-0 text-[10px] text-[#8C9198]">{panel.agentType}</span> : null}
        <span className="shrink-0 text-[10px] text-[#8C9198]">{statusText(panel.status)}</span>
        <span className="shrink-0 text-[10px] text-[#8C9198]">{formatTime(panel.startedAt)}</span>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="max-h-[220px] overflow-y-auto border-l border-[#E5E7EB] pr-1"
      >
        {panel.events.length ? (
          <div className="space-y-0.5">
            {panel.events.map((event) => (
              <SubagentEventRow key={`${event.id}:${event.order}`} event={event} />
            ))}
          </div>
        ) : panel.anchor ? (
          <EventDetails event={panel.anchor} />
        ) : (
          <div className="py-1.5 pl-3 text-[12px] text-[#8C9198]">等待子代理事件。</div>
        )}
      </div>
    </div>
  );
}

function SubagentGroupCard({ node }: { node: Extract<TimelineNode, { kind: "subagent_group" }> }) {
  const count = node.children.length;
  const title = count > 1 ? `调用子代理 ${count} 个并行任务` : `调用子代理：${node.children[0]?.title || "子代理"}`;
  const runningCount = node.children.filter((child) => child.status === "running").length;
  const summary = runningCount ? `${runningCount} 个运行中` : "子代理过程";

  return (
    <details className="group/timeline border-l border-[#E5E7EB] pl-3">
      <summary className="flex cursor-pointer list-none items-start gap-2 py-1.5 marker:hidden select-none [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[12px] font-semibold text-[#1F2328]">{title}</span>
            <span className="shrink-0 text-[10px] text-[#8C9198]">{formatTime(node.anchor.createdAt)}</span>
          </span>
          <span className="mt-1 block truncate text-[12px] text-[#4B5563]">{summary}</span>
        </span>
        <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-[#8C9198] transition group-open/timeline:rotate-90" />
      </summary>
      <div className="ml-3.5 space-y-3 pb-2 pr-2">
        {node.children.map((panel) => (
          <SubagentLogPanel key={panel.key} panel={panel} />
        ))}
      </div>
    </details>
  );
}

function countSubagents(events: CliProcessEvent[]) {
  const started = events.filter(isSubagentToolCall).length;
  const seen = new Set(events.filter(isSubagentEvent).map((event) => event.agentId).filter(Boolean));
  return Math.max(started, seen.size);
}

export function InlineCliProcessTimeline({ process }: { process: ConversationCliProcess }) {
  const events = normalizeEvents(process.events);
  if (!events.length) return null;
  const nodes = buildTimelineNodes(events);
  const subagentCount = countSubagents(events);
  return (
    <details className="group/process mb-3 max-w-3xl text-[12px]">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[#6B7280] marker:hidden select-none [&::-webkit-details-marker]:hidden">
        <span className="font-medium text-[#374151]">执行过程</span>
        <span>{events.length} 条事件</span>
        {subagentCount ? <span>{subagentCount} 个子代理</span> : null}
        <ChevronRight className="h-3.5 w-3.5 text-[#8C9198] transition group-open/process:rotate-90" />
      </summary>
      <div className="mt-2 space-y-1">
        {nodes.map((node) =>
          node.kind === "event" ? (
            <TimelineEventCard key={`${node.event.id}:${node.event.order}`} event={node.event} />
          ) : (
            <SubagentGroupCard key={node.key} node={node} />
          ),
        )}
      </div>
    </details>
  );
}
