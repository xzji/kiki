"use client";

import { ReactNode } from "react";

import { BottomComposer } from "@/components/layout/BottomComposer";
import { DevPanel } from "@/components/layout/DevPanel";
import { Sidebar } from "@/components/layout/Sidebar";
import { UserMenu } from "@/components/layout/UserMenu";
import { useTriggerEngine } from "@/hooks/useTriggerEngine";

export function AppShell({ children }: { children: ReactNode }) {
  useTriggerEngine();

  return (
    <div className="min-h-screen bg-[#F5F6F8] text-[#1F2328]">
      <Sidebar />
      <div className="ml-[240px] min-h-screen px-8 pb-36 pt-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </div>
      <UserMenu />
      <DevPanel />
      <BottomComposer />
    </div>
  );
}
