"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { useAssistantStore } from "@/stores/assistantStore";

export function AssistantFab() {
  const { isOpen, hydrated, open, hydrate } = useAssistantStore();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    hydrate();
  }, [hydrate]);

  // 避免 SSR 期间看到默认收起态闪烁 + 已展开时不显示
  if (!mounted || !hydrated || isOpen) return null;

  return (
    <button
      type="button"
      aria-label="打开 KiKi 对话"
      onClick={open}
        className="fixed bottom-6 right-6 z-30 hidden h-12 w-12 items-center justify-center rounded-full border border-[#222]/30 bg-white text-[#1F2328] transition hover:border-[#111] hover:bg-[#F5F6F8] md:flex"
    >
      <Sparkles className="h-5 w-5" />
    </button>
  );
}
