"use client";

import { ChevronsRight, Maximize2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { GoalPlanBreadcrumb, GoalPlanContent } from "@/components/goal/GoalPlanContent";
import { TaskDetailBody } from "@/components/goal/TaskDetailBody";
import { goalDetailPath, taskDetailPath } from "@/lib/routes";
import type { Task } from "@/types/kiki";
import { useGoalStore } from "@/stores/goalStore";
import { useNavSidebarStore } from "@/stores/navSidebarStore";

/**
 * 目标规划 Drawer：从右侧覆盖中间区域。
 * - 内容与全屏目标规划页保持一致
 * - 点击任务后，在 Drawer 内展示同源的任务详情内容
 * - 右上角关闭 / 全屏跳转至 /goals/[goalId]
 */
export function GoalPlanDrawer({
  goalId,
  open,
  focusSubGoalId,
  onClose,
}: {
  goalId?: string;
  open: boolean;
  focusSubGoalId?: string | null;
  onClose: () => void;
}) {
  const goals = useGoalStore((state) => state.goals);
  const navCollapsed = useNavSidebarStore((state) => state.collapsed);
  const setNavCollapsed = useNavSidebarStore((state) => state.setCollapsed);
  const prevNavRef = useRef<boolean | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const goal = goals.find((g) => g.id === goalId) ?? null;
  const visible = Boolean(open && goal);
  const activeTask = useMemo(() => {
    if (!goal || !activeTaskId) return null;
    return goal.subGoals.flatMap((subGoal) => subGoal.tasks).find((task) => task.id === activeTaskId) ?? null;
  }, [activeTaskId, goal]);

  // 打开时自动收起左侧栏，关闭时恢复
  useEffect(() => {
    if (visible) {
      if (prevNavRef.current === null) {
        prevNavRef.current = navCollapsed;
        if (!navCollapsed) setNavCollapsed(true);
      }
    } else if (prevNavRef.current !== null) {
      if (!prevNavRef.current) setNavCollapsed(false);
      prevNavRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (visible) {
      setActiveTaskId(null);
    }
  }, [goalId, visible, focusSubGoalId]);

  if (!visible || !goal) return null;

  const fullscreenHref =
    activeTask != null ? taskDetailPath(goal.id, activeTask.id) : goalDetailPath(goal.id);

  return (
    <>
      <button
        type="button"
        aria-label="关闭目标规划"
        onClick={onClose}
        className="fixed inset-0 z-30 bg-transparent"
      />
      <aside
        className="fixed inset-y-0 right-0 z-40 flex w-[60vw] min-w-[640px] flex-col border-l border-[#E5E7EB] bg-white"
        aria-label="目标规划"
      >
        <div className="flex h-12 flex-none items-center gap-4 border-b border-[#E5E7EB] px-4">
          <GoalPlanBreadcrumb
            goalId={goal.id}
            goalTitle={goal.title}
            taskTitle={activeTask?.title.replace(/^任务\d+：/, "")}
            className="min-w-0 flex-1 justify-start text-left"
            disableLinks
            onGoalClick={activeTask ? () => setActiveTaskId(null) : undefined}
            onGoalPlanClick={activeTask ? () => setActiveTaskId(null) : undefined}
          />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
            <Link
              href={fullscreenHref}
              aria-label="全屏查看目标规划"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
            >
              <Maximize2 className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-6">
          {activeTask ? (
            <div className="mx-auto w-full max-w-3xl px-2 py-2">
              <TaskDetailBody goal={goal} task={activeTask} />
            </div>
          ) : (
            <GoalPlanContent
              goal={goal}
              focusSubGoalId={focusSubGoalId}
              onOpenTask={(task: Task) => {
                setActiveTaskId(task.id);
              }}
            />
          )}
        </div>
      </aside>
    </>
  );
}
