"use client";

import { useMemo, useState } from "react";

import { deriveOpaqueId } from "@/lib/opaqueIds";
import { buildGoalTaskRunnerPrompt } from "@/lib/server/goalTaskPrompt";
import type { Goal, SubGoal, Task, TaskInstance } from "@/types/kiki";

export function TaskAgentPromptDrawer({
  open,
  onClose,
  goal,
  subGoal,
  task,
  instance,
}: {
  open: boolean;
  onClose: () => void;
  goal: Goal | null;
  subGoal: SubGoal | null;
  task: Task | null;
  instance?: TaskInstance | null;
}) {
  const [copied, setCopied] = useState(false);

  const previewInstance = useMemo<TaskInstance | null>(() => {
    if (!task) return null;
    if (instance) return instance;
    const latest = [...task.instances].sort(
      (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
    )[0];
    if (latest) return latest;
    return {
      id: deriveOpaqueId("inst", `${task.id}:preview`),
      taskId: task.id,
      dateLabel: "—",
      status: "pending",
      intro: task.expectedOutcome,
      payload: { kind: "generic_result", summary: task.expectedOutcome },
      createdAt: new Date().toISOString(),
    };
  }, [task, instance]);

  const promptText = useMemo(() => {
    if (!goal || !subGoal || !task || !previewInstance) return "";
    return buildGoalTaskRunnerPrompt({
      context: {
        identity: {
          conversationId: goal.conversationId ?? "",
          goalId: goal.id,
          subGoalId: subGoal.id,
          taskId: task.id,
          instanceId: previewInstance.id,
        },
        readiness: { state: "ready", blockers: [], summary: "" },
        dependencies: [],
        inputs: { goal, subGoal, task, instance: previewInstance },
        budget: { maxPromptBytes: 8192, maxKeyPoints: 8, maxArtifacts: 5 },
      },
    });
  }, [goal, subGoal, task, previewInstance]);

  if (!open || !task || !goal || !subGoal) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([promptText], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${task.title.replace(/[\\/:*?"<>|]/g, "_")}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/10 backdrop-blur-[1px]" onClick={onClose}>
      <div
        className="absolute inset-y-0 right-0 flex w-[620px] max-w-full flex-col overflow-hidden border-l border-[#E5E7EB] bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[#E5E7EB] px-6 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-[#8C9198]">Agent 完整任务内容（实时根据当前任务字段生成）</div>
            <h3 className="mt-1 truncate text-[16px] font-semibold tracking-[-0.01em] text-[#1F2328]">
              {task.title.replace(/^任务\d+：/, "")} · agent prompt
            </h3>
            {previewInstance ? (
              <div className="mt-1 text-[12px] text-[#6B7280]">
                实例：{previewInstance.dateLabel}（{previewInstance.id}）
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-md border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] text-[#1F2328] hover:border-[#111]"
            >
              {copied ? "已复制" : "复制"}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="rounded-md border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] text-[#1F2328] hover:border-[#111]"
            >
              下载 .md
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="rounded-md border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] text-[#1F2328] hover:border-[#111]"
            >
              关闭
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          <pre className="whitespace-pre-wrap rounded-lg border border-[#E5E7EB] bg-[#FAFBFC] p-4 text-[12.5px] leading-6 text-[#1F2328]">
            {promptText}
          </pre>
          <p className="mt-3 text-[12px] text-[#8C9198]">
            说明：上述内容是 KiKi 在执行该任务时实时拼装并发送给 Agent 的完整 prompt。修改任务字段（标题、描述、执行目标、交付物要求、协作要求等）后，重新打开本面板会自动重新生成。
          </p>
        </div>
      </div>
    </div>
  );
}
