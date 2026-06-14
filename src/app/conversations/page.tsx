"use client";

import Link from "next/link";
import { useMemo } from "react";

import { useConversationStore } from "@/stores/conversationStore";

/**
 * 会话列表页：简单列表，点击进入 /conversations/[id]。
 * 左侧边栏也可以直达，列表页提供一个纯展示入口。
 */
export default function ConversationListPage() {
  const conversations = useConversationStore((state) => state.conversations);
  const sorted = useMemo(
    () =>
      [...conversations].sort(
        (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt),
      ),
    [conversations],
  );

  return (
    <div className="mx-auto max-w-3xl py-2">
      <h1 className="mb-5 text-[18px] font-semibold text-[#1F2328]">会话</h1>
      {sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#E5E7EB] bg-[#F8F9FB] p-10 text-center text-[13px] text-[#8C9198]">
          暂无会话，在左侧点击 + 创建一个。
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
                  <div className="flex items-center justify-between">
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
  );
}
