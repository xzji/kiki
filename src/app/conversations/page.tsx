"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { ensureConversationWorkspaceApi } from "@/lib/api/conversationWorkspace";
import { useConversationStore } from "@/stores/conversationStore";
import { startInstantConversationEntry } from "@/components/layout/instantConversationEntry";

/**
 * 会话列表页：简单列表，点击进入 /conversations/[id]。
 * 左侧边栏也可以直达，列表页提供一个纯展示入口。
 */
export default function ConversationListPage() {
  const router = useRouter();
  const conversations = useConversationStore((state) => state.conversations);
  const createConversation = useConversationStore((state) => state.createConversation);
  const setConversationWorkspace = useConversationStore((state) => state.setConversationWorkspace);
  const setConversationBackgroundIssue = useConversationStore((state) => state.setConversationBackgroundIssue);
  const sorted = useMemo(
    () =>
      [...conversations].sort(
        (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt),
      ),
    [conversations],
  );
  const onCreateConversation = () => {
    startInstantConversationEntry({
      createConversation,
      ensureConversationWorkspace: ensureConversationWorkspaceApi,
      navigate: (href) => router.push(href),
      setConversationWorkspace,
      setConversationBackgroundIssue,
    });
  };

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4 md:px-6 md:pb-8 md:pt-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h1 className="text-[18px] font-semibold text-[#1F2328]">会话</h1>
          <button
            type="button"
            onClick={onCreateConversation}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#111] px-3 text-[13px] font-medium text-white"
          >
            <Plus className="h-3.5 w-3.5" />
            新建
          </button>
        </div>
        {sorted.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#E5E7EB] bg-[#F8F9FB] p-10 text-center text-[13px] text-[#8C9198]">
            暂无会话，点击“新建”开始。
          </div>
        ) : (
          <ul className="space-y-2">
            {sorted.map((conv) => {
              const latest = conv.lastMessage ?? conv.messages[conv.messages.length - 1];
              return (
                <li key={conv.id}>
                  <Link
                    href={`/conversations/${conv.id}`}
                    className="block rounded-xl border border-[#E5E7EB] bg-white px-4 py-3 transition hover:border-[#111]"
                  >
                    <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                      <div className="truncate text-[14px] font-medium text-[#1F2328]">
                        {conv.title}
                      </div>
                      <div className="shrink-0 text-[11px] text-[#8C9198]">
                        {new Date(conv.updatedAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="mt-1 truncate text-[12px] text-[#8C9198]">
                      {latest ? latest.content : "暂无消息"}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
