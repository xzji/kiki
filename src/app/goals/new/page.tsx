"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { DoraAvatar } from "@/components/layout/DoraAvatar";
import { getGoalBreakdownDraft } from "@/mocks/goal-breakdown";
import { useGoalStore } from "@/stores/goalStore";

export default function NewGoalPage({
  searchParams,
}: {
  searchParams?: { title?: string };
}) {
  const router = useRouter();
  const title = searchParams?.title ?? "准备产品经理面试";
  const draft = getGoalBreakdownDraft(title);
  const createGoalFromInput = useGoalStore((state) => state.createGoalFromInput);

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-6 flex items-start gap-3">
          <DoraAvatar size="sm" />
          <div className="rounded-2xl border border-[#E5E7EB] bg-[#F8FAFC] px-4 py-3 text-sm leading-6 text-[#374151]">
            我根据“{title}”先给出一版拆解草案：2 个子目标，每个子目标 3 个任务。你可以先看结构，之后再逐项微调。
          </div>
        </div>
        <div className="space-y-6">
          {draft.subGoals.map((subGoal) => (
            <section key={subGoal.id} className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-4">
              <div className="mb-3 text-sm font-semibold text-[#111]">{subGoal.title}</div>
              <div className="space-y-2">
                {subGoal.tasks.map((task) => (
                  <div key={task.id} className="rounded-lg bg-[#F8FAFC] px-3 py-3 text-sm text-[#374151]">
                    <div className="font-medium text-[#111]">{task.title}</div>
                    <div className="mt-1 text-xs leading-5 text-[#6B7280]">{task.description}</div>
                    <div className="mt-2 text-xs text-[#6B7280]">预期结果：{task.expectedOutcome}</div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Link href="/" className="rounded-lg border border-[#D0D7DE] px-4 py-2 text-sm text-[#111] hover:bg-[#F5F6F8]">取消</Link>
          <button
            className="rounded-lg bg-[#111] px-4 py-2 text-sm text-white hover:bg-[#333]"
            onClick={() => {
              const nextGoal = createGoalFromInput(title);
              router.push(`/goals/${nextGoal.id}`);
            }}
          >
            确认创建
          </button>
        </div>
      </div>
    </div>
  );
}
