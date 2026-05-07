"use client";

import { ReactNode, useEffect } from "react";
import { usePathname } from "next/navigation";

import { AssistantFab } from "@/components/layout/AssistantFab";
import { AssistantSidebar } from "@/components/layout/AssistantSidebar";
import { DevPanel } from "@/components/layout/DevPanel";
import { Sidebar } from "@/components/layout/Sidebar";
import { UserMenu } from "@/components/layout/UserMenu";
import { useTriggerEngine } from "@/hooks/useTriggerEngine";
import { useAssistantStore } from "@/stores/assistantStore";

export function AppShell({ children }: { children: ReactNode }) {
  useTriggerEngine();
  const pathname = usePathname();
  const isWide = pathname.startsWith("/schedule");
  const contentWidth = isWide ? "max-w-[1600px]" : "max-w-5xl";

  const { isOpen, hydrated, hydrate } = useAssistantStore();
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const assistantOpen = hydrated && isOpen;

  return (
    <div className="min-h-screen bg-[#F5F6F8] text-[#1F2328]">
      <Sidebar />
      <div
        className="ml-[240px] min-h-screen bg-white px-8 pb-24 pt-8 transition-[padding] duration-200"
        style={{ paddingRight: assistantOpen ? 416 : undefined }}
      >
        <div className={`mx-auto w-full ${contentWidth}`}>{children}</div>
      </div>
      <UserMenu />
      <DevPanel />
      <AssistantSidebar />
      <AssistantFab />
    </div>
  );
}
