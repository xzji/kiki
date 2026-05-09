"use client";

import {
  CalendarDays,
  Ellipsis,
  Inbox,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { deleteClaudeSession } from "@/lib/api/claude";
import { cn } from "@/lib/utils";
import { useConversationStore, getConversationUnreadCount } from "@/stores/conversationStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useNavSidebarStore } from "@/stores/navSidebarStore";
import { useRuntimeEnvStore } from "@/stores/runtimeEnvStore";
import type { Conversation } from "@/types/kiki";

export const NAV_SIDEBAR_EXPANDED_WIDTH = 260;
export const NAV_SIDEBAR_COLLAPSED_WIDTH = 56;

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const conversations = useConversationStore((state) => state.conversations);
  const createConversation = useConversationStore((state) => state.createConversation);
  const markConversationUnread = useConversationStore((state) => state.markConversationUnread);
  const deleteConversation = useConversationStore((state) => state.deleteConversation);
  const renameConversation = useConversationStore((state) => state.renameConversation);
  const toggleConversationPinned = useConversationStore((state) => state.toggleConversationPinned);
  const runtimeEnvironments = useRuntimeEnvStore((state) => state.environments);
  const inboxItems = useInboxStore((state) => state.items);
  const collapsed = useNavSidebarStore((state) => state.collapsed);
  const setCollapsed = useNavSidebarStore((state) => state.setCollapsed);

  const inboxUnread = useMemo(
    () => inboxItems.reduce((sum, item) => sum + item.unreadCount, 0),
    [inboxItems],
  );

  const sortedConversations = useMemo(
    () =>
      [...conversations].sort(
        (a, b) =>
          Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
          +new Date(b.updatedAt) - +new Date(a.updatedAt),
      ),
    [conversations],
  );

  const totalUnread = useMemo(
    () => sortedConversations.reduce((sum, c) => sum + getConversationUnreadCount(c), 0),
    [sortedConversations],
  );

  const onCreateConversation = () => {
    const next = createConversation();
    router.push(`/conversations/${next.id}`);
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
          className="group mb-6 flex h-8 w-8 items-center justify-center rounded-md text-[#111] hover:bg-white"
        >
          <span className="group-hover:hidden">
            <ProductLogo compact />
          </span>
          <PanelLeftOpen className="hidden h-4 w-4 text-[#6B7280] group-hover:block" />
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
            label="会话"
            icon={<MessageCircle className="h-4 w-4" />}
            badge={totalUnread}
            onClick={() => setCollapsed(false)}
            active={pathname.startsWith("/conversations")}
          />
        </nav>
      </aside>
    );
  }

  return (
    <aside
      className="fixed inset-y-0 left-0 z-10 flex flex-col border-r border-[#D8DDE4] bg-[#F5F6F8] px-4 py-5"
      style={{ width: NAV_SIDEBAR_EXPANDED_WIDTH }}
    >
      <div className="mb-4 flex items-center justify-between px-3">
        <ProductLogo />
        <button
          type="button"
          aria-label="收起侧边栏"
          onClick={() => setCollapsed(true)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-white"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <nav className="space-y-1 text-sm text-[#475467]">
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
      </nav>

      <div className="mt-6 flex items-center justify-between px-2 text-xs font-medium text-[#6B7280]">
        <span className="flex items-center gap-2">
          <MessageCircle className="h-3.5 w-3.5" />
          会话
        </span>
        <button
          type="button"
          aria-label="新建会话"
          onClick={onCreateConversation}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[#6B7280] hover:bg-white hover:text-[#1F2328]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 flex-1 overflow-y-auto overscroll-contain pr-1">
        {sortedConversations.length === 0 ? (
          <div className="mt-3 px-3 py-2 text-[12px] text-[#9AA0A6]">暂无会话</div>
        ) : (
          <ul className="space-y-1">
            {sortedConversations.map((conv) => {
              return (
                <ConversationListItem
                  key={conv.id}
                  conversation={conv}
                  active={pathname.startsWith(`/conversations/${conv.id}`)}
                  onTogglePinned={() => toggleConversationPinned(conv.id)}
                  onRename={(title) => renameConversation(conv.id, title)}
                  onMarkUnread={() => markConversationUnread(conv.id)}
                  onDelete={async () => {
                    if (conv.claudeSessionId) {
                      const runtimeEnv = runtimeEnvironments.find((item) => item.id === conv.runtimeEnvId);
                      try {
                        await deleteClaudeSession({
                          sessionId: conv.claudeSessionId,
                          workingDirectory: runtimeEnv?.workingDirectory,
                        });
                      } catch (error) {
                        console.warn("删除 Claude session 失败", error);
                        window.alert(error instanceof Error ? error.message : "删除 Claude session 失败");
                        return;
                      }
                    }
                    deleteConversation(conv.id);
                    if (pathname.startsWith(`/conversations/${conv.id}`)) {
                      router.push("/conversations");
                    }
                  }}
                />
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ProductLogo({ compact = false }: { compact?: boolean }) {
  const size = compact ? 26 : 30;

  return (
    <div
      aria-label="KiKi logo"
      className="flex items-center justify-center text-[#111]"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 96 96"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect x="6" y="6" width="84" height="84" rx="14" stroke="currentColor" strokeWidth="6" />
        <path d="M32 25V74" stroke="currentColor" strokeWidth="10" strokeLinecap="square" />
        <path d="M32 74L64 24" stroke="currentColor" strokeWidth="10" strokeLinecap="square" />
        <path d="M50 50L70 74" stroke="currentColor" strokeWidth="10" strokeLinecap="square" />
      </svg>
    </div>
  );
}

function ConversationListItem({
  conversation,
  active,
  onTogglePinned,
  onRename,
  onMarkUnread,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  onTogglePinned: () => void;
  onRename: (title: string) => void;
  onMarkUnread: () => void;
  onDelete: () => void | Promise<void>;
}) {
  const unread = getConversationUnreadCount(conversation);
  const latest = conversation.messages[conversation.messages.length - 1];
  const [menuOpen, setMenuOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(conversation.title);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftTitle(conversation.title);
  }, [conversation.title]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  useEffect(() => {
    if (!isRenaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [isRenaming]);

  const finishRenaming = () => {
    const nextTitle = draftTitle.trim();
    setIsRenaming(false);
    if (nextTitle && nextTitle !== conversation.title) {
      onRename(nextTitle);
      return;
    }
    setDraftTitle(conversation.title);
  };

  const cancelRenaming = () => {
    setDraftTitle(conversation.title);
    setIsRenaming(false);
  };

  return (
    <li>
      <div
        onContextMenu={(event) => {
          event.preventDefault();
          if (isRenaming) return;
          setMenuOpen(true);
        }}
        className={cn(
          "group flex items-start gap-2 rounded-lg px-3 py-2 transition hover:bg-white/80",
          active && "bg-white shadow-sm",
        )}
      >
        {isRenaming ? (
          <div className="flex items-center justify-between gap-2">
            <input
              ref={renameInputRef}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={finishRenaming}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  finishRenaming();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRenaming();
                }
              }}
              className="w-full rounded-md border border-[#D0D7DE] bg-white px-2 py-1 text-[13px] text-[#1F2328] outline-none ring-0 placeholder:text-[#9AA0A6] focus:border-[#111]"
              maxLength={80}
            />
          </div>
        ) : (
          <Link href={`/conversations/${conversation.id}`} className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] text-[#1F2328]">
                {conversation.title}
              </span>
              <div className="flex items-center gap-1">
                {conversation.pinned ? (
                  <span className="text-[10px] text-[#8C9198]">置顶</span>
                ) : null}
                {unread > 0 ? (
                  <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#E5484D] px-1 text-[10px] text-white">
                    {unread}
                  </span>
                ) : null}
              </div>
            </div>
            {latest ? (
              <span className="block truncate text-[11px] text-[#8C9198]">
                {latest.content}
              </span>
            ) : (
              <span className="block truncate text-[11px] text-[#8C9198]">
                暂无消息
              </span>
            )}
          </Link>
        )}
        <div ref={menuRef} className="relative pt-0.5">
          <button
            type="button"
            aria-label="更多"
            onClick={() => setMenuOpen((prev) => !prev)}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-md text-[#8C9198] hover:bg-white hover:text-[#1F2328]",
              menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            <Ellipsis className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-7 z-20 w-32 overflow-hidden rounded-lg border border-[#E5E7EB] bg-white py-1 text-[12px] text-[#1F2328] shadow-sm">
              <button
                type="button"
                onClick={() => {
                  onTogglePinned();
                  setMenuOpen(false);
                }}
                className="block w-full px-3 py-2 text-left hover:bg-[#F8F9FB]"
              >
                {conversation.pinned ? "取消置顶" : "置顶"}
              </button>
              <button
                type="button"
                onClick={() => {
                  onMarkUnread();
                  setMenuOpen(false);
                }}
                className="block w-full px-3 py-2 text-left hover:bg-[#F8F9FB]"
              >
                标记为未读
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftTitle(conversation.title);
                  setIsRenaming(true);
                  setMenuOpen(false);
                }}
                className="block w-full px-3 py-2 text-left hover:bg-[#F8F9FB]"
              >
                重命名
              </button>
              <button
                type="button"
                onClick={async () => {
                  await onDelete();
                  setMenuOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-[#D1242F] hover:bg-[#F8F9FB]"
              >
                删除
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function NavLink({
  href,
  active,
  label,
  badge,
  icon,
}: {
  href: string;
  active: boolean;
  label: string;
  badge?: number;
  icon?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center justify-between rounded-lg px-3 py-2 transition hover:bg-white/80",
        active && "bg-white text-[#111] shadow-sm",
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
