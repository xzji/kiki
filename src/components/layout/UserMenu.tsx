"use client";

import { LogOut, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { SettingsModal } from "@/components/settings/SettingsModal";
import { OPEN_SETTINGS_EVENT, type SettingsTab } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useNavSidebarStore } from "@/stores/navSidebarStore";

type AuthUser = {
  id: string;
  email: string;
  displayName: string;
};

export function UserMenu({ placement = "desktop" }: { placement?: "desktop" | "mobileNav" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
  const [user, setUser] = useState<AuthUser | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const navCollapsed = useNavSidebarStore((state) => state.collapsed);

  useEffect(() => {
    void fetch("/api/auth/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.ok && data.user) setUser(data.user as AuthUser);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    const onOpenSettings = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: SettingsTab }>;
      setSettingsTab(customEvent.detail?.tab || "account");
      setSettingsOpen(true);
    };

    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettings as EventListener);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettings as EventListener);
  }, []);

  const displayName = user?.displayName || "用户";
  const email = user?.email || "";
  const initial = displayName.trim().charAt(0).toUpperCase() || "U";
  const leftOffset = navCollapsed ? 14 : 28;
  const isMobileNav = placement === "mobileNav";

  async function handleLogout() {
    setOpen(false);
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <div
      ref={menuRef}
      className={cn(
        isMobileNav ? "relative md:hidden" : "fixed bottom-6 z-20 hidden md:block",
      )}
      style={isMobileNav ? undefined : { left: leftOffset }}
    >
      {open ? (
        <div
          className={cn(
            "absolute bottom-14 w-52 rounded-xl border border-[#222]/40 bg-white p-3 shadow-sm",
            isMobileNav ? "right-0" : "left-0 md:w-40",
          )}
        >
          <div className="mb-3 flex items-center gap-3 border-b border-[#EEF1F4] pb-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#D0D7DE] bg-[#F3EEFF] text-sm font-medium text-[#111]">
              {initial}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[#111]">{displayName}</div>
              <div className="truncate text-[11px] text-[#6B7280]">{email}</div>
            </div>
          </div>
          <div className="space-y-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-[#374151] hover:bg-[#F5F6F8]"
              onClick={() => {
                setOpen(false);
                setSettingsTab("account");
                setSettingsOpen(true);
              }}
            >
              <Settings className="h-4 w-4" />
              <span>设置</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-[#374151] hover:bg-[#F5F6F8]"
              onClick={() => void handleLogout()}
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
        className={cn(
          isMobileNav
            ? "relative flex min-h-11 w-full flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium text-[#475467] active:bg-[#F5F6F8]"
            : "flex h-7 w-7 items-center justify-center rounded-full border border-[#534f69]/25 bg-[#E9E6FF] text-xs text-[#5F5AA2]",
        )}
        aria-label="打开用户菜单"
      >
        {isMobileNav ? (
          <>
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-[#D0D7DE] bg-[#E9E6FF] text-[9px] leading-none text-[#5F5AA2]">
              {initial}
            </span>
            <span>我的</span>
          </>
        ) : (
          initial
        )}
      </button>
      <SettingsModal
        open={settingsOpen}
        user={user}
        onUserChange={setUser}
        defaultTab={settingsTab}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
