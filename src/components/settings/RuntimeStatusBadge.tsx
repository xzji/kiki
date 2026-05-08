"use client";

import { cn } from "@/lib/utils";
import type { RuntimeHealth } from "@/types/runtime";

export function RuntimeStatusBadge({ health }: { health?: RuntimeHealth }) {
  const status = health?.status || "offline";
  const label =
    status === "online"
      ? "在线"
      : status === "checking"
        ? "检测中"
        : status === "misconfigured"
          ? "配置异常"
          : "离线";

  return (
    <span
      className={cn(
        "rounded-full border px-2 py-1 text-[11px]",
        status === "online" && "border-[#D1FADF] bg-[#ECFDF3] text-[#067647]",
        status === "checking" && "border-[#E5E7EB] bg-[#F8FAFC] text-[#475467]",
        status === "misconfigured" && "border-[#FECACA] bg-[#FEF2F2] text-[#B42318]",
        status === "offline" && "border-[#E5E7EB] bg-white text-[#6B7280]",
      )}
    >
      {label}
    </span>
  );
}
