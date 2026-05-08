"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import type { SettingsTab } from "@/lib/settings";

import { RuntimeEnvironmentPanel } from "./RuntimeEnvironmentPanel";

const ACCOUNT_PROFILE = {
  initial: "J",
  name: "Josh",
  email: "shadowjxz@gmail.com",
};

export function SettingsModal({
  open,
  defaultTab = "account",
  onClose,
}: {
  open: boolean;
  defaultTab?: SettingsTab;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab);

  useEffect(() => {
    if (!open) return;
    setActiveTab(defaultTab);
  }, [defaultTab, open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onClose}>
      <div
        className="relative flex h-[72vh] max-h-[760px] w-[920px] max-w-[92vw] overflow-hidden rounded-2xl border border-[#E5E7EB] bg-white"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭设置"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F5F6F8] hover:text-[#111]"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex w-[220px] flex-none flex-col border-r border-[#E5E7EB] bg-[#FBFBFC] px-4 py-4">
          <div className="mb-5 flex items-center px-2">
            <div className="text-[15px] font-medium text-[#111]">设置</div>
          </div>
          <div className="space-y-1">
            <SettingsNavItem
              active={activeTab === "account"}
              label="账号"
              onClick={() => setActiveTab("account")}
            />
            <SettingsNavItem
              active={activeTab === "runtime"}
              label="运行环境"
              onClick={() => setActiveTab("runtime")}
            />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 flex-none items-center border-b border-[#E5E7EB] px-6">
            <div className="text-[15px] font-medium text-[#111]">
              {activeTab === "account" ? "账号" : "运行环境"}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-6">
            {activeTab === "account" ? <AccountPanel /> : <RuntimeEnvironmentPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AccountPanel() {
  return (
    <div className="max-w-[560px] space-y-6">
      <div className="flex items-center gap-4 rounded-2xl border border-[#E5E7EB] bg-white px-5 py-5">
        <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[#D0D7DE] bg-[#E9E6FF] text-lg font-medium text-[#5F5AA2]">
          {ACCOUNT_PROFILE.initial}
        </div>
        <div className="min-w-0">
          <div className="text-[16px] font-medium text-[#111]">{ACCOUNT_PROFILE.name}</div>
          <div className="mt-1 text-[13px] text-[#6B7280]">KiKi Agent 账户</div>
        </div>
      </div>
      <InfoField label="昵称" value={ACCOUNT_PROFILE.name} />
      <InfoField label="绑定邮箱" value={ACCOUNT_PROFILE.email} />
    </div>
  );
}

function SettingsNavItem({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center rounded-xl px-3 py-2 text-left text-[13px] text-[#4B5563] hover:bg-white",
        active && "bg-white font-medium text-[#111]",
      )}
    >
      {label}
    </button>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-white px-5 py-4">
      <div className="text-[12px] text-[#6B7280]">{label}</div>
      <div className="mt-1 break-all text-[14px] text-[#111]">{value}</div>
    </div>
  );
}
