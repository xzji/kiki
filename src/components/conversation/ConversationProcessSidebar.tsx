"use client";

import { Activity, PanelRightClose, Terminal } from "lucide-react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useConversationStore } from "@/stores/conversationStore";
import { useConversationProcessSidebarStore } from "@/stores/conversationProcessSidebarStore";
import type { CliProcessEvent, CliPromptSection, ConversationCliProcess } from "@/types/runtime";

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

function isSubagentToolCall(event: CliProcessEvent) {
  if (event.type !== "tool_call") return false;
  const toolName = event.toolName?.toLowerCase() ?? "";
  return toolName === "task" || toolName === "agent";
}

function currentConversationId(pathname: string | null) {
  if (!pathname) return null;
  const match = pathname.match(/^\/conversations\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function Section({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group/process rounded-xl border border-line bg-white" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-[12px] font-semibold text-ink select-none marker:hidden [&::-webkit-details-marker]:hidden">
        <span>
          {title}
          {typeof count === "number" ? <span className="ml-1 text-ink-faint">({count})</span> : null}
        </span>
        <span className="inline-block h-[7px] w-[7px] -rotate-45 border-r-[1.5px] border-b-[1.5px] border-current text-ink-faint transition duration-150 group-open/process:rotate-45" />
      </summary>
      <div className="border-t border-surface-subtle px-3 py-3">{children}</div>
    </details>
  );
}

function PromptSectionCard({ section }: { section: CliPromptSection }) {
  return (
    <details className="group/prompt rounded-lg border border-surface-subtle bg-surface-subtle">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[12px] font-medium text-ink-strong select-none marker:hidden [&::-webkit-details-marker]:hidden">
        <span>{section.title}</span>
        <span className="rounded-full bg-white px-2 py-0.5 font-mono text-[10px] text-ink-soft">{section.kind}</span>
      </summary>
      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words border-t border-surface-subtle px-3 py-2 font-mono text-[11px] leading-5 text-ink">
        {section.content || "暂无内容"}
      </pre>
    </details>
  );
}

function EventCard({ event }: { event: CliProcessEvent }) {
  const isTool = event.type === "tool_call";
  return (
    <div className="rounded-lg border border-surface-subtle bg-surface-subtle px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-ink">
            {event.title || event.summary || event.type}
          </div>
          <div className="mt-0.5 text-[10px] text-ink-faint">{formatTime(event.createdAt)}</div>
        </div>
        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 font-mono text-[10px] text-ink-soft">
          {event.type}
        </span>
      </div>
      {event.summary ? <div className="mt-2 text-[12px] leading-5 text-ink-strong">{event.summary}</div> : null}
      {event.content ? (
        <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-white px-2.5 py-2 font-mono text-[11px] leading-5 text-ink-strong">
          {event.content}
        </pre>
      ) : null}
      {isTool && event.input !== undefined ? (
        <details className="group/input mt-2">
          <summary className="cursor-pointer list-none text-[11px] text-ink-soft select-none marker:hidden hover:text-ink [&::-webkit-details-marker]:hidden">
            <span className="group-open/input:hidden">展开 input JSON</span>
            <span className="hidden group-open/input:inline">收起 input JSON</span>
          </summary>
          <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-white px-2.5 py-2 font-mono text-[11px] leading-5 text-ink-strong">
            {JSON.stringify(event.input, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function useSelectedProcess() {
  const pathname = usePathname();
  const conversationId = currentConversationId(pathname);
  const conversation = useConversationStore((state) =>
    state.conversations.find((item) => item.id === conversationId),
  );
  return useMemo(() => {
    const messages = conversation?.messages ?? [];
    const processMessages = messages.filter(
      (message) => message.role === "kiki" && "cliProcess" in message && message.cliProcess,
    );
    const running = [...processMessages].reverse().find(
      (message) => "cliProcess" in message && message.cliProcess?.status === "running",
    );
    const selected = running ?? processMessages.at(-1);
    return selected && "cliProcess" in selected ? selected.cliProcess ?? null : null;
  }, [conversation?.messages]);
}

export function ConversationProcessFab() {
  const { hydrated, isOpen, hydrate, open } = useConversationProcessSidebarStore();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    hydrate();
  }, [hydrate]);

  if (!mounted || !hydrated || isOpen) return null;

  return (
    <button
      type="button"
      aria-label="打开 CLI 过程"
      onClick={open}
        className="fixed bottom-6 right-6 z-30 hidden h-12 w-12 items-center justify-center rounded-full border border-[#222]/30 bg-white text-ink transition hover:border-[#111] hover:bg-surface md:flex"
    >
      <Terminal className="h-5 w-5" />
    </button>
  );
}

export function ConversationProcessSidebar() {
  const { hydrated, isOpen, hydrate, close } = useConversationProcessSidebarStore();
  const process = useSelectedProcess();
  const scrollRef = useRef<HTMLDivElement>(null);
  const thinkingEvents = process?.events.filter((event) => event.type === "thinking") ?? [];
  const traceEvents = process?.events.filter((event) => event.type === "assistant_trace") ?? [];
  const toolEvents = process?.events.filter((event) => event.type === "tool_call" && !isSubagentToolCall(event)) ?? [];
  const subagentEvents = process?.events.filter((event) => isSubagentToolCall(event) || event.type === "subagent_event") ?? [];
  const statusEvents = process?.events.filter(
    (event) => event.type === "status" || event.type === "error" || event.type === "file_artifact" || event.type === "prompt",
  ) ?? [];

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!isOpen || process?.status !== "running" || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [isOpen, process?.events.length, process?.output, process?.status]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, isOpen]);

  if (!hydrated || !isOpen) return null;

  return (
    <aside
        className="fixed inset-0 z-40 flex h-dvh w-full flex-col border-l border-line bg-surface-hover md:inset-y-0 md:left-auto md:z-20 md:h-screen md:w-[400px]"
      aria-label="CLI 过程"
    >
      <div className="flex h-12 flex-none items-center justify-between border-b border-line bg-white px-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface">
            <Activity className="h-3.5 w-3.5 text-info-strong" />
          </span>
          <span>CLI 过程</span>
        </div>
        <button
          type="button"
          aria-label="收起 CLI 过程"
          onClick={close}
          className="rounded-md p-1.5 text-ink-soft hover:bg-surface"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 md:pb-3">
        {!process ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <Terminal className="mb-3 h-8 w-8 text-ink-faint" />
            <div className="text-sm font-semibold text-ink">当前会话还没有可展示的 CLI 过程</div>
            <div className="mt-2 text-[12px] leading-5 text-ink-soft">发送一次普通对话后，这里会展示 Prompt、thinking、tool call 和输出。</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border border-line bg-white px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px] text-ink-soft">{process.runId}</div>
                  <div className="mt-1 text-[11px] text-ink-faint">{formatTime(process.startedAt)}</div>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    process.status === "error"
                      ? "bg-danger-bg text-danger-hover"
                      : process.status === "running"
                        ? "bg-info-bg text-info-strong"
                        : "bg-success-bg text-success-strong",
                  )}
                >
                  {statusText(process.status)}
                </span>
              </div>
              {process.error ? <div className="mt-2 text-[12px] leading-5 text-danger-hover">{process.error}</div> : null}
            </div>

            <Section title="Prompt" count={process.promptSections.length} defaultOpen>
              {process.promptSections.length ? (
                <div className="space-y-2">
                  {process.promptSections.map((section) => <PromptSectionCard key={section.id} section={section} />)}
                </div>
              ) : (
                <div className="text-[12px] text-ink-faint">等待 prompt 事件。</div>
              )}
            </Section>

            <Section title="Thinking" count={thinkingEvents.length}>
              {thinkingEvents.length ? (
                <div className="space-y-2">{thinkingEvents.map((event) => <EventCard key={event.id} event={event} />)}</div>
              ) : (
                <div className="text-[12px] text-ink-faint">本次未暴露 thinking。</div>
              )}
            </Section>

            <Section title="Assistant Trace" count={traceEvents.length}>
              {traceEvents.length ? (
                <div className="space-y-2">{traceEvents.map((event) => <EventCard key={event.id} event={event} />)}</div>
              ) : (
                <div className="text-[12px] text-ink-faint">暂无 assistant trace。</div>
              )}
            </Section>

            <Section title="Tool Calls" count={toolEvents.length}>
              {toolEvents.length ? (
                <div className="space-y-2">{toolEvents.map((event) => <EventCard key={event.id} event={event} />)}</div>
              ) : (
                <div className="text-[12px] text-ink-faint">暂无工具调用。</div>
              )}
            </Section>

            <Section title="Subagents" count={subagentEvents.length}>
              {subagentEvents.length ? (
                <div className="space-y-2">{subagentEvents.map((event) => <EventCard key={event.id} event={event} />)}</div>
              ) : (
                <div className="text-[12px] text-ink-faint">暂无子代理事件。</div>
              )}
            </Section>

            <Section title="Output" defaultOpen>
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ink-strong px-3 py-2 font-mono text-[11px] leading-5 text-line">
                {process.output || "等待 CLI 输出。"}
              </pre>
            </Section>

            <Section title="Status" count={statusEvents.length}>
              {statusEvents.length ? (
                <div className="space-y-2">{statusEvents.map((event) => <EventCard key={event.id} event={event} />)}</div>
              ) : (
                <div className="text-[12px] text-ink-faint">暂无状态事件。</div>
              )}
            </Section>
          </div>
        )}
      </div>
    </aside>
  );
}
