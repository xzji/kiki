"use client";

import { TopicPlanContent } from "@/components/topic/TopicPlanContent";
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

export default function TopicDetailPage({ params }: { params: { topicId: string } }) {
  const goals = useGoalStore(selectVisibleGoals);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const topicId = safeDecodeRouteParam(params.topicId);
  const goal = goals.find((item) => item.id === topicId);
  const [remoteLookup, setRemoteLookup] = useState<{ key: string; loading: boolean; loaded: boolean } | null>(null);

  useEffect(() => {
    if (goal) return;
    if (remoteLookup?.key === topicId && (remoteLookup.loading || remoteLookup.loaded)) return;

    let cancelled = false;
    setRemoteLookup({ key: topicId, loading: true, loaded: false });
    fetchRuntimeStateSnapshot()
      .then((snapshot) => {
        if (!cancelled) applyGoalsProjection(snapshot.goals, snapshot.meta?.revisions?.goals);
      })
      .catch(() => {
        // Keep the full-page route stable while the runtime snapshot is temporarily unavailable.
      })
      .finally(() => {
        if (!cancelled) setRemoteLookup({ key: topicId, loading: false, loaded: true });
      });

    return () => {
      cancelled = true;
    };
  }, [applyGoalsProjection, goal, topicId, remoteLookup]);

  if (!goal) {
    const isLookingUpRemote = remoteLookup?.key !== topicId || remoteLookup.loading || !remoteLookup?.loaded;
    if (isLookingUpRemote) {
      return <div className="rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">正在加载主题...</div>;
    }
    return <div className="rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">未找到该主题。</div>;
  }

  return <TopicPlanContent goal={goal} />;
}
