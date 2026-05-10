"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { useGoalStore } from "@/stores/goalStore";
import type { Task } from "@/types/kiki";

type Props = {
  open: boolean;
  goalId: string;
  subGoalId: string;
  onClose: () => void;
};

const EXECUTION_OPTIONS: { value: Task["executionKind"]; label: string }[] = [
  { value: "generic_result", label: "Agent 执行 · KiKi 自动推进" },
  { value: "freeform_chat", label: "补充对话 · 人工介入时使用" },
  { value: "flashcard", label: "记忆闪卡 · 生词/概念记忆" },
  { value: "listening_qa", label: "听力问答 · 含音频练习" },
  { value: "reading_digest", label: "阅读摘要 · 素材快览" },
  { value: "confirm_action", label: "确认执行 · KiKi 准备好让你拍板" },
  { value: "draft_review", label: "草稿审阅 · 邮件/文档审核" },
];

export function TaskCreateDrawer({ open, goalId, subGoalId, onClose }: Props) {
  const addTask = useGoalStore((state) => state.addTask);
  const [form, setForm] = useState({
    title: "",
    description: "",
    expectedOutcome: "",
    taskType: "daily_repeat" as Task["taskType"],
    triggerRule: "",
    executionKind: "generic_result" as Task["executionKind"],
  });

  useEffect(() => {
    if (!open) {
      setForm({
        title: "",
        description: "",
        expectedOutcome: "",
        taskType: "daily_repeat",
        triggerRule: "",
        executionKind: "generic_result",
      });
    }
  }, [open]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const canSubmit = form.title.trim() && form.expectedOutcome.trim() && form.triggerRule.trim();

  const handleSubmit = () => {
    if (!canSubmit) return;
    addTask(goalId, subGoalId, {
      title: form.title.trim(),
      description: form.description.trim(),
      expectedOutcome: form.expectedOutcome.trim(),
      taskType: form.taskType,
      triggerRule: form.triggerRule.trim(),
      executionKind: form.executionKind,
    });
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-screen w-[440px] flex-col border-l border-[#E5E7EB] bg-white">
        <div className="flex items-center justify-between border-b border-[#E5E7EB] px-5 py-4">
          <h3 className="text-sm font-semibold text-[#1F2328]">添加任务</h3>
          <button type="button" className="rounded-md p-1.5 text-[#6B7280] hover:bg-[#F5F6F8]" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <Field label="任务标题" required>
            <input
              autoFocus
              value={form.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              placeholder="例：每日精读 2 篇 TPO 阅读"
              className="w-full rounded-lg border border-[#E5E7EB] bg-[#F5F6F8] px-3 py-2 text-sm text-[#1F2328] outline-none focus:border-[#1F2328]"
            />
          </Field>
          <Field label="任务描述">
            <textarea
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="简单说明这个任务要做什么、怎么做"
              rows={3}
              className="w-full resize-none rounded-lg border border-[#E5E7EB] bg-[#F5F6F8] px-3 py-2 text-sm text-[#1F2328] outline-none focus:border-[#1F2328]"
            />
          </Field>
          <Field label="交付物" required>
            <input
              value={form.expectedOutcome}
              onChange={(e) => setForm((prev) => ({ ...prev, expectedOutcome: e.target.value }))}
              placeholder="例：一份面试脚本 / 一张对比表"
              className="w-full rounded-lg border border-[#E5E7EB] bg-[#F5F6F8] px-3 py-2 text-sm text-[#1F2328] outline-none focus:border-[#1F2328]"
            />
            <p className="mt-1.5 text-xs leading-5 text-[#8C9198]">交付物越具体，KiKi 越容易帮你对齐完成标准。</p>
          </Field>
          <Field label="任务类型">
            <select
              value={form.taskType}
              onChange={(e) => setForm((prev) => ({ ...prev, taskType: e.target.value as Task["taskType"] }))}
              className="w-full rounded-lg border border-[#E5E7EB] bg-[#F5F6F8] px-3 py-2 text-sm text-[#1F2328] outline-none focus:border-[#1F2328]"
            >
              <option value="daily_repeat">每日重复</option>
              <option value="one_shot">一次性</option>
              <option value="monitoring">监控追踪</option>
            </select>
          </Field>
          <Field label="触发规则" required>
            <input
              value={form.triggerRule}
              onChange={(e) => setForm((prev) => ({ ...prev, triggerRule: e.target.value }))}
              placeholder="例：每天 21:00 触发 / 周六上午 10:00"
              className="w-full rounded-lg border border-[#E5E7EB] bg-[#F5F6F8] px-3 py-2 text-sm text-[#1F2328] outline-none focus:border-[#1F2328]"
            />
          </Field>
          <Field label="执行方式">
            <select
              value={form.executionKind}
              onChange={(e) => setForm((prev) => ({ ...prev, executionKind: e.target.value as Task["executionKind"] }))}
              className="w-full rounded-lg border border-[#E5E7EB] bg-[#F5F6F8] px-3 py-2 text-sm text-[#1F2328] outline-none focus:border-[#1F2328]"
            >
              {EXECUTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#E5E7EB] px-5 py-4">
          <button type="button" className="rounded-lg border border-[#E5E7EB] bg-[#F5F6F8] px-3 py-1.5 text-sm text-[#1F2328]" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="rounded-lg bg-[#1F2328] px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            创建任务
          </button>
        </div>
      </aside>
    </>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 flex items-center gap-1 text-xs font-medium text-[#6B7280]">
        <span>{label}</span>
        {required ? <span className="text-[#E5484D]">*</span> : null}
      </label>
      {children}
    </div>
  );
}
