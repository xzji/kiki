"use client";

import { RefreshCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { GoalServerLogEntry, GoalServerProgress } from "@/types/goalTelemetry";

function useBackendLogs() {
  const [logs, setLogs] = useState<GoalServerLogEntry[]>([]);
  const [activeRequests, setActiveRequests] = useState<GoalServerProgress[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  const fetchLogs = async () => {
    setLogsLoading(true);
    try {
      const response = await fetch("/api/system/logs?limit=150", {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) {
        const message = `日志接口返回异常（${response.status}）`;
        setLogsError(message);
        return {
          ok: false as const,
          message,
        };
      }
      const data = (await response.json()) as {
        logs?: GoalServerLogEntry[];
        activeRequests?: GoalServerProgress[];
      };
      setLogs(data.logs ?? []);
      setActiveRequests(data.activeRequests ?? []);
      setLogsError(null);
      return {
        ok: true as const,
        message: "日志已刷新",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      const nextMessage = `日志接口暂时不可用：${message}`;
      setLogsError(nextMessage);
      return {
        ok: false as const,
        message: nextMessage,
      };
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    void fetchLogs();
    const timer = window.setInterval(() => {
      void fetchLogs();
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  return {
    logs,
    activeRequests,
    logsLoading,
    logsError,
    fetchLogs,
  };
}

function formatRealWorldTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function BackendLogsPanel() {
  const { logs, activeRequests, logsLoading, logsError, fetchLogs } = useBackendLogs();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const orderedLogs = useMemo(() => [...logs].reverse(), [logs]);
  const [refreshFeedback, setRefreshFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [orderedLogs]);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const handleManualRefresh = async () => {
    const result = await fetchLogs();
    if (!result) return;

    setRefreshFeedback({
      tone: result.ok ? "success" : "error",
      message: result.ok ? "刷新成功" : `刷新失败：${result.message}`,
    });

    if (feedbackTimerRef.current) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      setRefreshFeedback(null);
      feedbackTimerRef.current = null;
    }, 2200);
  };

  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-white px-5 py-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[15px] font-medium text-[#111]">后端运行日志</div>
          <div className="mt-1 text-[13px] text-[#6B7280]">
            用于排查 /goal 规划和任务执行是否正常推进，可看到当前正在跑的阶段和最近日志。
          </div>
        </div>
        <div className="relative shrink-0">
          {refreshFeedback ? (
            <div
              className={cn(
                "absolute -top-11 right-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] shadow-sm",
                refreshFeedback.tone === "success"
                  ? "border border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]"
                  : "border border-[#FECACA] bg-[#FEF2F2] text-[#B42318]",
              )}
            >
              {refreshFeedback.message}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            className="inline-flex items-center gap-2 rounded-lg border border-[#D0D7DE] px-3 py-2 text-[12px] font-medium text-[#374151] hover:border-[#111] hover:text-[#111]"
          >
            <RefreshCcw className={cn("h-3.5 w-3.5", logsLoading && "animate-spin")} />
            刷新
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-[#E5E7EB] bg-[#FAFAFB] p-3">
        <div className="text-[12px] font-medium text-[#111]">运行中请求</div>
        {logsError ? <div className="mt-2 text-[12px] text-[#C2410C]">{logsError}</div> : null}
        {activeRequests.length === 0 ? (
          <div className="mt-2 text-[12px] text-[#6B7280]">当前没有正在执行的请求</div>
        ) : (
          <div className="mt-2 space-y-2">
            {activeRequests.map((item) => (
              <div key={item.requestId} className="rounded-lg border border-[#E5E7EB] bg-white px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-[#374151]">{item.requestId}</span>
                  <span className="rounded-full bg-[#EEF4FF] px-2 py-0.5 text-[11px] text-[#175CD3]">
                    {item.phase}
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-[#111]">{item.message}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        ref={scrollerRef}
        className="mt-4 max-h-64 overflow-y-auto rounded-xl border border-[#E5E7EB] bg-[#0F172A] px-3 py-2 font-mono text-[11px] text-[#E2E8F0]"
      >
        {orderedLogs.length === 0 ? (
          <div className="text-[#94A3B8]">暂无日志</div>
        ) : (
          <div className="space-y-1.5">
            {orderedLogs.map((entry) => (
              <div key={entry.id} className="leading-5">
                <span className="text-[#94A3B8]">{formatRealWorldTime(entry.timestamp)}</span>{" "}
                <span
                  className={cn(
                    entry.level === "error"
                      ? "text-[#FCA5A5]"
                      : entry.level === "warn"
                        ? "text-[#FCD34D]"
                        : "text-[#93C5FD]",
                  )}
                >
                  [{entry.level}]
                </span>{" "}
                <span className="text-[#A7F3D0]">{entry.scope}</span>{" "}
                {entry.phase ? <span className="text-[#C4B5FD]">[{entry.phase}] </span> : null}
                <span>{entry.message}</span>
                {entry.details ? <span className="text-[#94A3B8]"> | {entry.details}</span> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function BackendLogsDialog({
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
        className="relative w-[880px] max-w-[92vw] rounded-2xl border border-[#E5E7EB] bg-white p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="关闭后端日志"
          onClick={onClose}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8] hover:text-[#111]"
        >
          <X className="h-4 w-4" />
        </button>
        <BackendLogsPanel />
      </div>
    </div>
  );
}
