"use client";

import { ArrowUp, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function BottomComposer() {
  const router = useRouter();
  const [value, setValue] = useState("");

  const submit = () => {
    const next = value.trim();
    if (!next) return;
    router.push(`/goals/new?title=${encodeURIComponent(next)}`);
    setValue("");
  };

  return (
    <div className="fixed bottom-6 left-[276px] right-8 z-20">
      <div className="mx-auto max-w-5xl rounded-xl border border-[#222]/30 bg-white px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3">
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder="输入任何想法，我会帮助你，没有什么大不了的事"
            className="flex-1 bg-transparent text-sm text-[#1F2328] outline-none placeholder:text-[#9197A3]"
          />
          <div className="flex items-center gap-3 text-xs text-[#6B7280]">
            <button type="button" className="rounded-md p-1 hover:bg-[#F5F6F8]" aria-label="新增目标">
              <Plus className="h-4 w-4" />
            </button>
            <span>GPT5.4</span>
            <button
              type="button"
              onClick={submit}
              className="rounded-full border border-[#D0D7DE] p-1.5 text-[#111] transition hover:border-[#111]"
              aria-label="发送"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
