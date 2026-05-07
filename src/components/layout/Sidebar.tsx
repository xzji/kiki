"use client";

import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  History,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Target,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useNavSidebarStore } from "@/stores/navSidebarStore";

export const NAV_SIDEBAR_EXPANDED_WIDTH = 240;
export const NAV_SIDEBAR_COLLAPSED_WIDTH = 56;

export function Sidebar() {
  const pathname = usePathname();
  const goals = useGoalStore((state) => state.goals);
  const inboxItems = useInboxStore((state) => state.items);
  const collapsed = useNavSidebarStore((state) => state.collapsed);
  const setCollapsed = useNavSidebarStore((state) => state.setCollapsed);

  const [goalsOpen, setGoalsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);

  const activeGoals = useMemo(
    () => goals.filter((goal) => (goal.kind ?? "collab") !== "chat_history"),
    [goals],
  );
  const historyGoals = useMemo(
    () => goals.filter((goal) => goal.kind === "chat_history"),
    [goals],
  );

  const inboxUnread = useMemo(() => inboxItems.reduce((sum, item) => sum + item.unreadCount, 0), [inboxItems]);
  const goalUnread = useMemo(() => {
    return goals.reduce<Record<string, number>>((acc, goal) => {
      acc[goal.id] = inboxItems.filter((item) => item.goalId === goal.id).reduce((sum, item) => sum + item.unreadCount, 0);
      return acc;
    }, {});
  }, [goals, inboxItems]);

  const totalGoalUnread = useMemo(
    () => activeGoals.reduce((sum, goal) => sum + (goalUnread[goal.id] ?? 0), 0),
    [activeGoals, goalUnread],
  );

  const onGoalsGroupClick = () => {
    if (collapsed) {
      setCollapsed(false);
      setGoalsOpen(true);
    } else {
      setGoalsOpen((prev) => !prev);
    }
  };

  const onHistoryGroupClick = () => {
    if (collapsed) {
      setCollapsed(false);
      setHistoryOpen(true);
    } else {
      setHistoryOpen((prev) => !prev);
    }
  };

  if (collapsed) {
    return (
      <aside
        className="fixed inset-y-0 left-0 z-10 flex flex-col items-center border-r border-[#D8DDE4] bg-[#F5F6F8] py-4"
        style={{ width: NAV_SIDEBAR_COLLAPSED_WIDTH }}
      >
        <button
          type="button"
          aria-label="展开侧边栏"
          onClick={() => setCollapsed(false)}
          className="mb-6 flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] hover:bg-white"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <nav className="flex flex-col items-center gap-2 text-[#475467]">
          <IconLink
            href="/"
            active={pathname === "/"}
            label="收件箱"
            icon={<Inbox className="h-4 w-4" />}
            badge={inboxUnread}
          />
          <IconLink
            href="/schedule"
            active={pathname.startsWith("/schedule")}
            label="日程"
            icon={<CalendarDays className="h-4 w-4" />}
          />
          <IconButton
            label="进行中"
            icon={<Target className="h-4 w-4" />}
            badge={totalGoalUnread}
            onClick={onGoalsGroupClick}
            active={pathname.startsWith("/goals") && activeGoals.some((g) => pathname.startsWith(`/goals/${g.id}`))}
          />
          <IconButton
            label="历史"
            icon={<History className="h-4 w-4" />}
            onClick={onHistoryGroupClick}
            active={historyGoals.some((g) => pathname.startsWith(`/goals/${g.id}`))}
          />
        </nav>
      </aside>
    );
  }

  return (
    <aside
      className="fixed inset-y-0 left-0 z-10 border-r border-[#D8DDE4] bg-[#F5F6F8] px-5 py-6"
      style={{ width: NAV_SIDEBAR_EXPANDED_WIDTH }}
    >
      <div className="mb-6 flex items-center justify-end">
        <button
          type="button"
          aria-label="收起侧边栏"
          onClick={() => setCollapsed(true)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-white"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <nav className="space-y-6 text-sm text-[#475467]">
        <div className="space-y-1">
          <NavLink
            href="/"
            active={pathname === "/"}
            icon={<Inbox className="h-4 w-4" />}
            label="收件箱"
            badge={inboxUnread}
          />
          <NavLink
            href="/schedule"
            active={pathname.startsWith("/schedule")}
            icon={<CalendarDays className="h-4 w-4" />}
            label="日程"
          />
        </div>
        <div>
          <button
            className="mb-2 flex w-full items-center justify-between px-3 text-xs font-medium text-[#6B7280]"
            onClick={() => setGoalsOpen((prev) => !prev)}
          >
            <span className="flex items-center gap-2">
              <Target className="h-3.5 w-3.5" />
              进行中
            </span>
            {goalsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {goalsOpen ? (
            <div className="space-y-1">
              {activeGoals.map((goal) => (
                <NavLink
                  key={goal.id}
                  href={`/goals/${goal.id}`}
                  active={pathname.startsWith(`/goals/${goal.id}`)}
                  label={goal.title}
                  badge={goalUnread[goal.id]}
                  small
                />
              ))}
            </div>
          ) : null}
        </div>
        <div>
          <button
            className="mb-2 flex w-full items-center justify-between px-3 text-xs font-medium text-[#6B7280]"
            onClick={() => setHistoryOpen((prev) => !prev)}
          >
            <span className="flex items-center gap-2">
              <History className="h-3.5 w-3.5" />
              历史
            </span>
            {historyOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {historyOpen ? (
            <div className="space-y-1">
              {historyGoals.map((goal) => (
                <NavLink
                  key={goal.id}
                  href={`/goals/${goal.id}`}
                  active={pathname.startsWith(`/goals/${goal.id}`)}
                  label={goal.title}
                  small
                />
              ))}
              {historyGoals.length === 0 ? (
                <div className="px-3 py-2 text-[12px] text-[#9AA0A6]">暂无历史对话</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </nav>
    </aside>
  );
}

function NavLink({
  href,
  active,
  label,
  badge,
  icon,
  small = false,
}: {
  href: string;
  active: boolean;
  label: string;
  badge?: number;
  icon?: React.ReactNode;
  small?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center justify-between rounded-lg px-3 py-2 transition hover:bg-white/80",
        active && "bg-white text-[#111] shadow-sm",
        small && "text-[13px]",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {badge ? (
        <span className="ml-3 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#E5484D] px-1 text-[10px] text-white">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

function IconLink({
  href,
  active,
  label,
  icon,
  badge,
}: {
  href: string;
  active: boolean;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className={cn(
        "relative flex h-9 w-9 items-center justify-center rounded-lg transition hover:bg-white",
        active && "bg-white text-[#111]",
      )}
    >
      {icon}
      {badge ? (
        <span className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[#E5484D] px-1 text-[9px] text-white">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

function IconButton({
  label,
  icon,
  onClick,
  badge,
  active,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  badge?: number;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "relative flex h-9 w-9 items-center justify-center rounded-lg transition hover:bg-white",
        active && "bg-white text-[#111]",
      )}
    >
      {icon}
      {badge ? (
        <span className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[#E5484D] px-1 text-[9px] text-white">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
