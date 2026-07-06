"use client";

import { CalendarDays, Inbox, MessageCircle } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { getConversationUnreadCount, useConversationStore } from "@/stores/conversationStore";
import { useInboxStore } from "@/stores/inboxStore";
import { UserMenu } from "./UserMenu";

export function MobileBottomNav() {
  const pathname = usePathname() ?? "";
  const inboxItems = useInboxStore((state) => state.items);
  const conversations = useConversationStore((state) => state.conversations);

  const inboxUnread = useMemo(
    () => inboxItems.reduce((sum, item) => sum + item.unreadCount, 0),
    [inboxItems],
  );
  const conversationUnread = useMemo(
    () => conversations.reduce((sum, item) => sum + getConversationUnreadCount(item), 0),
    [conversations],
  );

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line-muted bg-white/95 px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur md:hidden"
      aria-label="移动端主导航"
    >
      <div className="grid grid-cols-4 gap-1">
        <MobileNavLink
          href="/"
          active={pathname === "/"}
          label="收件箱"
          icon={<Inbox className="h-4 w-4" />}
          badge={inboxUnread}
        />
        <MobileNavLink
          href="/conversations"
          active={pathname.startsWith("/conversations")}
          label="会话"
          icon={<MessageCircle className="h-4 w-4" />}
          badge={conversationUnread}
        />
        <MobileNavLink
          href="/schedule"
          active={pathname.startsWith("/schedule")}
          label="日程"
          icon={<CalendarDays className="h-4 w-4" />}
        />
        <UserMenu placement="mobileNav" />
      </div>
    </nav>
  );
}

function MobileNavLink({
  href,
  active,
  label,
  icon,
  badge = 0,
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
      className={cn(
        "relative flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium",
        active ? "bg-surface text-ink" : "text-ink-strong active:bg-surface",
      )}
    >
      {icon}
      <span>{label}</span>
      {badge > 0 ? (
        <span className="absolute right-4 top-1 rounded-full bg-badge px-1.5 text-[10px] font-semibold leading-4 text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </Link>
  );
}
