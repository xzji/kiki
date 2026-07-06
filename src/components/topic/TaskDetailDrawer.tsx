"use client";

import { ChevronsRight, Maximize2, MessageCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { TopicPlanBreadcrumb } from "@/components/topic/TopicPlanContent";
import { TaskDetailBody } from "@/components/topic/TaskDetailBody";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { appendRouteQuery, topicTaskDetailPath } from "@/lib/routes";
import { resolveTaskPanelLayout } from "@/lib/taskPanelLayout";
import { useAssistantStore } from "@/stores/assistantStore";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useNavSidebarStore } from "@/stores/navSidebarStore";
import { useTaskDrawerStore } from "@/stores/taskDrawerStore";
import { useTaskMonitorStore } from "@/stores/taskMonitorStore";

export function TaskDetailDrawer() {
  const { activeGoalId, activeTaskId, activeInstanceId, close } = useTaskDrawerStore();
  const goals = useGoalStore(selectVisibleGoals);
  const assistantOpen = useAssistantStore((state) => state.isOpen);
  const openAssistant = useAssistantStore((state) => state.open);
  const isMobile = useIsMobileViewport();
  const navCollapsed = useNavSidebarStore((state) => state.collapsed);
  const setNavCollapsed = useNavSidebarStore((state) => state.setCollapsed);
  const taskMonitorOpen = useTaskMonitorStore((state) => state.open);
  const taskMonitorWidth = useTaskMonitorStore((state) => state.width);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );

  const goal = goals.find((item) => item.id === activeGoalId) ?? null;
  const task =
    goal?.subGoals.flatMap((sg) => sg.tasks).find((t) => t.id === activeTaskId) ?? null;
  const open = Boolean(activeTaskId && goal && task);
  const panelLayout = useMemo(
    () =>
      resolveTaskPanelLayout({
        viewportWidth,
        assistantOpen,
        isMobile,
        monitorOpen: taskMonitorOpen,
        detailOpen: open,
        monitorWidth: taskMonitorWidth,
      }),
    [assistantOpen, isMobile, open, taskMonitorOpen, taskMonitorWidth, viewportWidth],
  );

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
    const update = () => {
      if (typeof window === "undefined") return;
      setViewportWidth(window.innerWidth);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open || !goal || !task) return null;

  return (
    <aside
      className="fixed inset-y-0 z-40 flex w-full min-w-0 flex-col border-l border-line bg-white shadow-[-2px_0_0_rgba(0,0,0,0.02)] transition-[right] duration-200 md:w-auto"
      style={{
        right: isMobile ? 0 : panelLayout.detailRightOffset,
        width: isMobile ? undefined : panelLayout.detailWidth,
      }}
      aria-label="任务详情"
    >
      <div className="flex h-12 flex-none items-center gap-4 border-b border-line px-4">
        <TopicPlanBreadcrumb
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
            className="rounded-md p-1.5 text-ink-soft hover:bg-surface"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
          <Link
            href={appendRouteQuery(topicTaskDetailPath(goal.id, task.id), {
              instanceId: activeInstanceId ?? undefined,
            })}
            aria-label="展开为全屏"
            onClick={close}
            className="rounded-md p-1.5 text-ink-soft hover:bg-surface"
          >
            <Maximize2 className="h-4 w-4" />
          </Link>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 md:px-6 md:py-5">
        <TaskDetailBody
          goal={goal}
          task={task}
          initiallyExpandedInstanceId={activeInstanceId}
          onDeleted={close}
        />
      </div>

      {!assistantOpen && !isMobile ? (
        <button
          type="button"
          aria-label="打开对话"
          onClick={openAssistant}
          className="absolute bottom-5 right-5 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-white text-ink hover:border-ink"
        >
          <MessageCircle className="h-4 w-4" />
        </button>
      ) : null}
    </aside>
  );
}
