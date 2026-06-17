"use client";

import { usePathname } from "next/navigation";

import {
  NAV_SIDEBAR_COLLAPSED_WIDTH,
  NAV_SIDEBAR_EXPANDED_WIDTH,
} from "@/components/layout/Sidebar";
import { useAssistantStore } from "@/stores/assistantStore";
import { useConversationProcessSidebarStore } from "@/stores/conversationProcessSidebarStore";
import { useNavSidebarStore } from "@/stores/navSidebarStore";

export const MAIN_CONTENT_RIGHT_INSET = 416;

/** 主内容区相对视口的左右留白，与 AppShell 侧栏占位一致。 */
export function useMainContentInsets() {
  const pathname = usePathname() ?? "";
  const isConversation = pathname.startsWith("/conversations");
  const navCollapsed = useNavSidebarStore((state) => state.collapsed);
  const assistantHydrated = useAssistantStore((state) => state.hydrated);
  const assistantOpen = useAssistantStore((state) => state.isOpen);
  const processHydrated = useConversationProcessSidebarStore((state) => state.hydrated);
  const processOpen = useConversationProcessSidebarStore((state) => state.isOpen);

  const leftInset = navCollapsed ? NAV_SIDEBAR_COLLAPSED_WIDTH : NAV_SIDEBAR_EXPANDED_WIDTH;
  const rightInset =
    (isConversation ? processHydrated && processOpen : assistantHydrated && assistantOpen)
      ? MAIN_CONTENT_RIGHT_INSET
      : 0;

  return { leftInset, rightInset };
}
