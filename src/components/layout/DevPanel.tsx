"use client";

import { ChevronDown, FileText, Sparkles, TerminalSquare, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { formatClock, formatChineseDate } from "@/lib/date";
import { useVirtualClock } from "@/hooks/useVirtualClock";
import { seedToeflMockGoalPlanConversation } from "@/lib/devMockSessions";
import { resetLocalDevData } from "@/lib/api/runtime-daemon";
import { BackendLogsDialog } from "@/components/settings/BackendLogsPanel";
import { ClaudeTraceDialog } from "@/components/dev/ClaudeTracePanel";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { useNavSidebarStore } from "@/stores/navSidebarStore";

const RESET_LOCAL_STORAGE_KEYS = [
  "kiki.conversations",
  "kiki.conversations.migrated",
  "kiki.conversations.migrated.failed_at",
  "kiki.goal-events.cursor.v1",
  "kiki.runtime-event.metrics.v1",
  "kiki.task-monitor",
];

export function DevPanel() {
  const router = useRouter();
  const confirm = useConfirm();
  const { currentTime, advanceHours, jumpToTomorrowEleven } = useVirtualClock();
  const [expanded, setExpanded] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [claudeTraceOpen, setClaudeTraceOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const navCollapsed = useNavSidebarStore((state) => state.collapsed);

  // 和 UserMenu 使用同一套左偏移，让 Dev 按钮始终贴在头像正上方。
  const leftOffset = navCollapsed ? 14 : 28;

  useEffect(() => {
    if (!expanded || logsOpen || claudeTraceOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      setExpanded(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [expanded, logsOpen, claudeTraceOpen]);

  const handleResetLocalData = async () => {
    if (resetting) return;
    const confirmed = await confirm({
      title: "确认清空本地测试数据？",
      description:
        "该操作会停止 worker/Claude 进程并删除本地会话、执行记录、workspace、storage 和备份；保留 Runtime 配置与当前 Web 服务。",
      confirmLabel: "清空",
      variant: "danger",
    });
    if (!confirmed) return;

    setResetting(true);
    setResetMessage(null);
    try {
      const payload = await resetLocalDevData();
      for (const key of RESET_LOCAL_STORAGE_KEYS) {
        window.localStorage.removeItem(key);
      }
      const stopped = payload.result?.stoppedProcesses.length ?? 0;
      const deleted = payload.result?.deletedPaths.length ?? 0;
      setResetMessage(`已清空本地测试数据：停止 ${stopped} 个进程，删除 ${deleted} 项。`);
      router.refresh();
      window.location.href = "/";
    } catch (error) {
      setResetMessage(error instanceof Error ? error.message : "清空本地测试数据失败");
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <div
        ref={panelRef}
        className="fixed bottom-16 z-30"
        style={{ left: leftOffset }}
      >
        {expanded ? (
          <div className="absolute bottom-11 left-0 w-80 rounded-xl border border-line bg-white/95 p-4 shadow-sm backdrop-blur">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-ink-soft">Dev 演示浮层</div>
              <button
                type="button"
                aria-label="收起"
                onClick={() => setExpanded(false)}
                className="rounded p-1 text-ink-soft hover:bg-surface"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="text-sm font-semibold text-ink">{formatChineseDate(currentTime)}</div>
            <div className="mb-4 text-lg font-semibold text-[#111]">{formatClock(currentTime)}</div>
            <div className="grid gap-2">
              <div className="flex gap-2">
                <button className="flex-1 rounded-lg bg-[#111] px-3 py-2 text-xs text-white hover:bg-[#333]" onClick={() => advanceHours(1)}>
                  快进 1 小时
                </button>
                <button className="flex-1 rounded-lg border border-line-strong px-3 py-2 text-xs text-[#111] hover:bg-surface" onClick={jumpToTomorrowEleven}>
                  跳到明早 11:00
                </button>
              </div>
              <button
                type="button"
                onClick={() => setLogsOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2 text-xs text-ink-strong hover:border-[#111] hover:bg-surface hover:text-[#111]"
              >
                <FileText className="h-3.5 w-3.5" />
                后端日志
              </button>
              <button
                type="button"
                onClick={() => setClaudeTraceOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2 text-xs text-ink-strong hover:border-[#111] hover:bg-surface hover:text-[#111]"
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                Claude Trace
              </button>
              <div className="mt-2 rounded-lg border border-dashed border-line-strong bg-surface-subtle p-3">
                <div className="text-[11px] font-medium text-ink-soft">目标规划 Mock</div>
                <div className="mt-1 text-[11px] leading-5 text-ink-faint">
                  一键创建一个“托福备考”新会话，直接注入已生成好的规划草案，后续确认并启动会走真实任务执行链路。
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const mock = seedToeflMockGoalPlanConversation();
                    router.push(`/conversations/${mock.conversationId}`);
                  }}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-white px-3 py-2 text-xs text-[#111] hover:border-[#111] hover:bg-surface"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Mock 托福规划会话
                </button>
              </div>
              <div className="mt-2 rounded-lg border border-danger-border bg-danger-bg p-3">
                <div className="text-[11px] font-medium text-danger-strong">危险操作</div>
                <div className="mt-1 text-[11px] leading-5 text-danger-strong">
                  停止本地 worker/Claude 进程，并删除会话、执行记录、DB、workspace、storage、备份和运行日志。保留 Runtime 配置与当前 Web 服务。
                </div>
                <button
                  type="button"
                  disabled={resetting}
                  onClick={handleResetLocalData}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-danger bg-white px-3 py-2 text-xs text-danger-strong hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {resetting ? "清空中..." : "清空本地测试数据"}
                </button>
                {resetMessage ? (
                  <div className="mt-2 rounded-md bg-white/70 px-2 py-1.5 text-[11px] leading-5 text-danger-strong">
                    {resetMessage}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-white text-[10px] font-medium text-ink-soft shadow-sm hover:bg-surface hover:text-[#111]"
          aria-label={expanded ? "收起 Dev 演示面板" : "打开 Dev 演示面板"}
          title="Dev 演示面板"
        >
          Dev
        </button>
      </div>
      <BackendLogsDialog open={logsOpen} onClose={() => setLogsOpen(false)} />
      <ClaudeTraceDialog open={claudeTraceOpen} onClose={() => setClaudeTraceOpen(false)} />
    </>
  );
}
