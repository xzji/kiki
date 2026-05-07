"use client";

import { LogOut, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useNavSidebarStore } from "@/stores/navSidebarStore";

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navCollapsed = useNavSidebarStore((state) => state.collapsed);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  // 收起态下，左侧栏宽 56px，头像 28px，居中偏移 = (56-28)/2 = 14px
  const leftOffset = navCollapsed ? 14 : 28;

  return (
    <div ref={menuRef} className="fixed bottom-6 z-20" style={{ left: leftOffset }}>
      {open ? (
        <div className="absolute bottom-14 left-0 w-40 rounded-xl border border-[#222]/40 bg-white p-3 shadow-sm">
          <div className="mb-3 flex items-center gap-3 border-b border-[#EEF1F4] pb-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#D0D7DE] bg-[#F3EEFF] text-sm font-medium text-[#111]">
              J
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[#111]">Josh</div>
              <div className="truncate text-[11px] text-[#6B7280]">shadowjxz@gmail.com</div>
            </div>
          </div>
          <div className="space-y-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-[#374151] hover:bg-[#F5F6F8]"
              onClick={() => setOpen(false)}
            >
              <Settings className="h-4 w-4" />
              <span>设置</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-[#374151] hover:bg-[#F5F6F8]"
              onClick={() => setOpen(false)}
            >
              <LogOut className="h-4 w-4" />
              <span>登出</span>
            </button>
          </div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-[#534f69]/25 bg-[#E9E6FF] text-xs text-[#5F5AA2]"
        aria-label="打开用户菜单"
      >
        J
      </button>
    </div>
  );
}
