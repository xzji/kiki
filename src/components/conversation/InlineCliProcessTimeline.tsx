"use client";

import { AlertCircle, ChevronDown, Circle, FileText, Terminal } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CliProcessEvent, ConversationCliProcess } from "@/types/runtime";

type TimelineEvent = CliProcessEvent & {
  order: number;
};

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

function subagentInfo(event: CliProcessEvent) {
  const input = asRecord(event.input);
  const description = readFirstString(input, ["description", "task", "title", "name"]);
  const prompt = readFirstString(input, ["prompt", "query", "message"]);
  const agentType = readFirstString(input, ["subagent_type", "agentType", "agent_type"]);
  return {
    description: description || truncate(prompt, 80) || event.summary || "子代理",
    prompt,
    agentType,
  };
}

function eventTitle(event: CliProcessEvent) {
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
  if (isSubagentToolCall(event)) {
    const info = subagentInfo(event);
    return [info.agentType ? `类型：${info.agentType}` : "", event.summary || ""].filter(Boolean).join(" · ");
  }
  return event.summary || event.content || "";
}

function eventBadge(event: CliProcessEvent) {
  if (isSubagentToolCall(event)) return "子代理";
  if (event.type === "thinking") return "思考";
  if (event.type === "tool_call") return "工具";
  if (event.type === "error") return "错误";
  if (event.type === "file_artifact") return "附件";
  if (event.type === "output") return "输出";
  return event.type;
}

function eventIcon(event: CliProcessEvent) {
  if (event.type === "error") return <AlertCircle className="h-3.5 w-3.5" />;
  if (event.type === "file_artifact") return <FileText className="h-3.5 w-3.5" />;
  if (event.type === "tool_call") return <Terminal className="h-3.5 w-3.5" />;
  return <Circle className="h-3.5 w-3.5" />;
}

function shouldShowDetails(event: CliProcessEvent) {
  return Boolean(event.content || event.input !== undefined || isSubagentToolCall(event));
}

function detailText(event: CliProcessEvent) {
  if (event.type === "thinking") return "展开思考";
  if (isSubagentToolCall(event)) return "展开子代理";
  if (event.type === "tool_call") return "展开参数";
  return "展开";
}

function EventDetails({ event }: { event: CliProcessEvent }) {
  const isSubagent = isSubagentToolCall(event);
  const info = isSubagent ? subagentInfo(event) : null;
  return (
    <div className="ml-7 space-y-2 pb-2 pr-2">
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
  const isThinking = event.type === "thinking";
  return (
    <details className={cn("group/timeline pl-3", !isThinking && "border-l border-[#E5E7EB]")}>
      <summary
        className={cn(
          "flex cursor-pointer list-none items-start gap-2 marker:hidden select-none [&::-webkit-details-marker]:hidden",
          isThinking ? "py-1 text-[#6B7280]" : "py-1.5",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center",
            isThinking ? "text-[#8C9198]" : event.type === "error" ? "text-[#B42318]" : "text-[#8C9198]",
          )}
        >
          {eventIcon(event)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate text-[12px]", isThinking ? "font-medium text-[#6B7280]" : "font-semibold text-[#1F2328]")}>
              {eventTitle(event)}
            </span>
            <span className="shrink-0 rounded bg-[#F6F8FA] px-1.5 py-0.5 text-[10px] text-[#6B7280]">
              {eventBadge(event)}
            </span>
            <span className="shrink-0 text-[10px] text-[#8C9198]">{formatTime(event.createdAt)}</span>
            {hasDetails ? (
              <span className="shrink-0 text-[10px] text-[#8C9198] group-open/timeline:hidden">{detailText(event)}</span>
            ) : null}
          </span>
          {summary && !isThinking ? <span className="mt-1 block truncate text-[12px] text-[#4B5563]">{summary}</span> : null}
        </span>
        {hasDetails ? (
          <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0 text-[#8C9198] transition group-open/timeline:rotate-180" />
        ) : null}
      </summary>
      {hasDetails ? <EventDetails event={event} /> : null}
    </details>
  );
}

function countSubagents(events: CliProcessEvent[]) {
  return events.filter(isSubagentToolCall).length;
}

export function InlineCliProcessTimeline({ process }: { process: ConversationCliProcess }) {
  const events = normalizeEvents(process.events);
  if (!events.length) return null;
  const subagentCount = countSubagents(events);
  return (
    <div className="mt-3 max-w-3xl space-y-1 text-[12px]">
      <div className="flex items-center gap-2 text-[#6B7280]">
        <span className="font-medium text-[#374151]">执行过程</span>
        <span>{events.length} 条事件</span>
        {subagentCount ? <span>{subagentCount} 个子代理</span> : null}
      </div>
      <div className="space-y-1">
        {events.map((event) => (
          <TimelineEventCard key={`${event.id}:${event.order}`} event={event} />
        ))}
      </div>
    </div>
  );
}
