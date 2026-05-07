"use client";

import { ChevronDown, ChevronRight, Inbox, CalendarDays, History, Target } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";

const historyLinks = [{ id: "history-1", title: "西红柿炒鸡蛋怎么做", href: "/history" }];

export function Sidebar() {
  const pathname = usePathname();
  const goals = useGoalStore((state) => state.goals);
  const inboxItems = useInboxStore((state) => state.items);
  const [goalsOpen, setGoalsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);

  const inboxUnread = useMemo(() => inboxItems.reduce((sum, item) => sum + item.unreadCount, 0), [inboxItems]);
  const goalUnread = useMemo(() => {
    return goals.reduce<Record<string, number>>((acc, goal) => {
      acc[goal.id] = inboxItems.filter((item) => item.goalId === goal.id).reduce((sum, item) => sum + item.unreadCount, 0);
      return acc;
    }, {});
  }, [goals, inboxItems]);

  return (
    <aside className="fixed inset-y-0 left-0 w-[240px] border-r border-[#D8DDE4] bg-[#F5F6F8] px-5 py-6">
      <div className="mb-8 text-xl font-semibold text-[#1F2328]">首页</div>
      <nav className="space-y-6 text-sm text-[#475467]">
        <div className="space-y-1">
          <NavLink href="/" active={pathname === "/"} icon={<Inbox className="h-4 w-4" />} label="收件箱" badge={inboxUnread} />
          <NavLink href="/schedule" active={pathname.startsWith("/schedule")} icon={<CalendarDays className="h-4 w-4" />} label="日程" />
        </div>
        <div>
          <button className="mb-2 flex w-full items-center justify-between px-3 text-xs font-medium text-[#6B7280]" onClick={() => setGoalsOpen((prev) => !prev)}>
            <span className="flex items-center gap-2"><Target className="h-3.5 w-3.5" />进行中</span>
            {goalsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {goalsOpen ? (
            <div className="space-y-1">
              {goals.map((goal) => (
                <NavLink key={goal.id} href={`/goals/${goal.id}`} active={pathname.startsWith(`/goals/${goal.id}`)} label={goal.title} badge={goalUnread[goal.id]} small />
              ))}
            </div>
          ) : null}
        </div>
        <div>
          <button className="mb-2 flex w-full items-center justify-between px-3 text-xs font-medium text-[#6B7280]" onClick={() => setHistoryOpen((prev) => !prev)}>
            <span className="flex items-center gap-2"><History className="h-3.5 w-3.5" />历史</span>
            {historyOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {historyOpen ? (
            <div className="space-y-1">
              {historyLinks.map((item) => (
                <NavLink key={item.id} href={item.href} active={pathname === item.href} label={item.title} small />
              ))}
            </div>
          ) : null}
        </div>
      </nav>
    </aside>
  );
}

function NavLink({ href, active, label, badge, icon, small = false }: { href: string; active: boolean; label: string; badge?: number; icon?: React.ReactNode; small?: boolean }) {
  return (
    <Link href={href} className={cn("flex items-center justify-between rounded-lg px-3 py-2 transition hover:bg-white/80", active && "bg-white text-[#111] shadow-sm", small && "text-[13px]")}>
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {badge ? <span className="ml-3 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#E5484D] px-1 text-[10px] text-white">{badge}</span> : null}
    </Link>
  );
}
