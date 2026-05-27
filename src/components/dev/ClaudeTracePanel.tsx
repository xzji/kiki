"use client";

import { Copy, RefreshCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

type ClaudeTraceStatus = "running" | "completed" | "failed" | "aborted";

type ClaudeTraceSummary = {
  traceId: string;
  conversationId?: string;
  requestId?: string;
  scope?: string;
  phase?: string;
  stepLabel?: string;
  status: ClaudeTraceStatus;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  cwd: string;
  relativeTraceDir: string;
  errorMessage?: string;
};

type ClaudeTraceDetail = ClaudeTraceSummary & {
  prompt: string;
  stdout: string;
  stderr: string;
  thinking: string;
  output: string;
  parsedEvents: string;
};

type TraceTab = "prompt" | "thinking" | "output" | "raw" | "stderr" | "metadata";

const TABS: Array<{ id: TraceTab; label: string }> = [
  { id: "prompt", label: "Prompt" },
  { id: "thinking", label: "Thinking" },
  { id: "output", label: "Output" },
  { id: "raw", label: "Raw JSONL" },
  { id: "stderr", label: "stderr" },
  { id: "metadata", label: "Metadata" },
];

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function statusText(status: ClaudeTraceStatus) {
  if (status === "completed") return "已结束";
  if (status === "failed") return "失败";
  if (status === "aborted") return "已中断";
  return "运行中";
}

function traceTitle(trace: ClaudeTraceSummary) {
  return trace.stepLabel || trace.phase || trace.scope || trace.traceId;
}

function contentForTab(trace: ClaudeTraceDetail | null, tab: TraceTab) {
  if (!trace) return "";
  if (tab === "prompt") return trace.prompt;
  if (tab === "thinking") return trace.thinking || "Claude CLI 本次没有暴露 thinking 原文。";
  if (tab === "output") return trace.output;
  if (tab === "raw") return trace.stdout;
  if (tab === "stderr") return trace.stderr;
  return JSON.stringify(
    {
      traceId: trace.traceId,
      conversationId: trace.conversationId,
      requestId: trace.requestId,
      scope: trace.scope,
      phase: trace.phase,
      stepLabel: trace.stepLabel,
      status: trace.status,
      startedAt: trace.startedAt,
      finishedAt: trace.finishedAt,
      elapsedMs: trace.elapsedMs,
      cwd: trace.cwd,
      relativeTraceDir: trace.relativeTraceDir,
      errorMessage: trace.errorMessage,
      parsedEvents: trace.parsedEvents,
    },
    null,
    2,
  );
}

export function ClaudeTracePanel() {
  const [traces, setTraces] = useState<ClaudeTraceSummary[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClaudeTraceDetail | null>(null);
  const [tab, setTab] = useState<TraceTab>("prompt");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentContent = useMemo(() => contentForTab(detail, tab), [detail, tab]);

  const fetchTraces = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/dev/claude-traces?limit=80", { cache: "no-store" });
      if (!response.ok) throw new Error(`Trace 列表接口异常（${response.status}）`);
      const data = (await response.json()) as { traces?: ClaudeTraceSummary[] };
      const nextTraces = data.traces ?? [];
      setTraces(nextTraces);
      setSelectedTraceId((current) => current ?? nextTraces[0]?.traceId ?? null);
      setError(null);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Trace 列表加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchTraces();
    const timer = window.setInterval(() => void fetchTraces(), 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedTraceId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    const fetchDetail = async () => {
      setDetailLoading(true);
      try {
        const response = await fetch(`/api/dev/claude-traces/${encodeURIComponent(selectedTraceId)}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Trace 详情接口异常（${response.status}）`);
        const data = (await response.json()) as { trace?: ClaudeTraceDetail };
        if (!cancelled) setDetail(data.trace ?? null);
      } catch (fetchError) {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : "Trace 详情加载失败");
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };

    void fetchDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedTraceId]);

  const copyCurrent = async () => {
    if (!currentContent) return;
    await navigator.clipboard.writeText(currentContent);
  };

  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-white px-5 py-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-medium text-[#111]">Claude Trace</div>
          <div className="mt-1 text-[13px] text-[#6B7280]">
            查看 Claude CLI 真实 prompt、thinking、stdout、stderr 和最终 output 原文。
          </div>
        </div>
        <button
          type="button"
          onClick={() => void fetchTraces()}
          className="inline-flex items-center gap-2 rounded-lg border border-[#D0D7DE] px-3 py-2 text-[12px] font-medium text-[#374151] hover:border-[#111] hover:text-[#111]"
        >
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </button>
      </div>

      {error ? <div className="mt-3 text-[12px] text-[#B42318]">{error}</div> : null}

      <div className="mt-4 grid min-h-[520px] grid-cols-[280px_minmax(0,1fr)] gap-4">
        <div className="overflow-hidden rounded-xl border border-[#E5E7EB]">
          <div className="border-b border-[#E5E7EB] px-3 py-2 text-[12px] font-medium text-[#6B7280]">
            最近 Trace
          </div>
          <div className="max-h-[480px] overflow-y-auto">
            {traces.length === 0 ? (
              <div className="px-3 py-4 text-[12px] text-[#8C9198]">暂无 Claude Trace。触发一次 /goal 或普通对话后会出现在这里。</div>
            ) : (
              traces.map((trace) => (
                <button
                  key={trace.traceId}
                  type="button"
                  onClick={() => setSelectedTraceId(trace.traceId)}
                  className={cn(
                    "block w-full border-b border-[#F0F1F3] px-3 py-3 text-left hover:bg-[#FAFBFC]",
                    selectedTraceId === trace.traceId && "bg-[#F6F8FA]",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] font-medium text-[#111]">{traceTitle(trace)}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10px]",
                        trace.status === "failed"
                          ? "bg-[#FEF2F2] text-[#B42318]"
                          : trace.status === "running"
                            ? "bg-[#EEF4FF] text-[#175CD3]"
                            : "bg-[#F0FDF4] text-[#166534]",
                      )}
                    >
                      {statusText(trace.status)}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-[#6B7280]">{trace.traceId}</div>
                  <div className="mt-1 text-[11px] text-[#8C9198]">{formatTime(trace.startedAt)}</div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0 rounded-xl border border-[#E5E7EB]">
          <div className="flex items-center justify-between gap-3 border-b border-[#E5E7EB] px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-[#111]">
                {detail ? traceTitle(detail) : "未选择 Trace"}
              </div>
              {detail ? <div className="mt-1 truncate font-mono text-[11px] text-[#6B7280]">{detail.relativeTraceDir}</div> : null}
            </div>
            <button
              type="button"
              onClick={() => void copyCurrent()}
              disabled={!currentContent}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[#D0D7DE] px-3 py-2 text-[12px] text-[#374151] disabled:cursor-not-allowed disabled:opacity-40 hover:border-[#111] hover:text-[#111]"
            >
              <Copy className="h-3.5 w-3.5" />
              复制当前
            </button>
          </div>

          <div className="flex gap-1 border-b border-[#E5E7EB] px-3 py-2">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[12px]",
                  tab === item.id ? "bg-[#111] text-white" : "text-[#6B7280] hover:bg-[#F5F6F8] hover:text-[#111]",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <pre className="max-h-[430px] min-h-[430px] overflow-auto whitespace-pre-wrap break-words bg-[#0F172A] px-4 py-3 font-mono text-[11px] leading-5 text-[#E2E8F0]">
            {detailLoading ? "加载中..." : currentContent || "暂无内容"}
          </pre>
        </div>
      </div>
    </div>
  );
}

export function ClaudeTraceDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="relative w-[1120px] max-w-[94vw] rounded-2xl border border-[#E5E7EB] bg-white p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="关闭 Claude Trace"
          onClick={onClose}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8] hover:text-[#111]"
        >
          <X className="h-4 w-4" />
        </button>
        <ClaudeTracePanel />
      </div>
    </div>
  );
}
