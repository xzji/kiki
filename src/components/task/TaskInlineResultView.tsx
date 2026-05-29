"use client";

import { GenericAgentResultView } from "@/components/task/GenericAgentResultView";
import type { Task, TaskInstance } from "@/types/kiki";

function hasAgentDeliverable(instance: TaskInstance) {
  const taskResult = instance.result?.taskResult;
  return Boolean(taskResult?.blocks?.length || taskResult?.artifactRefs?.length);
}

function hasCompletedAgentResult(instance: TaskInstance) {
  return instance.status === "completed" || instance.result?.taskResult?.status === "done";
}

export function canRenderInlineAgentResult(_task: Task, instance: TaskInstance) {
  void _task;
  return hasCompletedAgentResult(instance) && hasAgentDeliverable(instance);
}

export function TaskInlineResultView({ task, instance }: { task: Task; instance: TaskInstance }) {
  if (!canRenderInlineAgentResult(task, instance)) return null;
  return (
    <div className="mt-4 rounded-xl border border-[#E5E7EB] bg-[#F8F9FB] p-4">
      <div className="mb-3 text-[12px] font-medium text-[#57606A]">任务结果</div>
      <div className="max-h-[520px] overflow-y-auto overscroll-contain pr-1">
        <GenericAgentResultView
          summary={instance.result?.summary}
          finalMessage={instance.result?.finalMessage}
          taskResult={instance.result?.taskResult}
          artifacts={instance.result?.artifacts}
          structuredOutput={instance.result?.structuredOutput}
          notification={instance.notification}
        />
      </div>
    </div>
  );
}
