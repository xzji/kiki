"use client";

import { Activity, AlertCircle, CheckCircle2, ChevronDown, Circle, FileText, Terminal } from "lucide-react";

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

function statusText(status: ConversationCliProcess["status"]) {
  if (status === "completed") return "已完成";
  if (status === "error") return "失败";
  if (status === "aborted") return "已中断";
  return "运行中";
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
  if (event.type === "assistant_trace") return "过程记录";
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
  if (isSubagentToolCall(event)) return "subagent";
  return event.type;
}

function eventIcon(event: CliProcessEvent) {
  if (event.type === "error") return <AlertCircle className="h-3.5 w-3.5" />;
  if (event.type === "file_artifact") return <FileText className="h-3.5 w-3.5" />;
  if (event.type === "status") return <Activity className="h-3.5 w-3.5" />;
  if (event.type === "tool_call") return <Terminal className="h-3.5 w-3.5" />;
  return <Circle className="h-3.5 w-3.5" />;
}

function shouldShowDetails(event: CliProcessEvent) {
  return Boolean(event.content || event.input !== undefined || isSubagentToolCall(event));
}

function EventDetails({ event }: { event: CliProcessEvent }) {
  const isSubagent = isSubagentToolCall(event);
  const info = isSubagent ? subagentInfo(event) : null;
  return (
    <div className="space-y-2 border-t border-[#EEF0F3] px-3 py-2.5">
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
            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-white px-2.5 py-2 font-mono text-[11px] leading-5 text-[#374151]">
              {info.prompt}
            </pre>
          ) : null}
        </div>
      ) : null}
      {event.content ? (
        <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-white px-2.5 py-2 font-mono text-[11px] leading-5 text-[#374151]">
          {event.content}
        </pre>
      ) : null}
      {event.input !== undefined ? (
        <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-white px-2.5 py-2 font-mono text-[11px] leading-5 text-[#374151]">
          {JSON.stringify(event.input, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function TimelineEventCard({ event }: { event: TimelineEvent }) {
  const hasDetails = shouldShowDetails(event);
  const summary = eventSummary(event);
  return (
    <details
      className={cn(
        "group/timeline rounded-lg border bg-[#FAFBFC]",
        event.type === "error" ? "border-[#FFB4A8] bg-[#FFF7F5]" : "border-[#EEF0F3]",
      )}
    >
      <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2 marker:hidden select-none [&::-webkit-details-marker]:hidden">
        <span
          className={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border bg-white",
            event.type === "error" ? "border-[#FFB4A8] text-[#B42318]" : "border-[#D0D7DE] text-[#6B7280]",
          )}
        >
          {eventIcon(event)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[12px] font-semibold text-[#1F2328]">{eventTitle(event)}</span>
            <span className="shrink-0 rounded-full bg-white px-2 py-0.5 font-mono text-[10px] text-[#6B7280]">
              {eventBadge(event)}
            </span>
          </span>
          <span className="mt-0.5 block text-[10px] text-[#8C9198]">{formatTime(event.createdAt)}</span>
          {summary ? <span className="mt-1 block truncate text-[12px] text-[#4B5563]">{summary}</span> : null}
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
  const defaultOpen = process.status === "running";
  return (
    <details className="mt-3 max-w-3xl rounded-xl border border-[#E5E7EB] bg-white" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 marker:hidden select-none [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
              process.status === "error"
                ? "bg-[#FEF2F2] text-[#B42318]"
                : process.status === "running"
                  ? "bg-[#EEF4FF] text-[#175CD3]"
                  : "bg-[#F0FDF4] text-[#166534]",
            )}
          >
            {process.status === "completed" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
          </span>
          <span className="truncate text-[12px] font-semibold text-[#1F2328]">
            执行过程 · {statusText(process.status)} · {events.length} 条事件
            {subagentCount ? ` · ${subagentCount} 个子代理` : ""}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[#8C9198] transition group-open:rotate-180" />
      </summary>
      <div className="space-y-2 border-t border-[#F0F1F3] px-3 py-3">
        {events.map((event) => (
          <TimelineEventCard key={`${event.id}:${event.order}`} event={event} />
        ))}
      </div>
    </details>
  );
}
