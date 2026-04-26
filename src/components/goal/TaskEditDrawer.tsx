"use client";

import { useEffect, useMemo, useState } from "react";

import { formatDateInput } from "@/lib/date";
import { useGoalStore } from "@/stores/goalStore";
import type { Task } from "@/types/dora";

export function TaskEditDrawer({ task, open, onClose }: { task: Task | null; open: boolean; onClose: () => void }) {
  const updateTask = useGoalStore((state) => state.updateTask);
  const initialPayload = useMemo(() => JSON.stringify(task?.instances[0]?.payload ?? { kind: task?.executionKind }, null, 2), [task]);
  const [form, setForm] = useState({
    title: task?.title ?? "",
    description: task?.description ?? "",
    expectedOutcome: task?.expectedOutcome ?? "",
    taskType: task?.taskType ?? "daily_repeat",
    triggerRule: task?.triggerRule ?? "",
    deadline: formatDateInput(task?.deadline),
    executionKind: task?.executionKind ?? "flashcard",
    payload: initialPayload,
  });

  useEffect(() => {
    setForm({
      title: task?.title ?? "",
      description: task?.description ?? "",
      expectedOutcome: task?.expectedOutcome ?? "",
      taskType: task?.taskType ?? "daily_repeat",
      triggerRule: task?.triggerRule ?? "",
      deadline: formatDateInput(task?.deadline),
      executionKind: task?.executionKind ?? "flashcard",
      payload: JSON.stringify(task?.instances[0]?.payload ?? { kind: task?.executionKind }, null, 2),
    });
  }, [task]);

  if (!open || !task) return null;

  return (
    <div className="fixed inset-0 z-30 bg-black/10 backdrop-blur-[1px]">
      <div className="absolute inset-y-0 right-0 w-[420px] overflow-y-auto border-l border-[#E5E7EB] bg-white p-6 shadow-xl">
        <h3 className="mb-6 text-lg font-semibold text-[#111]">编辑任务</h3>
        <div className="space-y-6">
          <Section title="任务基本信息">
            <Field label="标题"><input value={form.title} onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))} className="input" /></Field>
            <Field label="描述"><textarea value={form.description} onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))} className="textarea" /></Field>
            <Field label="预期结果"><input value={form.expectedOutcome} onChange={(e) => setForm((prev) => ({ ...prev, expectedOutcome: e.target.value }))} className="input" /></Field>
            <Field label="任务类型"><select value={form.taskType} onChange={(e) => setForm((prev) => ({ ...prev, taskType: e.target.value as Task["taskType"] }))} className="input"><option value="daily_repeat">每天重复</option><option value="one_shot">一次性任务</option><option value="monitoring">监控任务</option></select></Field>
            <Field label="触发时机"><input value={form.triggerRule} onChange={(e) => setForm((prev) => ({ ...prev, triggerRule: e.target.value }))} className="input" /></Field>
            <Field label="截止时间"><input type="date" value={form.deadline} onChange={(e) => setForm((prev) => ({ ...prev, deadline: e.target.value }))} className="input" /></Field>
          </Section>
          <Section title="所属关系">
            <Field label="子目标"><div className="rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm text-[#6B7280]">{task.subGoalId}</div></Field>
          </Section>
          <Section title="执行方式">
            <Field label="执行类型"><select value={form.executionKind} onChange={(e) => setForm((prev) => ({ ...prev, executionKind: e.target.value as Task["executionKind"] }))} className="input"><option value="flashcard">flashcard</option><option value="listening_qa">listening_qa</option><option value="reading_digest">reading_digest</option><option value="confirm_action">confirm_action</option><option value="draft_review">draft_review</option><option value="freeform_chat">freeform_chat</option></select></Field>
            <Field label="内容区配置"><textarea value={form.payload} onChange={(e) => setForm((prev) => ({ ...prev, payload: e.target.value }))} className="h-40 w-full rounded-lg border border-[#E5E7EB] px-3 py-2 text-xs text-[#111] outline-none" /></Field>
          </Section>
          <Section title="Dora 的建议">
            <p className="rounded-lg border border-dashed border-[#D0D7DE] bg-[#F8FAFC] px-3 py-3 text-sm leading-6 text-[#6B7280]">这个任务适合保留每天 11:00 触发，因为它和你的托福训练节奏已经形成稳定习惯。若要进一步提升效率，可以把 payload 中的词汇组改成更聚焦的天文领域词汇。</p>
          </Section>
        </div>
        <div className="mt-8 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-[#D0D7DE] px-4 py-2 text-sm text-[#111] hover:bg-[#F5F6F8]">取消</button>
          <button
            onClick={() => {
              let payload;
              try {
                payload = JSON.parse(form.payload);
              } catch {
                payload = undefined;
              }
              updateTask(task.id, {
                title: form.title,
                description: form.description,
                expectedOutcome: form.expectedOutcome,
                taskType: form.taskType as Task["taskType"],
                triggerRule: form.triggerRule,
                deadline: form.deadline ? new Date(form.deadline).toISOString() : undefined,
                executionKind: form.executionKind as Task["executionKind"],
                payload,
              });
              onClose();
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
