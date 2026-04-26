"use client";

import { ReactNode } from "react";

import { useTriggerEngine } from "@/hooks/useTriggerEngine";
import { BottomComposer } from "@/components/layout/BottomComposer";
import { DevPanel } from "@/components/layout/DevPanel";
import { DoraAvatar } from "@/components/layout/DoraAvatar";
import { Sidebar } from "@/components/layout/Sidebar";

export function AppShell({ children }: { children: ReactNode }) {
  useTriggerEngine();

  return (
    <div className="min-h-screen bg-[#F5F6F8] text-[#1F2328]">
      <Sidebar />
      <div className="ml-[240px] min-h-screen px-8 pb-36 pt-6">
        <div className="mb-8 flex justify-end">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#D0D7DE] bg-white text-sm font-medium text-[#111]">U</div>
        </div>
        <div className="mx-auto max-w-5xl">{children}</div>
      </div>
      <div className="fixed bottom-6 left-7 z-20"><DoraAvatar size="sm" /></div>
      <DevPanel />
      <BottomComposer />
    </div>
  );
}
