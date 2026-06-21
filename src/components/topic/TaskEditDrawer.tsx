"use client";

import { useEffect, useState } from "react";

import { formatDateInput } from "@/lib/date";
import { updateGoalTaskCommand } from "@/lib/api/goal-commands";
import { createIdempotencyKey, createOpaqueId } from "@/lib/opaqueIds";
import { useGoalStore } from "@/stores/goalStore";
import { normalizeTaskResultViewKind } from "@/types/kiki";
import type { Task } from "@/types/kiki";

export function TaskEditDrawer({
  goalId,
  task,
  open,
  onClose,
}: {
  goalId: string;
  task: Task | null;
  open: boolean;
  onClose: () => void;
}) {
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const goalProjectionRevision = useGoalStore((state) => state.goalProjectionRevision);
  const addPendingTaskUpdate = useGoalStore((state) => state.addPendingTaskUpdate);
  const removePendingTaskUpdate = useGoalStore((state) => state.removePendingTaskUpdate);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    title: task?.title ?? "",
    description: task?.description ?? "",
    expectedOutcome: task?.expectedOutcome ?? "",
    taskType: task?.taskType ?? "repeat",
    triggerRule: task?.triggerRule ?? "",
    deadline: formatDateInput(task?.deadline),
    executionKind: task?.executionKind ?? "generic_result",
  });

  useEffect(() => {
    setForm({
      title: task?.title ?? "",
      description: task?.description ?? "",
      expectedOutcome: task?.expectedOutcome ?? "",
      taskType: task?.taskType ?? "repeat",
      triggerRule: task?.triggerRule ?? "",
      deadline: formatDateInput(task?.deadline),
      executionKind: task?.executionKind ?? "generic_result",
    });
  }, [task]);

  if (!open || !task) return null;

  return (
      <div className="fixed inset-0 z-50 bg-black/10 backdrop-blur-[1px]">
        <div className="absolute inset-y-0 right-0 w-full overflow-y-auto border-l border-[#E5E7EB] bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl md:w-[420px] md:p-6">
        <h3 className="mb-6 text-lg font-semibold text-[#111]">编辑任务</h3>
        <div className="space-y-6">
          <Section title="任务基本信息">
            <Field label="标题"><input value={form.title} onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))} className="input" /></Field>
            <Field label="描述"><textarea value={form.description} onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))} className="textarea" /></Field>
            <Field label="预期结果"><input value={form.expectedOutcome} onChange={(e) => setForm((prev) => ({ ...prev, expectedOutcome: e.target.value }))} className="input" /></Field>
            <Field label="任务类型"><select value={form.taskType} onChange={(e) => setForm((prev) => ({ ...prev, taskType: e.target.value as Task["taskType"] }))} className="input"><option value="repeat">重复任务</option><option value="one_shot">一次性任务</option></select></Field>
            <Field label="触发时机"><input value={form.triggerRule} onChange={(e) => setForm((prev) => ({ ...prev, triggerRule: e.target.value }))} placeholder="例：2026-06-01 10:00 / 明天 10:00 / 每天 07:30 / 每周日 20:00 / 每 3 个小时 / 满足触发条件执行：航班价格低于 1800 元" className="input" /></Field>
            <Field label="截止时间"><input type="date" value={form.deadline} onChange={(e) => setForm((prev) => ({ ...prev, deadline: e.target.value }))} className="input" /></Field>
          </Section>
          <Section title="所属关系">
            <Field label="线程"><div className="rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm text-[#6B7280]">{task.subGoalId}</div></Field>
          </Section>
          <Section title="执行方式">
            <Field label="执行类型"><select value={form.executionKind} onChange={(e) => setForm((prev) => ({ ...prev, executionKind: e.target.value as Task["executionKind"] }))} className="input"><option value="generic_result">generic_result</option></select></Field>
          </Section>
          <Section title="KiKi 的建议">
            <p className="rounded-lg border border-dashed border-[#D0D7DE] bg-[#F8FAFC] px-3 py-3 text-sm leading-6 text-[#6B7280]">这个任务适合保留每天 11:00 触发，因为它和你的托福训练节奏已经形成稳定习惯。若要进一步提升效率，可以把 payload 中的词汇组改成更聚焦的天文领域词汇。</p>
          </Section>
        </div>
          <div className="mt-8 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-[#D0D7DE] px-4 py-2 text-sm text-[#111] hover:bg-[#F5F6F8]">取消</button>
          <button
            disabled={submitting}
            onClick={async () => {
              if (submitting) return;
              setSubmitting(true);
              const taskInput = {
                title: form.title.trim(),
                description: form.description.trim(),
                expectedOutcome: form.expectedOutcome.trim(),
                taskType: form.taskType as Task["taskType"],
                triggerRule: form.triggerRule.trim(),
                deadline: form.deadline ? new Date(form.deadline).toISOString() : undefined,
                executionKind: form.executionKind as Task["executionKind"],
              };
              const overlayId = createOpaqueId("idem");
              const idempotencyKey = createIdempotencyKey("goal.update_task", goalId, task.id, overlayId);
              addPendingTaskUpdate({
                id: overlayId,
                goalId,
                taskId: task.id,
                idempotencyKey,
                createdAt: new Date().toISOString(),
                task: {
                  ...task,
                  ...taskInput,
                  resultViewKind: normalizeTaskResultViewKind(taskInput.executionKind),
                  executionObjective: taskInput.description,
                },
              });
              onClose();
              try {
                const result = await updateGoalTaskCommand({
                  goalId,
                  taskId: task.id,
                  task: taskInput,
                  baseRevision: goalProjectionRevision,
                  idempotencyKey,
                });
                applyGoalsProjection(result.goals, result.revision);
                removePendingTaskUpdate(overlayId);
              } catch (error) {
                removePendingTaskUpdate(overlayId);
                window.alert(error instanceof Error ? error.message : "任务保存失败");
              } finally {
                setSubmitting(false);
              }
            }}
            className="rounded-lg bg-[#111] px-4 py-2 text-sm text-white hover:bg-[#333]"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><div className="mb-3 text-sm font-semibold text-[#111]">{title}</div><div className="space-y-3">{children}</div></section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm text-[#6B7280]"><div className="mb-1">{label}</div>{children}</label>;
}
