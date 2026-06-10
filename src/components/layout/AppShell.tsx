"use client";

import { ReactNode, Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { AssistantFab } from "@/components/layout/AssistantFab";
import { AssistantSidebar } from "@/components/layout/AssistantSidebar";
import {
  ConversationProcessFab,
  ConversationProcessSidebar,
} from "@/components/conversation/ConversationProcessSidebar";
import { DevPanel } from "@/components/layout/DevPanel";
import {
  NAV_SIDEBAR_COLLAPSED_WIDTH,
  NAV_SIDEBAR_EXPANDED_WIDTH,
  Sidebar,
} from "@/components/layout/Sidebar";
import { UserMenu } from "@/components/layout/UserMenu";
import { TaskMonitorDrawer } from "@/components/task/TaskMonitorDrawer";
import { TaskDetailDrawer } from "@/components/topic/TaskDetailDrawer";
import { useTriggerEngine } from "@/hooks/useTriggerEngine";
import { useAssistantStore } from "@/stores/assistantStore";
import { useConversationProcessSidebarStore } from "@/stores/conversationProcessSidebarStore";
import { useNavSidebarStore } from "@/stores/navSidebarStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import { useTaskDrawerStore } from "@/stores/taskDrawerStore";
import { useTaskMonitorStore } from "@/stores/taskMonitorStore";

function DrawerTaskIdSyncer() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openTaskDrawer = useTaskDrawerStore((state) => state.open);
  const drawerTaskId = searchParams.get("drawerTaskId");
  useEffect(() => {
    const match = pathname.match(/^\/(?:topics|goals)\/([^/]+)$/);
    if (!match || !drawerTaskId) return;
    openTaskDrawer(decodeURIComponent(match[1]), drawerTaskId);
  }, [drawerTaskId, openTaskDrawer, pathname]);
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  useTriggerEngine();
  const pathname = usePathname();
  const isAuthPage = pathname === "/login" || pathname === "/register";
  const isWide = pathname.startsWith("/schedule");
  const isConversation = pathname.startsWith("/conversations");
  const isFullscreenResult =
    /^\/conversations\/[^/]+\/results\/[^/]+$/.test(pathname) ||
    /^\/inbox\/[^/]+\/result$/.test(pathname);
  const useImmersiveShell = isConversation || isFullscreenResult;
  const contentWidth = useImmersiveShell ? "" : isWide ? "max-w-[1600px]" : "max-w-5xl";

  const { isOpen, hydrated, hydrate } = useAssistantStore();
  useEffect(() => {
    hydrate();
  }, [hydrate]);
  const {
    isOpen: processSidebarOpen,
    hydrated: processSidebarHydrated,
    hydrate: hydrateProcessSidebar,
  } = useConversationProcessSidebarStore();
  useEffect(() => {
    hydrateProcessSidebar();
  }, [hydrateProcessSidebar]);
  const hydrateRuntimeEnvs = useRuntimeEnvStore((state) => state.hydrate);
  useEffect(() => {
    hydrateRuntimeEnvs();
  }, [hydrateRuntimeEnvs]);

  const assistantOpen = !isConversation && hydrated && isOpen;
  const conversationProcessOpen = isConversation && processSidebarHydrated && processSidebarOpen;
  const taskDrawerOpen = useTaskDrawerStore((state) => Boolean(state.activeTaskId));
  const closeTaskDrawer = useTaskDrawerStore((state) => state.close);
  const closeTaskMonitor = useTaskMonitorStore((state) => state.closeMonitor);
  useEffect(() => {
    closeTaskDrawer();
    closeTaskMonitor();
  }, [pathname, closeTaskDrawer, closeTaskMonitor]);

  const navCollapsed = useNavSidebarStore((state) => state.collapsed);
  const leftPadding = navCollapsed ? NAV_SIDEBAR_COLLAPSED_WIDTH : NAV_SIDEBAR_EXPANDED_WIDTH;
  // 任务侧栏改为覆盖式，不再挤压主内容；只有 AssistantSidebar 挤压
  const rightPadding = assistantOpen || conversationProcessOpen ? 416 : 0;
  const mainClassName = useImmersiveShell
    ? "h-screen overflow-hidden bg-white px-0 pb-0 pt-0"
    : "h-screen overflow-y-auto overscroll-contain bg-white px-8 pb-24 pt-8";
  const contentClassName = useImmersiveShell
    ? "h-full w-full"
    : `mx-auto w-full ${contentWidth}`;

  if (isAuthPage) {
    return <>{children}</>;
  }

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
      {process.env.NODE_ENV === "development" ? <DevPanel /> : null}
      <Suspense fallback={null}>
        <DrawerTaskIdSyncer />
      </Suspense>
      <TaskMonitorDrawer />
      <TaskDetailDrawer />
      {isConversation ? <ConversationProcessSidebar /> : <AssistantSidebar />}
      {!taskDrawerOpen ? (isConversation ? <ConversationProcessFab /> : <AssistantFab />) : null}
    </div>
  );
}
