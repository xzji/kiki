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
    <details className="group/process rounded-xl border border-[#E5E7EB] bg-white" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-[12px] font-semibold text-[#1F2328] select-none marker:hidden [&::-webkit-details-marker]:hidden">
        <span>
          {title}
          {typeof count === "number" ? <span className="ml-1 text-[#8C9198]">({count})</span> : null}
        </span>
        <span className="inline-block h-[7px] w-[7px] -rotate-45 border-r-[1.5px] border-b-[1.5px] border-current text-[#8C9198] transition duration-150 group-open/process:rotate-45" />
      </summary>
      <div className="border-t border-[#F0F1F3] px-3 py-3">{children}</div>
    </details>
  );
}

function PromptSectionCard({ section }: { section: CliPromptSection }) {
  return (
    <details className="group/prompt rounded-lg border border-[#EEF0F3] bg-[#FAFBFC]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[12px] font-medium text-[#374151] select-none marker:hidden [&::-webkit-details-marker]:hidden">
        <span>{section.title}</span>
        <span className="rounded-full bg-white px-2 py-0.5 font-mono text-[10px] text-[#6B7280]">{section.kind}</span>
      </summary>
      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words border-t border-[#EEF0F3] px-3 py-2 font-mono text-[11px] leading-5 text-[#1F2328]">
        {section.content || "暂无内容"}
      </pre>
    </details>
  );
}

function EventCard({ event }: { event: CliProcessEvent }) {
  const isTool = event.type === "tool_call";
  return (
    <div className="rounded-lg border border-[#EEF0F3] bg-[#FAFBFC] px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-[#1F2328]">
            {event.title || event.summary || event.type}
          </div>
          <div className="mt-0.5 text-[10px] text-[#8C9198]">{formatTime(event.createdAt)}</div>
        </div>
        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 font-mono text-[10px] text-[#6B7280]">
          {event.type}
        </span>
      </div>
      {event.summary ? <div className="mt-2 text-[12px] leading-5 text-[#374151]">{event.summary}</div> : null}
      {event.content ? (
        <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-white px-2.5 py-2 font-mono text-[11px] leading-5 text-[#374151]">
          {event.content}
        </pre>
      ) : null}
      {isTool && event.input !== undefined ? (
        <details className="group/input mt-2">
          <summary className="cursor-pointer list-none text-[11px] text-[#6B7280] select-none marker:hidden hover:text-[#1F2328] [&::-webkit-details-marker]:hidden">
            <span className="group-open/input:hidden">展开 input JSON</span>
            <span className="hidden group-open/input:inline">收起 input JSON</span>
          </summary>
          <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-white px-2.5 py-2 font-mono text-[11px] leading-5 text-[#374151]">
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
      className="fixed bottom-6 right-6 z-30 flex h-12 w-12 items-center justify-center rounded-full border border-[#222]/30 bg-white text-[#1F2328] transition hover:border-[#111] hover:bg-[#F5F6F8]"
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
  const toolEvents = process?.events.filter((event) => event.type === "tool_call") ?? [];
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
      className="fixed inset-y-0 right-0 z-20 flex w-[400px] flex-col border-l border-[#E5E7EB] bg-[#F8F9FB]"
      aria-label="CLI 过程"
    >
      <div className="flex h-12 flex-none items-center justify-between border-b border-[#E5E7EB] bg-white px-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#1F2328]">
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-[#E5E7EB] bg-[#F5F6F8]">
            <Activity className="h-3.5 w-3.5 text-[#175CD3]" />
          </span>
          <span>CLI 过程</span>
        </div>
        <button
          type="button"
          aria-label="收起 CLI 过程"
          onClick={close}
          className="rounded-md p-1.5 text-[#6B7280] hover:bg-[#F5F6F8]"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {!process ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <Terminal className="mb-3 h-8 w-8 text-[#8C9198]" />
            <div className="text-sm font-semibold text-[#1F2328]">当前会话还没有可展示的 CLI 过程</div>
            <div className="mt-2 text-[12px] leading-5 text-[#6B7280]">发送一次普通对话后，这里会展示 Prompt、thinking、tool call 和输出。</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border border-[#E5E7EB] bg-white px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px] text-[#6B7280]">{process.runId}</div>
                  <div className="mt-1 text-[11px] text-[#8C9198]">{formatTime(process.startedAt)}</div>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    process.status === "error"
                      ? "bg-[#FEF2F2] text-[#B42318]"
                      : process.status === "running"
                        ? "bg-[#EEF4FF] text-[#175CD3]"
                        : "bg-[#F0FDF4] text-[#166534]",
                  )}
                >
                  {statusText(process.status)}
                </span>
              </div>
              {process.error ? <div className="mt-2 text-[12px] leading-5 text-[#B42318]">{process.error}</div> : null}
            </div>

            <Section title="Prompt" count={process.promptSections.length} defaultOpen>
              {process.promptSections.length ? (
                <div className="space-y-2">
                  {process.promptSections.map((section) => <PromptSectionCard key={section.id} section={section} />)}
                </div>
              ) : (
                <div className="text-[12px] text-[#8C9198]">等待 prompt 事件。</div>
              )}
            </Section>

            <Section title="Thinking" count={thinkingEvents.length}>
              {thinkingEvents.length ? (
                <div className="space-y-2">{thinkingEvents.map((event) => <EventCard key={event.id} event={event} />)}</div>
              ) : (
                <div className="text-[12px] text-[#8C9198]">本次未暴露 thinking。</div>
              )}
            </Section>

            <Section title="Assistant Trace" count={traceEvents.length}>
              {traceEvents.length ? (
                <div className="space-y-2">{traceEvents.map((event) => <EventCard key={event.id} event={event} />)}</div>
              ) : (
                <div className="text-[12px] text-[#8C9198]">暂无 assistant trace。</div>
              )}
            </Section>

            <Section title="Tool Calls" count={toolEvents.length}>
              {toolEvents.length ? (
                <div className="space-y-2">{toolEvents.map((event) => <EventCard key={event.id} event={event} />)}</div>
              ) : (
                <div className="text-[12px] text-[#8C9198]">暂无工具调用。</div>
              )}
            </Section>

            <Section title="Output" defaultOpen>
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#0F172A] px-3 py-2 font-mono text-[11px] leading-5 text-[#E2E8F0]">
                {process.output || "等待 CLI 输出。"}
              </pre>
            </Section>

            <Section title="Status" count={statusEvents.length}>
              {statusEvents.length ? (
                <div className="space-y-2">{statusEvents.map((event) => <EventCard key={event.id} event={event} />)}</div>
              ) : (
                <div className="text-[12px] text-[#8C9198]">暂无状态事件。</div>
              )}
            </Section>
          </div>
        )}
      </div>
    </aside>
  );
}
