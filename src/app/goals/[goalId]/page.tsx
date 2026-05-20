"use client";

import { GoalPlanContent } from "@/components/goal/GoalPlanContent";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useEffect, useState } from "react";

function safeDecodeRouteParam(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function GoalDetailPage({ params }: { params: { goalId: string } }) {
  const goals = useGoalStore(selectVisibleGoals);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const goalId = safeDecodeRouteParam(params.goalId);
  const goal = goals.find((item) => item.id === goalId);
  const [remoteLookup, setRemoteLookup] = useState<{ key: string; loading: boolean; loaded: boolean } | null>(null);

  useEffect(() => {
    if (goal) return;
    if (remoteLookup?.key === goalId && (remoteLookup.loading || remoteLookup.loaded)) return;

    let cancelled = false;
    setRemoteLookup({ key: goalId, loading: true, loaded: false });
    fetchRuntimeStateSnapshot()
      .then((snapshot) => {
        if (!cancelled) applyGoalsProjection(snapshot.goals, snapshot.meta?.revisions?.goals);
      })
      .catch(() => {
        // Keep the full-page route stable while the runtime snapshot is temporarily unavailable.
      })
      .finally(() => {
        if (!cancelled) setRemoteLookup({ key: goalId, loading: false, loaded: true });
      });

    return () => {
      cancelled = true;
    };
  }, [applyGoalsProjection, goal, goalId, remoteLookup]);

  if (!goal) {
    const isLookingUpRemote = remoteLookup?.key !== goalId || remoteLookup.loading || !remoteLookup?.loaded;
    if (isLookingUpRemote) {
      return <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-6 text-sm text-[#6B7280]">正在加载目标...</div>;
    }
    return <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-6 text-sm text-[#6B7280]">未找到该目标。</div>;
  }

  return <GoalPlanContent goal={goal} />;
}
