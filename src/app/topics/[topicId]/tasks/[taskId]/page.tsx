"use client";

import { Minimize2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { TopicPlanBreadcrumb } from "@/components/topic/TopicPlanContent";
import { TaskDetailBody } from "@/components/topic/TaskDetailBody";
import { ExecutionShell } from "@/components/task/ExecutionShell";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { topicDetailPath, topicTaskDrawerReturnPath } from "@/lib/routes";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import type { Goal, Task } from "@/types/kiki";

function safeDecodeRouteParam(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function findTaskForRoute(goals: Goal[], goalId: string, taskId: string): { goal: Goal; task: Task } | null {
  const goal = goals.find((item) => item.id === goalId);
  const task = goal?.subGoals.flatMap((subGoal) => subGoal.tasks).find((item) => item.id === taskId);
  if (goal && task) return { goal, task };

  for (const candidateGoal of goals) {
    const candidateTask = candidateGoal.subGoals
      .flatMap((subGoal) => subGoal.tasks)
      .find((item) => item.id === taskId);
    if (candidateTask) return { goal: candidateGoal, task: candidateTask };
  }
  return null;
}

export default function TaskDetailPage({
  params,
  searchParams,
}: {
  params: { topicId: string; taskId: string };
  searchParams?: { view?: string; instanceId?: string };
}) {
  const router = useRouter();
  const goals = useGoalStore(selectVisibleGoals);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const topicId = safeDecodeRouteParam(params.topicId);
  const taskId = safeDecodeRouteParam(params.taskId);
  const routeKey = `${topicId}:${taskId}`;
  const [remoteLookup, setRemoteLookup] = useState<{ key: string; loading: boolean; loaded: boolean } | null>(null);
  const routeMatch = useMemo(() => findTaskForRoute(goals, topicId, taskId), [goals, topicId, taskId]);
  const goal = routeMatch?.goal;
  const task = routeMatch?.task;
  const view = searchParams?.view ?? "list";

  useEffect(() => {
    if (routeMatch) return;
    if (remoteLookup?.key === routeKey && (remoteLookup.loading || remoteLookup.loaded)) return;

    let cancelled = false;
    setRemoteLookup({ key: routeKey, loading: true, loaded: false });
    fetchRuntimeStateSnapshot()
      .then((snapshot) => {
        if (!cancelled) applyGoalsProjection(snapshot.goals, snapshot.meta?.revisions?.goals);
      })
      .catch(() => {
        // Keep the page resilient even when the local runtime snapshot is temporarily unavailable.
      })
      .finally(() => {
        if (!cancelled) setRemoteLookup({ key: routeKey, loading: false, loaded: true });
      });

    return () => {
      cancelled = true;
    };
  }, [applyGoalsProjection, remoteLookup, routeKey, routeMatch]);

  if (!goal || !task) {
    const isLookingUpRemote = remoteLookup?.key !== routeKey || remoteLookup.loading || !remoteLookup?.loaded;
    if (isLookingUpRemote) {
      return (
        <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-6 text-sm text-[#6B7280]">
          正在加载任务...
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-6 text-sm text-[#6B7280]">
        未找到任务。
      </div>
    );
  }

  const instance =
    task.instances.find((item) => item.id === searchParams?.instanceId) ?? task.instances[0];

  if (view === "exec" && instance) {
    return <ExecutionShell goal={goal} task={task} instance={instance} />;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-2 py-2">
      <div className="mb-4 flex items-center gap-3">
        <TopicPlanBreadcrumb
          goalId={goal.id}
          goalTitle={goal.title}
          taskTitle={task.title.replace(/^任务\d+：/, "")}
          className="min-w-0 flex-1 justify-start text-left"
        />
        <button
          type="button"
          aria-label="收起为右侧边栏"
          onClick={() => router.push(topicTaskDrawerReturnPath(goal.id, task.id, searchParams?.instanceId))}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
        >
          <Minimize2 className="h-4 w-4" />
        </button>
      </div>
      <TaskDetailBody
        goal={goal}
        task={task}
        initiallyExpandedInstanceId={searchParams?.instanceId}
        onDeleted={() => router.replace(topicDetailPath(goal.id))}
      />
    </div>
  );
}
