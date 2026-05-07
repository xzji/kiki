import { BookOpen, Mail, Newspaper, Ticket } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import type { InboxItem } from "@/types/dora";

const iconMap = {
  task: BookOpen,
  mail: Mail,
  news: Newspaper,
  booking: Ticket,
};

function renderSnippet(snippet: string) {
  return snippet.split(/(\[需要作答\]|\[需要确认\])/g).map((part, index) => {
    if (part === "[需要作答]" || part === "[需要确认]") {
      return <span key={`${part}-${index}`} className="text-[#E5484D]">{part}</span>;
    }
    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

export function InboxCard({ item }: { item: InboxItem }) {
  const Icon = iconMap[item.iconType];

  return (
    <Link href={item.linkTo} className="block rounded-xl border border-[#7D8590] bg-[#F5F6F8] p-4 transition hover:border-[#111] hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2 text-[#111]">
            <Icon className="h-4 w-4" />
            <h3 className="truncate text-sm font-semibold">{item.title}</h3>
          </div>
          <p className="line-clamp-1 text-xs text-[#6B7280]">{renderSnippet(item.snippet)}</p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <span className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#E5484D] px-1 text-[10px] text-white", item.unreadCount === 0 && "bg-[#D0D7DE]")}>{item.unreadCount}</span>
          <span className="text-[11px] text-[#6B7280]">{item.timeLabel}</span>
        </div>
      </div>
    </Link>
  );
}
