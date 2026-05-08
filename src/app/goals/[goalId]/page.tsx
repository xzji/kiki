"use client";

import { GoalPlanContent } from "@/components/goal/GoalPlanContent";
import { useGoalStore } from "@/stores/goalStore";

export default function GoalDetailPage({ params }: { params: { goalId: string } }) {
  const goals = useGoalStore((state) => state.goals);
  const goal = goals.find((item) => item.id === params.goalId);

  if (!goal) {
    return <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-6 text-sm text-[#6B7280]">未找到该目标。</div>;
  }

  return <GoalPlanContent goal={goal} />;
}
