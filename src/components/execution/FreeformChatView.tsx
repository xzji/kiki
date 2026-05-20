"use client";

import { SendHorizonal } from "lucide-react";
import { useEffect, useState } from "react";

import { KikiAvatar } from "@/components/layout/KikiAvatar";
import { formatMessageTime } from "@/lib/date";
import { makeId } from "@/lib/utils";
import type { KikiMessage } from "@/types/kiki";

function replyFor(message: string) {
  if (message.includes("改方案")) return "我会先保留你原本的偏好，再重新拉一版更便宜、换乘更少的方案给你确认。";
  if (message.includes("重写")) return "我会保持礼貌和明确行动项，把邮件重写得更简洁直接。";
  if (message.includes("面试")) return "这段表达可以再前置结论，把你最能体现 AI 产品能力的项目先抛出来。";
  return "收到，我继续沿着你的长期目标推进，并把变化压缩成下一条更容易判断的建议。";
}

export function FreeformChatView({ threadId, seed }: { threadId: string; seed: string }) {
  const [value, setValue] = useState("");
  const [messages, setMessages] = useState<KikiMessage[]>([]);

  useEffect(() => {
    setMessages([{ id: `${threadId}-seed`, role: "kiki", content: seed, timestamp: "04-26 11:00" }]);
  }, [seed, threadId]);

  const send = () => {
    const content = value.trim();
    if (!content) return;
    const now = formatMessageTime(new Date());
    setMessages((prev) => [
      ...prev,
      { id: makeId("msg"), role: "user", content, timestamp: now },
      { id: makeId("msg"), role: "kiki", content: replyFor(content), timestamp: now },
    ]);
    setValue("");
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-5">
        <div className="space-y-4">
          {messages.map((message) => (
            <div key={message.id} className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
              {message.role === "kiki" ? <KikiAvatar size="sm" /> : null}
              <div className={`max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "kiki" ? "border border-[#E5E7EB] bg-[#F8FAFC] text-[#374151]" : "bg-[#111] text-white"}`}>{message.content}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex gap-2 rounded-xl border border-[#E5E7EB] bg-[#F5F6F8] p-3">
        <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="继续和 KiKi 对话" className="flex-1 bg-transparent text-sm outline-none placeholder:text-[#9AA4B2]" onKeyDown={(event) => {
          if (event.key === "Enter" && value.trim()) {
            send();
          }
        }} />
        <button className="rounded-lg bg-[#111] p-2 text-white hover:bg-[#333]" onClick={() => {
          send();
        }}><SendHorizonal className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
