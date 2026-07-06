"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { createGoalTaskCommand } from "@/lib/api/goal-commands";
import { createIdempotencyKey, deriveOpaqueId } from "@/lib/opaqueIds";
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
];

export function TaskCreateDrawer({ open, goalId, subGoalId, onClose }: Props) {
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const goalProjectionRevision = useGoalStore((state) => state.goalProjectionRevision);
  const addPendingTaskCreate = useGoalStore((state) => state.addPendingTaskCreate);
  const removePendingTaskCreate = useGoalStore((state) => state.removePendingTaskCreate);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    title: "",
    description: "",
    expectedOutcome: "",
    taskType: "repeat" as Task["taskType"],
    triggerRule: "",
    executionKind: "generic_result" as Task["executionKind"],
  });

  useEffect(() => {
    if (!open) {
      setForm({
        title: "",
        description: "",
        expectedOutcome: "",
        taskType: "repeat",
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

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    const now = new Date().toISOString();
    const taskInput = {
      title: form.title.trim(),
      description: form.description.trim(),
      expectedOutcome: form.expectedOutcome.trim(),
      taskType: form.taskType,
      triggerRule: form.triggerRule.trim(),
      executionKind: form.executionKind,
    };
    const idempotencyKey = createIdempotencyKey(
      "goal.create_task",
      goalId,
      subGoalId,
      taskInput.title,
      `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    );
    const pendingTaskId = deriveOpaqueId("task", idempotencyKey);
    addPendingTaskCreate({
      id: pendingTaskId,
      goalId,
      subGoalId,
      idempotencyKey,
      createdAt: now,
      task: {
        id: pendingTaskId,
        subGoalId,
        title: taskInput.title,
        description: taskInput.description,
        expectedOutcome: taskInput.expectedOutcome,
        taskType: taskInput.taskType,
        triggerRule: taskInput.triggerRule,
        progress: 0,
        instances: [],
        executionKind: taskInput.executionKind,
        resultViewKind: taskInput.executionKind,
        executionStrategy: "agent_autonomous",
        executionObjective: taskInput.description,
      },
    });
    onClose();
    try {
      const result = await createGoalTaskCommand({
        goalId,
        subGoalId,
        task: taskInput,
        baseRevision: goalProjectionRevision,
        idempotencyKey,
      });
      applyGoalsProjection(result.goals, result.revision);
      removePendingTaskCreate(pendingTaskId);
    } catch (error) {
      removePendingTaskCreate(pendingTaskId);
      toast.error(error instanceof Error ? error.message : "任务创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
        <aside className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full flex-col border-l border-line bg-white md:h-screen md:w-[440px]">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-sm font-semibold text-ink">添加任务</h3>
          <button type="button" className="rounded-md p-1.5 text-ink-soft hover:bg-surface" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 md:px-5 md:py-5">
          <Field label="任务标题" required>
            <input
              autoFocus
              value={form.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              placeholder="例：每日精读 2 篇 TPO 阅读"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            />
          </Field>
          <Field label="任务描述">
            <textarea
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="简单说明这个任务要做什么、怎么做"
              rows={3}
              className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            />
          </Field>
          <Field label="交付物" required>
            <input
              value={form.expectedOutcome}
              onChange={(e) => setForm((prev) => ({ ...prev, expectedOutcome: e.target.value }))}
              placeholder="例：一份面试脚本 / 一张对比表"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            />
            <p className="mt-1.5 text-xs leading-5 text-ink-faint">交付物越具体，KiKi 越容易帮你对齐完成标准。</p>
          </Field>
          <Field label="任务类型">
            <select
              value={form.taskType}
              onChange={(e) => setForm((prev) => ({ ...prev, taskType: e.target.value as Task["taskType"] }))}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            >
              <option value="repeat">重复任务</option>
              <option value="one_shot">一次性任务</option>
            </select>
          </Field>
          <Field label="触发时机" required>
            <input
              value={form.triggerRule}
              onChange={(e) => setForm((prev) => ({ ...prev, triggerRule: e.target.value }))}
              placeholder="例：2026-06-01 10:00 / 明天 10:00 / 每天 07:30 / 每周日 20:00 / 每 3 个小时 / 满足触发条件执行：航班价格低于 1800 元"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            />
          </Field>
          <Field label="执行方式">
            <select
              value={form.executionKind}
              onChange={(e) => setForm((prev) => ({ ...prev, executionKind: e.target.value as Task["executionKind"] }))}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            >
              {EXECUTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
          <div className="flex items-center justify-end gap-2 border-t border-line px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 md:px-5 md:pb-4">
          <button type="button" className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={handleSubmit}
            className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-40"
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
      <label className="mb-1.5 flex items-center gap-1 text-xs font-medium text-ink-soft">
        <span>{label}</span>
        {required ? <span className="text-badge">*</span> : null}
      </label>
      {children}
    </div>
  );
}
