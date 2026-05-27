"use client";

import { ChevronDown, FileText, Sparkles, TerminalSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { formatClock, formatChineseDate } from "@/lib/date";
import { useVirtualClock } from "@/hooks/useVirtualClock";
import { seedToeflMockGoalPlanConversation } from "@/lib/devMockSessions";
import { BackendLogsDialog } from "@/components/settings/BackendLogsPanel";
import { ClaudeTraceDialog } from "@/components/dev/ClaudeTracePanel";
import { useNavSidebarStore } from "@/stores/navSidebarStore";

export function DevPanel() {
  const router = useRouter();
  const { currentTime, advanceHours, jumpToTomorrowEleven } = useVirtualClock();
  const [expanded, setExpanded] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [claudeTraceOpen, setClaudeTraceOpen] = useState(false);
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

  return (
    <>
      <div
        ref={panelRef}
        className="fixed bottom-16 z-30"
        style={{ left: leftOffset }}
      >
        {expanded ? (
          <div className="absolute bottom-11 left-0 w-80 rounded-xl border border-[#E5E7EB] bg-white/95 p-4 shadow-sm backdrop-blur">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-[#6B7280]">Dev 演示浮层</div>
              <button
                type="button"
                aria-label="收起"
                onClick={() => setExpanded(false)}
                className="rounded p-1 text-[#6B7280] hover:bg-[#F5F6F8]"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="text-sm font-semibold text-[#1F2328]">{formatChineseDate(currentTime)}</div>
            <div className="mb-4 text-lg font-semibold text-[#111]">{formatClock(currentTime)}</div>
            <div className="grid gap-2">
              <div className="flex gap-2">
                <button className="flex-1 rounded-lg bg-[#111] px-3 py-2 text-xs text-white hover:bg-[#333]" onClick={() => advanceHours(1)}>
                  快进 1 小时
                </button>
                <button className="flex-1 rounded-lg border border-[#D0D7DE] px-3 py-2 text-xs text-[#111] hover:bg-[#F5F6F8]" onClick={jumpToTomorrowEleven}>
                  跳到明早 11:00
                </button>
              </div>
              <button
                type="button"
                onClick={() => setLogsOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-dashed border-[#D0D7DE] px-3 py-2 text-xs text-[#374151] hover:border-[#111] hover:bg-[#F5F6F8] hover:text-[#111]"
              >
                <FileText className="h-3.5 w-3.5" />
                后端日志
              </button>
              <button
                type="button"
                onClick={() => setClaudeTraceOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-dashed border-[#D0D7DE] px-3 py-2 text-xs text-[#374151] hover:border-[#111] hover:bg-[#F5F6F8] hover:text-[#111]"
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                Claude Trace
              </button>
              <div className="mt-2 rounded-lg border border-dashed border-[#D0D7DE] bg-[#FAFBFC] p-3">
                <div className="text-[11px] font-medium text-[#6B7280]">目标规划 Mock</div>
                <div className="mt-1 text-[11px] leading-5 text-[#8C9198]">
                  一键创建一个“托福备考”新会话，直接注入已生成好的规划草案，后续确认并启动会走真实任务执行链路。
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const mock = seedToeflMockGoalPlanConversation();
                    router.push(`/conversations/${mock.conversationId}`);
                  }}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[#D0D7DE] bg-white px-3 py-2 text-xs text-[#111] hover:border-[#111] hover:bg-[#F5F6F8]"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Mock 托福规划会话
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-[#E5E7EB] bg-white text-[10px] font-medium text-[#6B7280] shadow-sm hover:bg-[#F5F6F8] hover:text-[#111]"
          aria-label={expanded ? "收起 Dev 演示面板" : "打开 Dev 演示面板"}
          title={`Dev ${formatClock(currentTime)}`}
        >
          Dev
        </button>
      </div>
      <BackendLogsDialog open={logsOpen} onClose={() => setLogsOpen(false)} />
      <ClaudeTraceDialog open={claudeTraceOpen} onClose={() => setClaudeTraceOpen(false)} />
    </>
  );
}
