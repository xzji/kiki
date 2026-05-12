"use client";

import { ChevronsRight, Maximize2, MessageCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";

import { GoalPlanBreadcrumb } from "@/components/goal/GoalPlanContent";
import { TaskDetailBody } from "@/components/goal/TaskDetailBody";
import { useAssistantStore } from "@/stores/assistantStore";
import { useGoalStore } from "@/stores/goalStore";
import { useNavSidebarStore } from "@/stores/navSidebarStore";
import { useTaskDrawerStore } from "@/stores/taskDrawerStore";

export function TaskDetailDrawer() {
  const { activeGoalId, activeTaskId, close } = useTaskDrawerStore();
  const goals = useGoalStore((state) => state.goals);
  const assistantOpen = useAssistantStore((state) => state.isOpen);
  const openAssistant = useAssistantStore((state) => state.open);
  const navCollapsed = useNavSidebarStore((state) => state.collapsed);
  const setNavCollapsed = useNavSidebarStore((state) => state.setCollapsed);

  const goal = goals.find((item) => item.id === activeGoalId) ?? null;
  const task =
    goal?.subGoals.flatMap((sg) => sg.tasks).find((t) => t.id === activeTaskId) ?? null;
  const open = Boolean(activeTaskId && goal && task);

  // 打开任务侧栏时自动收起左侧栏，关闭时恢复打开前的状态
  const prevNavCollapsedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (open) {
      if (prevNavCollapsedRef.current === null) {
        prevNavCollapsedRef.current = navCollapsed;
        if (!navCollapsed) setNavCollapsed(true);
      }
    } else if (prevNavCollapsedRef.current !== null) {
      if (!prevNavCollapsedRef.current) setNavCollapsed(false);
      prevNavCollapsedRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open || !goal || !task) return null;

  const rightOffset = assistantOpen ? 400 : 0;

  return (
    <aside
      className="fixed inset-y-0 z-40 flex w-[60vw] min-w-[640px] flex-col border-l border-[#E5E7EB] bg-white shadow-[-2px_0_0_rgba(0,0,0,0.02)] transition-[right] duration-200"
      style={{ right: rightOffset }}
      aria-label="任务详情"
    >
      <div className="flex h-12 flex-none items-center gap-4 border-b border-[#E5E7EB] px-4">
        <GoalPlanBreadcrumb
          goalId={goal.id}
          goalTitle={goal.title}
          taskTitle={task.title.replace(/^任务\d+：/, "")}
          className="min-w-0 flex-1 justify-start text-left"
          disableLinks
        />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="关闭任务侧栏"
            onClick={close}
            className="rounded-md p-1.5 text-[#6B7280] hover:bg-[#F5F6F8]"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
          <Link
            href={`/goals/${goal.id}/tasks/${task.id}`}
            aria-label="展开为全屏"
            onClick={close}
            className="rounded-md p-1.5 text-[#6B7280] hover:bg-[#F5F6F8]"
          >
            <Maximize2 className="h-4 w-4" />
          </Link>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5">
        <TaskDetailBody goal={goal} task={task} />
      </div>

      {!assistantOpen ? (
        <button
          type="button"
          aria-label="打开对话"
          onClick={openAssistant}
          className="absolute bottom-5 right-5 flex h-10 w-10 items-center justify-center rounded-full border border-[#E5E7EB] bg-white text-[#1F2328] hover:border-[#1F2328]"
        >
          <MessageCircle className="h-4 w-4" />
        </button>
      ) : null}
    </aside>
  );
}
