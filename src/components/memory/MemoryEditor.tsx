"use client";

import { useEffect, useState } from "react";

type MemoryApiResponse = {
  ok: boolean;
  reason?: string;
  source?: "自动提炼" | "用户手动" | "后台晋升";
  memory?: {
    content: string;
    hash: string;
    exists: boolean;
  };
  hash?: string;
};

export function MemoryEditor({
  endpoint,
  title,
  description,
  limitLabel,
}: {
  endpoint: string;
  title: string;
  description: string;
  limitLabel: string;
}) {
  const [content, setContent] = useState("");
  const [hash, setHash] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [source, setSource] = useState<MemoryApiResponse["source"]>("用户手动");

  const load = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const payload = (await response.json()) as MemoryApiResponse;
      if (!response.ok || !payload.ok || !payload.memory) {
        throw new Error(payload.reason || "读取记忆失败");
      }
      setContent(payload.memory.content);
      setHash(payload.memory.hash);
      setSource(payload.source ?? "用户手动");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取记忆失败");
    } finally {
      setLoading(false);
    }
  };

  const save = async (nextContent = content) => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: nextContent, expectedHash: hash }),
      });
      const payload = (await response.json()) as MemoryApiResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.reason || "保存记忆失败");
      }
      setContent(nextContent);
      if (payload.hash) setHash(payload.hash);
      setSource("用户手动");
      setMessage("已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存记忆失败");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    void load();
    // endpoint 变化代表切换了记忆对象，应重新读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <div className="text-[15px] font-medium text-[#111]">{title}</div>
        <div className="mt-1 text-[12px] leading-5 text-[#6B7280]">{description}</div>
      </div>

      <div className="rounded-2xl border border-[#E5E7EB] bg-[#FBFBFC] px-4 py-3 text-[12px] text-[#6B7280]">
        Markdown 是记忆正文的唯一事实来源。自动提炼可能出错，你可以直接编辑或清空。当前上限：{limitLabel}。
      </div>

      <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[#E5E7EB] bg-white px-3 py-1 text-[12px] text-[#4B5563]">
        来源类型：<span className="font-medium text-[#111]">{source}</span>
      </div>

      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        disabled={loading}
        className="min-h-[280px] flex-1 resize-none rounded-2xl border border-[#D0D7DE] bg-white px-4 py-3 font-mono text-[12px] leading-5 text-[#1F2328] outline-none focus:border-[#111] disabled:bg-[#F5F6F8]"
        placeholder={loading ? "正在读取记忆..." : "# Memory\n\n"}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="min-h-5 text-[12px] text-[#6B7280]">{message}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void save("")}
            disabled={saving || loading || !content.trim()}
            className="rounded-md border border-[#FCA5A5] px-3 py-1.5 text-[12px] text-[#B42318] hover:bg-[#FEF2F2] disabled:cursor-not-allowed disabled:opacity-50"
          >
            清空
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={saving || loading}
            className="rounded-md border border-[#D0D7DE] px-3 py-1.5 text-[12px] text-[#1F2328] hover:border-[#111] disabled:cursor-not-allowed disabled:opacity-50"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || loading}
            className="rounded-md bg-[#111] px-3 py-1.5 text-[12px] text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
