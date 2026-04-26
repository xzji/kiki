import type { Task } from "@/types/dora";

export function DetailPanel({ task }: { task: Task }) {
  const typeLabel = task.taskType === "daily_repeat" ? "每天重复任务" : task.taskType === "monitoring" ? "监控任务" : "一次性任务";

  return (
    <div className="mb-6 grid gap-4 rounded-xl border border-[#E5E7EB] bg-white p-4 md:grid-cols-2">
      <Meta label="预期结果" value={task.expectedOutcome} />
      <Meta label="截止时间" value={task.deadline ? new Date(task.deadline).toISOString().slice(0, 10) : "未设置"} />
      <Meta label="完成进度" value={`${task.progress}%`} />
      <Meta label="任务类型" value={typeLabel} />
      <Meta label="触发时机" value={task.triggerRule} />
      <Meta label="执行类型" value={task.executionKind} />
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs text-[#6B7280]">{label}</div>
      <div className="text-sm font-medium text-[#111]">{value}</div>
    </div>
  );
}
