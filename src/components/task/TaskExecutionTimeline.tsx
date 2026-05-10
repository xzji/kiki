"use client";

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

export function TaskExecutionTimeline({ steps }: { steps: TaskExecutionStep[] }) {
  if (steps.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[#E5E7EB] bg-[#F8F9FB] px-4 py-6 text-sm text-[#8C9198]">
        暂无执行链路。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {steps.map((step) => (
        <div key={step.id} className="rounded-xl border border-[#E5E7EB] bg-white px-4 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[13px] font-medium text-[#1F2328]">{step.title}</div>
            <span className={`rounded-md px-2 py-0.5 text-[11px] ${STATUS_STYLE[step.status]}`}>
              {STATUS_LABEL[step.status]}
            </span>
          </div>
          {step.detail ? <p className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-[#6B7280]">{step.detail}</p> : null}
          <div className="mt-2 text-[11px] text-[#8C9198]">
            开始 {new Date(step.startedAt).toLocaleString("zh-CN")}
            {step.finishedAt ? ` · 结束 ${new Date(step.finishedAt).toLocaleString("zh-CN")}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
