import { BookOpen, ChevronDown, Mail, Newspaper, Ticket } from "lucide-react";
import { useMemo, useState } from "react";

import { KikiAvatar } from "@/components/layout/KikiAvatar";
import { TaskMessageCard } from "@/components/conversation/TaskMessageCard";
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

export function InboxCard({ item }: { item: InboxItem }) {
  const Icon = iconMap[item.iconType];
  const goals = useGoalStore(selectVisibleGoals);
  const markRead = useInboxStore((state) => state.markRead);
  const [expanded, setExpanded] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
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

  return (
    <>
      <div className="rounded-xl border border-[#E5E7EB] bg-white p-4 transition hover:border-[#111]">
        <button
          type="button"
          onClick={() => {
            const nextExpanded = !expanded;
            setExpanded(nextExpanded);
            if (nextExpanded && unread) markRead(item.id);
          }}
          className="block w-full text-left"
        >
          <div className="flex items-center gap-2 text-[#111]">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Icon className="h-4 w-4" />
              <h3 className="truncate text-sm font-semibold">{item.title}</h3>
            </div>
            <span className="shrink-0 text-[11px] text-[#6B7280]">{item.timeLabel}</span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-[#8C9198] transition-transform",
                expanded && "rotate-180",
              )}
            />
          </div>

          {!expanded ? (
            <div className="mt-2 flex items-start gap-2">
              {unread ? (
                <span className="mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-[#E5484D]" />
              ) : null}
              <p className="line-clamp-1 text-xs text-[#6B7280]">{renderSnippet(item.snippet, unread)}</p>
            </div>
          ) : null}
        </button>

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
