"use client";

import Link from "next/link";

import { KikiAvatar } from "@/components/layout/KikiAvatar";

export default function NewTopicPage({
  searchParams,
}: {
  searchParams?: { title?: string };
}) {
  const title = searchParams?.title?.trim() ?? "";

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-6 flex items-start gap-3">
          <KikiAvatar size="sm" />
          <div className="px-4 py-3 text-sm leading-6 text-ink-strong">
            {title ? `请回到首页，通过对话创建“${title}”。` : "请回到首页，通过对话创建主题。"}
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Link href="/" className="rounded-lg border border-line-strong px-4 py-2 text-sm text-[#111] hover:bg-surface">返回首页</Link>
        </div>
      </div>
    </div>
  );
}
