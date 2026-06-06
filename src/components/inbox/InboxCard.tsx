import {
  Archive,
  BookOpen,
  ChevronDown,
  Clock,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  MoreHorizontal,
  Newspaper,
  Star,
  Ticket,
} from "lucide-react";
import { useMemo, useState } from "react";

import { KikiAvatar } from "@/components/layout/KikiAvatar";
import { TaskMessageCard } from "@/components/conversation/TaskMessageCard";
import { formatMessageTime } from "@/lib/date";
import { resolveInboxTaskContext } from "@/lib/inboxItem";
import { buildAwaitingDisplayModel } from "@/lib/taskInstance/awaitingDisplayModel";
import { cn } from "@/lib/utils";
import { selectVisibleGoals, useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import type { InboxItem } from "@/types/kiki";
import { TaskResultDrawer } from "@/components/task/TaskResultDrawer";

const iconMap = {
  task: BookOpen,
  mail: Mail,
  news: Newspaper,
  booking: Ticket,
};

function renderSnippet(snippet: string, unread: boolean) {
  return snippet.split(/(\[需要作答\]|\[需要确认\])/g).map((part, index) => {
    if (part === "[需要作答]" || part === "[需要确认]") {
      return (
        <span
          key={`${part}-${index}`}
          className={unread ? "text-[#E5484D]" : "text-[#6B7280]"}
        >
          {part}
        </span>
      );
    }
    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

export function InboxCard({ item, variant = "active" }: { item: InboxItem; variant?: "active" | "snoozed" }) {
  const Icon = iconMap[item.iconType];
  const goals = useGoalStore(selectVisibleGoals);
  const markRead = useInboxStore((state) => state.markRead);
  const markUnread = useInboxStore((state) => state.markUnread);
  const archiveItem = useInboxStore((state) => state.archiveItem);
  const snoozeItem = useInboxStore((state) => state.snoozeItem);
  const unsnoozeItem = useInboxStore((state) => state.unsnoozeItem);
  const toggleFavorite = useInboxStore((state) => state.toggleFavorite);
  const [expanded, setExpanded] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const taskContext = useMemo(() => resolveInboxTaskContext(item, goals), [goals, item]);
  const awaitingDisplay = useMemo(
    () => taskContext ? buildAwaitingDisplayModel(taskContext.task, taskContext.instance, "inbox") : null,
    [taskContext],
  );
  const expandedMessage =
    awaitingDisplay?.active
      ? awaitingDisplay.notice
      : taskContext?.instance.notification?.userMessage ?? taskContext?.instance.intro ?? item.snippet;
  const unread = item.unreadCount > 0;
  const timeLabel = formatMessageTime(item.createdAt);

  const closeMenu = () => setMenuOpen(false);
  const runAction = (fn: () => void) => {
    fn();
    closeMenu();
  };

  return (
    <>
      <div className="rounded-xl border border-[#E5E7EB] bg-white p-4 transition hover:border-[#111]">
        <div className="flex items-center gap-2 text-[#111]">
          <button
            type="button"
            onClick={() => {
              const nextExpanded = !expanded;
              setExpanded(nextExpanded);
              if (nextExpanded && unread) markRead(item.id);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.favorite ? <Star className="h-3.5 w-3.5 shrink-0 fill-[#F5A623] text-[#F5A623]" /> : null}
            <h3 className="truncate text-sm font-semibold">{item.title}</h3>
          </button>
          <span className="shrink-0 text-[11px] text-[#6B7280]">{timeLabel}</span>
          <div className="relative shrink-0">
            <button
              type="button"
              aria-label="更多操作"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((prev) => !prev);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[#8C9198] transition hover:bg-[#F3F4F6] hover:text-[#111]"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menuOpen ? (
              <>
                <div className="fixed inset-0 z-10" onClick={closeMenu} />
                <div className="absolute right-0 top-7 z-20 w-36 overflow-hidden rounded-lg border border-[#E5E7EB] bg-white py-1 shadow-lg">
                  {variant === "snoozed" ? (
                    <MenuItem icon={InboxIcon} label="移回收件箱" onClick={() => runAction(() => unsnoozeItem(item.id))} />
                  ) : (
                    <MenuItem icon={Clock} label="稍后处理" onClick={() => runAction(() => snoozeItem(item.id))} />
                  )}
                  <MenuItem icon={Archive} label="归档" onClick={() => runAction(() => archiveItem(item.id))} />
                  <MenuItem
                    icon={Star}
                    label={item.favorite ? "取消收藏" : "收藏"}
                    onClick={() => runAction(() => toggleFavorite(item.id))}
                  />
                  <MenuItem
                    icon={unread ? MailOpen : Mail}
                    label={unread ? "标记已读" : "标记未读"}
                    onClick={() => runAction(() => (unread ? markRead(item.id) : markUnread(item.id)))}
                  />
                </div>
              </>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={expanded ? "收起" : "展开"}
            onClick={() => {
              const nextExpanded = !expanded;
              setExpanded(nextExpanded);
              if (nextExpanded && unread) markRead(item.id);
            }}
            className="shrink-0"
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 text-[#8C9198] transition-transform",
                expanded && "rotate-180",
              )}
            />
          </button>
        </div>

        {!expanded ? (
          <div className="mt-2 flex items-start gap-2">
            {unread ? (
              <span className="mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-[#E5484D]" />
            ) : null}
            <p className="line-clamp-1 text-xs text-[#6B7280]">{renderSnippet(item.snippet, unread)}</p>
          </div>
        ) : null}

        {expanded ? (
          <div className="mt-4 border-t border-[#E5E7EB] pt-4">
            {expandedMessage ? (
              <div className="flex items-start gap-3">
                <KikiAvatar size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-[13px] font-medium text-[#1F2328]">KiKi</div>
                  <div className="whitespace-pre-wrap text-sm leading-6 text-[#374151]">
                    {expandedMessage}
                  </div>
                </div>
              </div>
            ) : null}

            {taskContext ? (
              <TaskMessageCard
                task={taskContext.task}
                instance={taskContext.instance}
                onOpen={() => setResultOpen(true)}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <TaskResultDrawer
        open={resultOpen}
        goal={taskContext?.goal ?? null}
        task={taskContext?.task ?? null}
        instance={taskContext?.instance ?? null}
        fullscreenHref={`/inbox/${item.id}/result`}
        onClose={() => setResultOpen(false)}
      />
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Archive;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[#374151] transition hover:bg-[#F5F6F8]"
    >
      <Icon className="h-3.5 w-3.5 text-[#6B7280]" />
      <span>{label}</span>
    </button>
  );
}
