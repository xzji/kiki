"use client";

import { formatToolOperationText } from "@/lib/execution/summarizeToolOperation";
import type { TaskExecutionStep } from "@/types/kiki";

const STATUS_STYLE: Record<TaskExecutionStep["status"], string> = {
  pending: "bg-[#F5F6F8] text-[#8C9198]",
  running: "bg-[#DDE1E7] text-[#1F2328]",
  completed: "bg-[#E8F5E9] text-[#25663A]",
  failed: "bg-[#FDECEC] text-[#B42318]",
  awaiting_user: "bg-[#FFF3CD] text-[#8A6D3B]",
};

const STATUS_LABEL: Record<TaskExecutionStep["status"], string> = {
  pending: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  awaiting_user: "待确认",
};

function formatStepDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function isVisibleExecutionStep(step: TaskExecutionStep) {
  return (
    step.toolName !== "debug.stream_event" &&
    !step.title.trim().startsWith("[debug]") &&
    !step.detail?.trim().startsWith("[debug]")
  );
}

export function TaskExecutionTimeline({ steps }: { steps: TaskExecutionStep[] }) {
  const visibleSteps = steps.filter(isVisibleExecutionStep);

  if (visibleSteps.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[#E5E7EB] bg-[#F8F9FB] px-4 py-6 text-sm text-[#8C9198]">
        暂无执行链路。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {visibleSteps.map((step) => (
        <div key={step.id} className="rounded-xl border border-[#E5E7EB] bg-white px-4 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[13px] font-medium text-[#1F2328]">
              {step.toolName ? formatToolOperationText(step.title, step.detail?.trim()) : step.title}
            </div>
            <span className={`rounded-md px-2 py-0.5 text-[11px] ${STATUS_STYLE[step.status]}`}>
              {STATUS_LABEL[step.status]}
            </span>
          </div>
          {step.detail && !step.toolName ? (
            <p className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-[#6B7280]">{step.detail}</p>
          ) : null}
          <div className="mt-2 text-[11px] text-[#8C9198]">
            开始 {formatStepDateTime(step.startedAt)}
            {step.finishedAt ? ` · 结束 ${formatStepDateTime(step.finishedAt)}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
