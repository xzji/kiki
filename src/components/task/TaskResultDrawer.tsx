"use client";

import { ChevronsRight, Maximize2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";

import { buildInstanceCardTitle, ExecutionResultBody } from "@/components/task/ExecutionResultBody";
import { useNavSidebarStore } from "@/stores/navSidebarStore";
import type { Goal, Task, TaskInstance } from "@/types/kiki";

export function TaskResultDrawer({
  open,
  goal,
  task,
  instance,
  fullscreenHref,
  onClose,
}: {
  open: boolean;
  goal: Goal | null;
  task: Task | null;
  instance: TaskInstance | null;
  fullscreenHref: string;
  onClose: () => void;
}) {
  const navCollapsed = useNavSidebarStore((state) => state.collapsed);
  const setNavCollapsed = useNavSidebarStore((state) => state.setCollapsed);
  const prevNavRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (open) {
      if (prevNavRef.current === null) {
        prevNavRef.current = navCollapsed;
        if (!navCollapsed) setNavCollapsed(true);
      }
    } else if (prevNavRef.current !== null) {
      if (!prevNavRef.current) setNavCollapsed(false);
      prevNavRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || !goal || !task || !instance) return null;

  return (
    <>
      <button
        type="button"
        aria-label="关闭任务结果"
        onClick={onClose}
        className="fixed inset-0 z-30 bg-transparent"
      />
        <aside className="fixed inset-y-0 right-0 z-40 flex w-full min-w-0 flex-col border-l border-[#E5E7EB] bg-white md:w-[60vw] md:min-w-[640px]">
        <div className="flex h-12 flex-none items-center gap-4 border-b border-[#E5E7EB] px-4">
          <div className="min-w-0 flex-1 text-[13px] font-medium text-[#1F2328]">
            {buildInstanceCardTitle(task, instance)}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-label="关闭任务结果"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
            <Link
              href={fullscreenHref}
              aria-label="全屏查看任务结果"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8]"
            >
              <Maximize2 className="h-4 w-4" />
            </Link>
          </div>
        </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 md:px-6 md:py-5">
          <div className="mx-auto w-full max-w-3xl">
            <ExecutionResultBody goal={goal} task={task} instance={instance} mode="result" />
          </div>
        </div>
      </aside>
    </>
  );
}
