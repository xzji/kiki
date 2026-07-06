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
        status === "online" && "border-success-border bg-success-bg text-success",
        status === "checking" && "border-line bg-surface-subtle text-ink-strong",
        status === "misconfigured" && "border-danger-border bg-danger-bg text-danger-hover",
        status === "offline" && "border-line bg-white text-ink-soft",
      )}
    >
      {label}
    </span>
  );
}
