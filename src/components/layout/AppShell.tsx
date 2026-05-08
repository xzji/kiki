"use client";

import { ReactNode, useEffect } from "react";
import { usePathname } from "next/navigation";

import { AssistantFab } from "@/components/layout/AssistantFab";
import { AssistantSidebar } from "@/components/layout/AssistantSidebar";
import { DevPanel } from "@/components/layout/DevPanel";
import {
  NAV_SIDEBAR_COLLAPSED_WIDTH,
  NAV_SIDEBAR_EXPANDED_WIDTH,
  Sidebar,
} from "@/components/layout/Sidebar";
import { UserMenu } from "@/components/layout/UserMenu";
import { TaskDetailDrawer } from "@/components/goal/TaskDetailDrawer";
import { useTriggerEngine } from "@/hooks/useTriggerEngine";
import { useAssistantStore } from "@/stores/assistantStore";
import { useNavSidebarStore } from "@/stores/navSidebarStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import { useTaskDrawerStore } from "@/stores/taskDrawerStore";

export function AppShell({ children }: { children: ReactNode }) {
  useTriggerEngine();
  const pathname = usePathname();
  const isWide = pathname.startsWith("/schedule");
  const isConversation = pathname.startsWith("/conversations");
  const isFullscreenResult =
    /^\/conversations\/[^/]+\/results\/[^/]+$/.test(pathname) ||
    /^\/inbox\/[^/]+\/result$/.test(pathname);
  const useImmersiveShell = isConversation || isFullscreenResult;
  const contentWidth = isWide || useImmersiveShell ? "max-w-[1600px]" : "max-w-5xl";

  const { isOpen, hydrated, hydrate } = useAssistantStore();
  useEffect(() => {
    hydrate();
  }, [hydrate]);
  const hydrateRuntimeEnvs = useRuntimeEnvStore((state) => state.hydrate);
  useEffect(() => {
    hydrateRuntimeEnvs();
  }, [hydrateRuntimeEnvs]);

  const assistantOpen = hydrated && isOpen;
  const taskDrawerOpen = useTaskDrawerStore((state) => Boolean(state.activeTaskId));
  const closeTaskDrawer = useTaskDrawerStore((state) => state.close);
  useEffect(() => {
    closeTaskDrawer();
  }, [pathname, closeTaskDrawer]);

  const navCollapsed = useNavSidebarStore((state) => state.collapsed);
  const leftPadding = navCollapsed ? NAV_SIDEBAR_COLLAPSED_WIDTH : NAV_SIDEBAR_EXPANDED_WIDTH;
  // 任务侧栏改为覆盖式，不再挤压主内容；只有 AssistantSidebar 挤压
  const rightPadding = assistantOpen ? 416 : 0;
  const mainClassName = useImmersiveShell
    ? "h-screen overflow-hidden bg-white px-0 pb-0 pt-0 transition-[padding,margin] duration-200"
    : "h-screen overflow-y-auto overscroll-contain bg-white px-8 pb-24 pt-8 transition-[padding,margin] duration-200";
  const contentClassName = useImmersiveShell
    ? `mx-auto h-full w-full ${contentWidth}`
    : `mx-auto w-full ${contentWidth}`;

  return (
    <div className="h-screen overflow-hidden bg-[#F5F6F8] text-[#1F2328]">
      <Sidebar />
      <main
        className={mainClassName}
        style={{ marginLeft: leftPadding, paddingRight: rightPadding || undefined }}
      >
        <div className={contentClassName}>{children}</div>
      </main>
      <UserMenu />
      <DevPanel />
      <TaskDetailDrawer />
      <AssistantSidebar />
      {!taskDrawerOpen ? <AssistantFab /> : null}
    </div>
  );
}
