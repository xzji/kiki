"use client";

import { RotateCcw } from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  fetchGovernanceHistory,
  triggerGovernanceTick,
  type GovernanceActionPresentation,
  type GovernanceTickEntry,
} from "@/lib/api/runtime-daemon";
import { formatMessageTime } from "@/lib/date";
import { cn } from "@/lib/utils";

type Tone = "default" | "success" | "warning" | "danger";

export function ReviewCyclePopover({
  kind,
  entityId,
  label,
  phaseLabel,
  phaseTone = "default",
  lastTickAt,
  nextTickAt,
  silentCount,
  failureCount,
}: {
  kind: "thread" | "topic";
  entityId: string;
  label: string;
  phaseLabel?: string;
  phaseTone?: Tone;
  lastTickAt?: string;
  nextTickAt?: string;
  silentCount?: number;
  failureCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triggerMessage, setTriggerMessage] = useState<string | null>(null);
  const [entries, setEntries] = useState<GovernanceTickEntry[]>([]);
  const [expandedActions, setExpandedActions] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchGovernanceHistory({ kind, entityId, limit: 30 })
      .then((payload) => {
        if (cancelled) return;
        setEntries(payload.entries);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "治理历史获取失败");
        setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityId, kind, open]);

  const reloadHistory = async () => {
    const payload = await fetchGovernanceHistory({ kind, entityId, limit: 30 });
    setEntries(payload.entries);
  };

  const runNow = async () => {
    if (triggering) return;
    setTriggering(true);
    setError(null);
    setTriggerMessage(null);
    try {
      const payload = await triggerGovernanceTick({ kind, entityId });
      // job 入队成功即代表本次治理一定会被执行（编排器循环会自动拾取派发）；
      // dispatched 仅表示本次请求已顺带即时派发，未派发时也无需用户额外操作。
      setTriggerMessage(payload.dispatched ? "已发起治理" : "已发起治理，正在排队执行");
      await reloadHistory().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "治理发起失败");
    } finally {
      setTriggering(false);
    }
  };

  const toggleAction = (key: string) => {
    setExpandedActions((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-sm text-[#6B7280] underline decoration-[#D0D7DE] underline-offset-4 hover:text-[#1F2328]"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        回顾周期：{label}
      </button>
      {open ? (
        <div className="absolute left-0 top-7 z-50 w-[360px] max-w-[calc(100vw-32px)] rounded-2xl border border-[#E5E7EB] bg-white p-4 text-left shadow-[0_16px_48px_rgba(15,23,42,0.16)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[12px] text-[#8C9198]">{kind === "topic" ? "Topic 治理" : "Thread 治理"}</div>
              <div className="mt-1 text-sm font-semibold text-[#1F2328]">回顾周期：{label}</div>
            </div>
            {phaseLabel ? <GovernanceBadge tone={phaseTone}>{phaseLabel}</GovernanceBadge> : null}
          </div>

          <div className="mt-4 rounded-xl border border-[#E5E7EB] bg-[#F8FAFC] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[12px] font-medium text-[#1F2328]">立即执行一次治理</div>
                <div className="mt-1 text-[11px] leading-4 text-[#8C9198]">
                  复用当前治理队列、机器派发和回执链路。
                </div>
              </div>
              <button
                type="button"
                onClick={runNow}
                disabled={triggering}
                className="shrink-0 rounded-lg bg-[#1F2328] px-3 py-2 text-[12px] font-medium text-white hover:bg-[#111827] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {triggering ? "发起中..." : "立即执行"}
              </button>
            </div>
            {triggerMessage ? <div className="mt-2 text-[11px] text-[#137333]">{triggerMessage}</div> : null}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <GovernanceMetric label="最近一次" value={formatGovernanceTime(lastTickAt)} />
            <GovernanceMetric label="下一次" value={formatGovernanceTime(nextTickAt)} />
            <GovernanceMetric label="连续静默" value={`${silentCount ?? 0} 次`} />
            <GovernanceMetric label="连续失败" value={`${failureCount ?? 0} 次`} />
          </div>

          <div className="mt-4 border-t border-[#EEF0F3] pt-3">
            <div className="mb-2 text-[12px] font-medium text-[#6B7280]">治理历史</div>
            {loading ? <div className="text-[12px] text-[#8C9198]">加载中...</div> : null}
            {!loading && error ? <div className="text-[12px] text-[#B42318]">{error}</div> : null}
            {!loading && !error && entries.length === 0 ? (
              <div className="text-[12px] text-[#8C9198]">暂无治理记录</div>
            ) : null}
            {!loading && !error && entries.length > 0 ? (
              <div className="max-h-[260px] space-y-2 overflow-auto pr-1">
                {entries.map((entry) => (
                  <div key={entry.id} className="rounded-xl bg-[#F8FAFC] px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] text-[#8C9198]">{formatMessageTime(entry.occurredAt)}</div>
                      <GovernanceBadge tone={entryTone(entry)}>{entryStatusLabel(entry)}</GovernanceBadge>
                    </div>
                    {entry.assessment ? (
                      <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-[#6B7280]">
                        评估：{entry.assessment}
                      </div>
                    ) : null}
                    {entry.actionDetails?.length ? (
                      <div className="mt-2 space-y-1.5">
                        {entry.actionDetails.map((detail, index) => {
                          const key = `${entry.id}:${index}`;
                          const expanded = expandedActions.has(key);
                          return (
                            <GovernanceActionRow
                              key={key}
                              detail={detail}
                              expanded={expanded}
                              onToggle={() => toggleAction(key)}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div className="mt-1 text-[12px] leading-5 text-[#1F2328]">{summarizeEntry(entry)}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </span>
  );
}

function GovernanceActionRow({
  detail,
  expanded,
  onToggle,
}: {
  detail: GovernanceActionPresentation;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="rounded-lg border border-[#E5E7EB] bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-[#8C9198]" />
        <span
          className={cn(
            "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
            actionToneClass(detail.severity),
          )}
        >
          {actionKindLabel(detail)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[#1F2328]">{detail.summary}</span>
      </button>
      {expanded ? (
        <div className="border-t border-[#EEF0F3] px-3 py-2 text-[11px] leading-4 text-[#4B5563]">
          <div>影响对象：{targetLabel(detail)}</div>
          <div className="mt-1">做了什么：{detail.summary}</div>
          {detail.reason ? <div className="mt-1 line-clamp-2">为什么：{detail.reason}</div> : null}
          {detail.scope === "topic" && (detail.before || detail.after) ? (
            <div className="mt-1">
              变化：{detail.before ?? "未设置"} → {detail.after ?? "未设置"}
            </div>
          ) : null}
          {detail.scope === "thread" && detail.fieldChanges?.length ? (
            <div className="mt-1 space-y-0.5">
              {detail.fieldChanges.slice(0, 4).map((change) => (
                <div key={`${change.field}:${change.label}`}>
                  {change.label}：{change.before ?? "未设置"} → {change.after ?? "未设置"}
                </div>
              ))}
              {detail.fieldChanges.length > 4 ? (
                <div className="text-[#8C9198]">另有 {detail.fieldChanges.length - 4} 项变化</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function reviewIntervalLabel(value: string) {
  const normalized = value.trim();
  switch (normalized) {
    case "realtime":
      return "实时（每分钟检查）";
    case "hourly":
      return "每小时";
    case "daily":
      return "每天";
    case "weekly":
      return "每周";
    case "one_shot":
      return "仅首次治理";
    default:
      if (normalized.startsWith("cron:")) return `Cron：${normalized.slice("cron:".length).trim()}`;
      return normalized;
  }
}

export function topicGovernancePhaseLabel(phase?: string) {
  switch (phase) {
    case "running":
      return "治理中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "dispatch_partial_failure":
      return "部分派发失败";
    case "idle":
    default:
      return "待触发";
  }
}

export function topicGovernanceTone(phase?: string): Tone {
  if (phase === "failed") return "danger";
  if (phase === "dispatch_partial_failure") return "warning";
  if (phase === "completed") return "success";
  return "default";
}

export function threadGovernanceStatusLabel(input: { threadStatus?: string }) {
  if (input.threadStatus === "paused") return "已暂停";
  if (input.threadStatus === "archived") return "已归档";
  return "治理中";
}

export function threadGovernanceTone(input: { threadStatus?: string; silentCount?: number }): Tone {
  if (input.threadStatus === "archived") return "success";
  if (input.threadStatus === "paused") return "danger";
  if ((input.silentCount ?? 0) > 0) return "warning";
  return "default";
}

function summarizeEntry(entry: GovernanceTickEntry) {
  if (entry.paused || entry.phase === "paused") return `已暂停，失败 ${entry.failureCount ?? 0} 次`;
  if (entry.phase === "failed") return `失败：${entry.failureReason ?? entry.errorKind ?? "未知原因"}`;
  if (entry.phase === "dispatch_partial_failure") return `部分派发失败：${entry.failureReason ?? "存在未完成动作"}`;
  const parts: string[] = [];
  if (entry.dispatchedTaskCount > 0) parts.push(`派发 ${entry.dispatchedTaskCount}`);
  if (entry.updatedTaskCount > 0) parts.push(`更新 ${entry.updatedTaskCount}`);
  if (entry.cancelledTaskCount > 0) parts.push(`取消 ${entry.cancelledTaskCount}`);
  if (entry.sentMessageCount > 0) parts.push(`发消息 ${entry.sentMessageCount}`);
  if (parts.length > 0) return `${parts.join(" / ")} 个动作`;
  if (entry.silentCount > 0) return "静默：无需动作";
  return entry.assessment || "完成治理检查";
}

function entryStatusLabel(entry: GovernanceTickEntry) {
  if (entry.paused || entry.phase === "paused") return "已暂停";
  if (entry.phase === "failed") return "失败";
  if (entry.phase === "dispatch_partial_failure") return "部分失败";
  if (entry.silentCount > 0 && entry.dispatchedTaskCount + entry.updatedTaskCount + entry.cancelledTaskCount + entry.sentMessageCount === 0) {
    return "静默";
  }
  return "完成";
}

function entryTone(entry: GovernanceTickEntry): Tone {
  if (entry.paused || entry.phase === "paused" || entry.phase === "failed") return "danger";
  if (entry.phase === "dispatch_partial_failure") return "warning";
  if (entryStatusLabel(entry) === "静默") return "default";
  return "success";
}

function actionKindLabel(detail: GovernanceActionPresentation) {
  switch (detail.kind) {
    case "dispatch_task":
      return "新增任务";
    case "update_task":
      return "调整任务";
    case "cancel_task":
      return "取消任务";
    case "archive_thread":
      return "归档线程";
    case "post_message":
      return "发送消息";
    case "adjust_loop":
      return "调整周期";
    case "mark_completed":
      return "标记完成";
    case "mark_failed":
      return "标记失败";
    case "mark_running":
      return "治理中";
    case "silent":
      return "无改动";
    default:
      return "治理动作";
  }
}

function targetLabel(detail: GovernanceActionPresentation) {
  if (detail.scope === "topic") return "Topic";
  return detail.taskTitle ?? detail.taskId ?? "Thread";
}

function actionToneClass(severity: GovernanceActionPresentation["severity"]) {
  if (severity === "success") return "bg-[#E6F4EA] text-[#137333]";
  if (severity === "warning") return "bg-[#FFF4CC] text-[#7A5A00]";
  if (severity === "danger") return "bg-[#FDECEC] text-[#B42318]";
  return "bg-[#F5F6F8] text-[#4B5563]";
}

function formatGovernanceTime(value?: string) {
  return value ? formatMessageTime(value) : "暂无";
}

function GovernanceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-[#8C9198]">{label}</div>
      <div className="mt-1 text-[12px] text-[#1F2328]">{value}</div>
    </div>
  );
}

function GovernanceBadge({ children, tone = "default" }: { children: React.ReactNode; tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-1 text-[11px] font-medium",
        tone === "success" && "bg-[#E6F4EA] text-[#137333]",
        tone === "warning" && "bg-[#FFF4CC] text-[#7A5A00]",
        tone === "danger" && "bg-[#FDECEC] text-[#B42318]",
        tone === "default" && "bg-[#F5F6F8] text-[#4B5563]",
      )}
    >
      {children}
    </span>
  );
}
