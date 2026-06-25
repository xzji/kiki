"use client";

import { ChevronsRight, Maximize2 } from "lucide-react";
import Link from "next/link";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { TopicPlanBreadcrumb, TopicPlanContent } from "@/components/topic/TopicPlanContent";
import { NAV_SIDEBAR_EXPANDED_WIDTH } from "@/components/layout/Sidebar";
import { TaskDetailBody } from "@/components/topic/TaskDetailBody";
import { fetchRuntimeStateSnapshot } from "@/lib/api/runtime-daemon";
import { topicDetailPath, topicTaskDetailPath } from "@/lib/routes";
import type { Task } from "@/types/kiki";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useNavSidebarStore } from "@/stores/navSidebarStore";

const GOAL_PLAN_DRAWER_MIN_WIDTH = 640;
const GOAL_PLAN_CONTENT_MAX_WIDTH = 920;
const TASK_DETAIL_CONTENT_MAX_WIDTH = 768;
const GOAL_PLAN_DRAWER_HORIZONTAL_PADDING = 48;
const TASK_DETAIL_DRAWER_EXTRA_PADDING = 16;

function getGoalPlanDrawerContentMaxWidth(isTaskDetailOpen: boolean) {
  return isTaskDetailOpen
    ? TASK_DETAIL_CONTENT_MAX_WIDTH + GOAL_PLAN_DRAWER_HORIZONTAL_PADDING + TASK_DETAIL_DRAWER_EXTRA_PADDING
    : GOAL_PLAN_CONTENT_MAX_WIDTH + GOAL_PLAN_DRAWER_HORIZONTAL_PADDING;
}

function getGoalPlanDrawerBounds(isTaskDetailOpen: boolean) {
  if (typeof window === "undefined") return false;

  const viewportMaxWidth = window.innerWidth >= 720 ? window.innerWidth - 24 : window.innerWidth;
  const minWidth = Math.min(GOAL_PLAN_DRAWER_MIN_WIDTH, viewportMaxWidth);
  const maxWidth = Math.max(
    minWidth,
    Math.min(getGoalPlanDrawerContentMaxWidth(isTaskDetailOpen), viewportMaxWidth),
  );

  return { minWidth, maxWidth };
}

function getManualGoalPlanDrawerBounds() {
  if (typeof window === "undefined") return false;

  const viewportMaxWidth = window.innerWidth >= 720 ? window.innerWidth - 24 : window.innerWidth;
  const minWidth = Math.min(GOAL_PLAN_DRAWER_MIN_WIDTH, viewportMaxWidth);

  return { minWidth, maxWidth: viewportMaxWidth };
}

function clampGoalPlanDrawerWidth(width: number, isTaskDetailOpen: boolean) {
  const bounds = getGoalPlanDrawerBounds(isTaskDetailOpen);
  if (!bounds) return width;
  return Math.min(Math.max(width, bounds.minWidth), bounds.maxWidth);
}

function clampManualGoalPlanDrawerWidth(width: number) {
  const bounds = getManualGoalPlanDrawerBounds();
  if (!bounds) return width;
  return Math.min(Math.max(width, bounds.minWidth), bounds.maxWidth);
}

function getDefaultGoalPlanDrawerWidth(isTaskDetailOpen: boolean) {
  const bounds = getGoalPlanDrawerBounds(isTaskDetailOpen);
  return bounds ? bounds.maxWidth : getGoalPlanDrawerContentMaxWidth(isTaskDetailOpen);
}

function shouldCollapseNavForGoalPlanDrawer(drawerWidth: number) {
  if (typeof window === "undefined") return false;

  return window.innerWidth - NAV_SIDEBAR_EXPANDED_WIDTH < drawerWidth;
}

/**
 * 主题规划 Drawer：从右侧覆盖中间区域。
 * - 内容与全屏主题规划页保持一致
 * - 点击任务后，在 Drawer 内展示同源的任务详情内容
 * - 右上角关闭 / 全屏跳转至 /topics/[topicId]
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
  const goals = useGoalStore(selectVisibleGoals);
  const applyGoalsProjection = useGoalStore((state) => state.applyGoalsProjection);
  const setNavCollapsed = useNavSidebarStore((state) => state.setCollapsed);
  const prevNavRef = useRef<boolean | null>(null);
  const drawerWidthRef = useRef(getDefaultGoalPlanDrawerWidth(false));
  const manualDrawerWidthRef = useRef(false);
  const isTaskDetailOpenRef = useRef(false);
  const [drawerWidth, setDrawerWidth] = useState(() => getDefaultGoalPlanDrawerWidth(false));
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [missingGoalRefresh, setMissingGoalRefresh] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const [refreshAttempt, setRefreshAttempt] = useState(0);

  const goal = goals.find((g) => g.id === goalId) ?? null;
  const visible = Boolean(open && goalId);
  const activeTask = useMemo(() => {
    if (!goal || !activeTaskId) return null;
    return goal.subGoals.flatMap((subGoal) => subGoal.tasks).find((task) => task.id === activeTaskId) ?? null;
  }, [activeTaskId, goal]);
  const isTaskDetailOpen = activeTask != null;

  useEffect(() => {
    drawerWidthRef.current = drawerWidth;
  }, [drawerWidth]);

  useEffect(() => {
    isTaskDetailOpenRef.current = isTaskDetailOpen;
  }, [isTaskDetailOpen]);

  useEffect(() => {
    if (!visible) {
      manualDrawerWidthRef.current = false;
      return;
    }

    manualDrawerWidthRef.current = false;
    setDrawerWidth(getDefaultGoalPlanDrawerWidth(false));
  }, [goalId, visible]);

  useEffect(() => {
    if (!visible) return;
    setDrawerWidth((currentWidth) =>
      manualDrawerWidthRef.current
        ? clampManualGoalPlanDrawerWidth(currentWidth)
        : getDefaultGoalPlanDrawerWidth(isTaskDetailOpen),
    );
  }, [isTaskDetailOpen, visible]);

  // 只在左栏展开后空间不足以容纳规划 Drawer 时，临时收起左侧栏。
  useEffect(() => {
    if (!visible) {
      if (prevNavRef.current !== null) {
        if (!prevNavRef.current) setNavCollapsed(false);
        prevNavRef.current = null;
      }
      return;
    }

    const syncNavCollapsed = () => {
      const shouldCollapse = shouldCollapseNavForGoalPlanDrawer(drawerWidthRef.current);
      if (shouldCollapse) {
        if (prevNavRef.current === null && !useNavSidebarStore.getState().collapsed) {
          prevNavRef.current = false;
          setNavCollapsed(true);
        }
        return;
      }

      if (prevNavRef.current !== null) {
        if (!prevNavRef.current) setNavCollapsed(false);
        prevNavRef.current = null;
      }
    };

    syncNavCollapsed();
    const onResize = () => {
      setDrawerWidth((currentWidth) =>
        manualDrawerWidthRef.current
          ? clampManualGoalPlanDrawerWidth(currentWidth)
          : clampGoalPlanDrawerWidth(currentWidth, isTaskDetailOpenRef.current),
      );
      syncNavCollapsed();
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (prevNavRef.current !== null) {
        if (!prevNavRef.current) setNavCollapsed(false);
        prevNavRef.current = null;
      }
    };
  }, [setNavCollapsed, visible]);

  useEffect(() => {
    if (!visible) return;

    const shouldCollapse = shouldCollapseNavForGoalPlanDrawer(drawerWidth);
    if (shouldCollapse) {
      if (prevNavRef.current === null && !useNavSidebarStore.getState().collapsed) {
        prevNavRef.current = false;
        setNavCollapsed(true);
      }
      return;
    }

    if (prevNavRef.current !== null) {
      if (!prevNavRef.current) setNavCollapsed(false);
      prevNavRef.current = null;
    }
  }, [drawerWidth, setNavCollapsed, visible]);

  useEffect(() => {
    if (visible) {
      setActiveTaskId(null);
    }
  }, [goalId, visible, focusSubGoalId]);

  useEffect(() => {
    if (!visible || goal || !goalId) {
      if (goal) setMissingGoalRefresh({ loading: false, error: null });
      return;
    }

    let cancelled = false;
    setMissingGoalRefresh({ loading: true, error: null });
    fetchRuntimeStateSnapshot()
      .then((snapshot) => {
        if (cancelled) return;
        applyGoalsProjection(snapshot.goals, snapshot.meta?.revisions?.goals);
        setMissingGoalRefresh({ loading: false, error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setMissingGoalRefresh({
          loading: false,
          error: error instanceof Error ? error.message : "目标规划加载失败",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [applyGoalsProjection, goal, goalId, refreshAttempt, visible]);

  if (!visible) return null;

  const fullscreenHref =
    goal && activeTask != null ? topicTaskDetailPath(goal.id, activeTask.id) : goal ? topicDetailPath(goal.id) : null;

  const handleResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    manualDrawerWidthRef.current = true;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = window.innerWidth - moveEvent.clientX;
      setDrawerWidth(clampManualGoalPlanDrawerWidth(nextWidth));
    };
    const onPointerUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  return (
    <>
      <button
        type="button"
        aria-label="关闭主题规划"
        onClick={onClose}
        className="fixed inset-0 z-30 bg-transparent"
      />
      <aside
        className="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-[#E5E7EB] bg-white"
        style={{ width: drawerWidth }}
        aria-label="主题规划"
      >
        <div
          role="separator"
          aria-label="调整主题规划侧栏宽度"
          aria-orientation="vertical"
          onPointerDown={handleResizePointerDown}
          className="group absolute inset-y-0 left-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize touch-none"
        >
          <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-[#8C9198]" />
        </div>
        <div className="flex h-12 flex-none items-center gap-4 border-b border-[#E5E7EB] px-4">
          {goal ? (
            <TopicPlanBreadcrumb
              goalId={goal.id}
              goalTitle={goal.title}
              taskTitle={activeTask?.title.replace(/^任务\d+：/, "")}
              className="min-w-0 flex-1 justify-start text-left"
              disableLinks
              onGoalClick={activeTask ? () => setActiveTaskId(null) : undefined}
              onGoalPlanClick={activeTask ? () => setActiveTaskId(null) : undefined}
            />
          ) : (
            <div className="min-w-0 flex-1 truncate text-sm font-medium text-[#1F2328]">主题规划</div>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
            {fullscreenHref ? (
              <Link
                href={fullscreenHref}
                aria-label="全屏查看主题规划"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
              >
                <Maximize2 className="h-4 w-4" />
              </Link>
            ) : null}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-6">
          {!goal ? (
            <div className="mx-auto flex min-h-[320px] w-full max-w-2xl flex-col items-center justify-center rounded-2xl border border-dashed border-[#D0D7DE] bg-[#F8F9FB] px-8 text-center">
              <div className="text-[14px] font-semibold text-[#1F2328]">
                {missingGoalRefresh.loading ? "正在加载目标规划..." : "暂时找不到这个目标规划"}
              </div>
              <div className="mt-2 text-[12px] leading-5 text-[#6B7280]">
                {missingGoalRefresh.error
                  ? missingGoalRefresh.error
                  : "会话已经绑定目标，但本地目标投影尚未就绪。KiKi 正在重新同步运行时快照。"}
              </div>
              {!missingGoalRefresh.loading ? (
                <button
                  type="button"
                  onClick={() => setRefreshAttempt((attempt) => attempt + 1)}
                  className="mt-4 rounded-md border border-[#D0D7DE] bg-white px-3 py-1.5 text-[12px] font-medium text-[#1F2328] hover:border-[#111]"
                >
                  重新加载
                </button>
              ) : null}
            </div>
          ) : activeTask ? (
            <div className="mx-auto w-full max-w-3xl px-2 py-2">
              <TaskDetailBody goal={goal} task={activeTask} onDeleted={() => setActiveTaskId(null)} />
            </div>
          ) : (
            <TopicPlanContent
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
